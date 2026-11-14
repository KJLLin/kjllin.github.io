#!/usr/bin/env python3
"""
静态预渲染（B 阶段）

生成：
  discuss/view/<id>/index.html   —— 文章详情，正文写进 HTML
  docs/<slug>/index.html         —— 文档各章节，正文写进 HTML
  sitemap.xml / robots.txt

用法：
  python3 scripts/prerender.py            # 文章 + 文档 + sitemap
  python3 scripts/prerender.py posts      # 只生成文章
  python3 scripts/prerender.py docs       # 只生成文档
  python3 scripts/prerender.py meta       # 只生成 sitemap/robots

依赖：
  pip3 install playwright && python3 -m playwright install chromium

设计说明：
  1. 用无头浏览器访问现有页面，抓取渲染后的 DOM 作为快照 —— 这样模板只有一份，
     预渲染结果与客户端渲染结果天然一致，不会出现两套排版。
  2. 快照注入 <script id="__post"> ，前端命中后直接复用，不再重复请求正文。
  3. 文章 URL 从 ?id= 迁到 /discuss/view/<id>/，旧链接由前端 302 到新路径。
"""

import html
import json
import os
import re
import shutil
import sys
import threading
import urllib.request
from datetime import datetime, timezone
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASE = "https://kjllin.dpdns.org"
PORT = 8811
LOCAL = f"http://127.0.0.1:{PORT}"


# ---------------------------------------------------------------- 基础工具

def read(p):
    return (ROOT / p).read_text(encoding="utf-8")


def write(p, s):
    path = ROOT / p
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(s, encoding="utf-8")


def esc(s):
    return html.escape(str(s or ""), quote=True)


def json_script(obj):
    """内嵌 JSON，避免 </script> 提前闭合"""
    raw = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    return raw.replace("</", "<\\/")


def plain_text(md, limit=160):
    """从 Markdown 里抽纯文本做 description"""
    s = str(md or "")
    s = re.sub(r"```[\s\S]*?```", " ", s)
    s = re.sub(r"```[\s\S]*$", " ", s)          # 未闭合的代码块
    s = re.sub(r"!\[[^\]]*\]\([^)]*\)", " ", s)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)
    s = re.sub(r"<[^>]+>", " ", s)
    s = re.sub(r"^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+", "", s, flags=re.M)
    s = re.sub(r"[*_`~|]", "", s)
    s = re.sub(r"\s+", " ", s).strip()
    s = re.sub(r"^\d{1,2}[.、]\s*", "", s)   # 去掉开头的「3.」这类序号
    if len(s) > limit:
        s = s[:limit].rstrip() + "…"
    return s


def count_words(md):
    s = str(md or "")
    cjk = len(re.findall(r"[\u4e00-\u9fa5]", s))
    words = len(re.findall(r"[A-Za-z0-9]+", re.sub(r"[\u4e00-\u9fa5]", " ", s)))
    return cjk + words


def iso_date(v):
    if not v:
        return ""
    s = str(v).replace(" ", "T")
    m = re.match(r"(\d{4}-\d{2}-\d{2})", s)
    return m.group(1) if m else ""


def iso_full(v):
    if not v:
        return ""
    s = str(v).strip().replace(" ", "T")
    if not re.search(r"(Z|[+-]\d{2}:?\d{2})$", s):
        s += "+00:00"
    return s


def find_config():
    src = read("common.js")
    url = re.search(r"const SUPABASE_URL = '([^']+)'", src).group(1)
    key = re.search(r"const SUPABASE_KEY = '([^']+)'", src).group(1)
    return url, key


def fetch_posts():
    url, key = find_config()
    endpoint = (f"{url}/rest/v1/posts"
                f"?select=id,title,content,user_id,nick,created_at,updated_at,"
                f"likes_count,visibility&visibility=eq.public&order=created_at.desc")
    req = urllib.request.Request(endpoint, headers={
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    })
    with urllib.request.urlopen(req, timeout=60) as r:
        data = json.loads(r.read().decode() or "[]")
    return [p for p in data if str(p.get("visibility") or "public") == "public"]


# ---------------------------------------------------------------- 本地静态服务

class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = lambda *a, **k: QuietHandler(*a, directory=str(ROOT), **k)  # noqa: E731
    srv = ThreadingHTTPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


# ---------------------------------------------------------------- 文章页

POST_TPL = "discuss/view/index.html"

HEAD_EXTRA = """
  <!-- SEO / 社交卡片（构建时生成） -->
  <meta property="og:type" content="{og_type}">
  <meta property="og:site_name" content="KJLLin">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{desc}">
  <meta property="og:url" content="{url}">
  <meta property="og:image" content="{BASE}/og-cover.png">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta property="og:locale" content="zh_CN">
{article_meta}  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="{title}">
  <meta name="twitter:description" content="{desc}">
  <meta name="twitter:image" content="{BASE}/og-cover.png">
  <script type="application/ld+json">{ld}</script>
"""


def build_post_page(tpl, post, inner):
    pid = post["id"]
    title = (post.get("title") or "无标题").strip()
    desc = plain_text(post.get("content"), 150) or f"{title} · KJLLin"
    author = (post.get("nick") or "匿名").strip()
    uid = post.get("user_id")
    url = f"{BASE}/discuss/view/{pid}/"
    published = iso_full(post.get("created_at"))
    modified = iso_full(post.get("updated_at") or post.get("created_at"))

    article_meta = ""
    if published:
        article_meta += f'  <meta property="article:published_time" content="{esc(published)}">\n'
    if modified:
        article_meta += f'  <meta property="article:modified_time" content="{esc(modified)}">\n'
    if uid:
        article_meta += f'  <meta property="article:author" content="{esc(BASE + "/u/?id=" + uid)}">\n'

    blog = {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        "headline": title,
        "description": desc,
        "url": url,
        "mainEntityOfPage": {"@type": "WebPage", "@id": url},
        "datePublished": published,
        "dateModified": modified,
        "inLanguage": "zh-CN",
        "author": ({"@type": "Person", "name": author,
                    "url": f"{BASE}/u/?id={uid}"} if uid
                   else {"@type": "Person", "name": author}),
        "publisher": {"@type": "Organization", "name": "KJLLin",
                      "logo": {"@type": "ImageObject", "url": f"{BASE}/favicon.svg"}},
        "image": f"{BASE}/og-cover.png",
        "wordCount": count_words(post.get("content")),
    }
    crumb = {
        "@context": "https://schema.org",
        "@type": "BreadcrumbList",
        "itemListElement": [
            {"@type": "ListItem", "position": 1, "name": "首页", "item": f"{BASE}/"},
            {"@type": "ListItem", "position": 2, "name": "文章广场", "item": f"{BASE}/discuss/"},
            {"@type": "ListItem", "position": 3, "name": title, "item": url},
        ],
    }

    s = tpl

    # 1) title / description / canonical
    s = s.replace("<title>文章 · KJLLin</title>", f"<title>{esc(title)} · KJLLin</title>", 1)
    s = s.replace('<meta name="description" content="文章帖 · KJLLin">',
                  f'<meta name="description" content="{esc(desc)}">', 1)
    s = s.replace('<link rel="canonical" href="https://kjllin.dpdns.org/discuss/view/">',
                  f'<link rel="canonical" href="{url}">', 1)

    # 2) OG / Twitter / JSON-LD
    extra = HEAD_EXTRA.format(og_type="article", title=esc(title), desc=esc(desc),
                              url=url, BASE=BASE, article_meta=article_meta,
                              ld=json_script(blog))
    extra += f'  <script type="application/ld+json">{json_script(crumb)}</script>\n'
    s = s.replace("</head>", extra + "</head>", 1)

    # 3) 注入预渲染正文
    payload = {
        "id": pid, "title": post.get("title") or "", "content": post.get("content") or "",
        "user_id": uid, "nick": post.get("nick") or "",
        "avatar_url": post.get("avatar_url") or "",
        "created_at": post.get("created_at"), "updated_at": post.get("updated_at"),
        "likes_count": post.get("likes_count") or 0,
        "visibility": post.get("visibility") or "public",
    }
    block = (f'{inner}\n    <script id="__post" type="application/json">'
             f'{json_script(payload)}</script>\n  ')
    s = re.sub(r'<div class="container" id="mainContainer">\s*<!-- 内容由 JS 渲染 -->\s*</div>',
               lambda m: '<div class="container" id="mainContainer">' + block + '</div>', s, count=1)

    # 4) 正文已在 HTML 里，不再需要加载遮罩
    s = s.replace('<body class="article-loading">', "<body>", 1)
    try:
        a = s.index('  <div id="loader">')
        b = s.index("  <!-- ================== 全局导航栏")
        s = s[:a] + s[b:]
    except ValueError:
        pass

    return s


def gen_posts(page, posts):
    tpl = read(POST_TPL)
    made = []

    # 文章被删除或转为私有后，对应静态目录要一起清掉，避免留下过期页面
    keep = {p["id"] for p in posts}
    vdir = ROOT / "discuss/view"
    if vdir.exists():
        for d in vdir.iterdir():
            if d.is_dir() and d.name not in keep:
                shutil.rmtree(d)
                print(f"  清理已下架文章 {d.name}")
    for i, post in enumerate(posts, 1):
        pid = post["id"]
        page.goto(f"{LOCAL}/discuss/view/?id={pid}&prerender=1",
                  wait_until="domcontentloaded", timeout=45000)
        page.wait_for_selector("#markdownBody", timeout=30000)
        page.wait_for_timeout(500)          # 等 KaTeX / 高亮落地
        inner = page.inner_html("#mainContainer").strip()
        out = build_post_page(tpl, post, inner)
        write(f"discuss/view/{pid}/index.html", out)
        made.append(pid)
        print(f"  [{i}/{len(posts)}] {pid}  {post.get('title')}")
    return made


# ---------------------------------------------------------------- 文档页

def build_doc_page(tpl, slug, title, meta, main_inner, toc_inner, sidebar_inner):
    url = f"{BASE}/docs/{slug}/"
    desc = plain_text(meta, 150) or f"{title} · KJLLin 帮助文档"

    s = tpl
    s = s.replace("<title>帮助文档 · KJLLin</title>",
                  f"<title>{esc(title)} · 帮助文档 · KJLLin</title>", 1)
    s = s.replace('<meta name="description" content="KJLLin 帮助文档中心 - 游戏、社交、云盘使用指南">',
                  f'<meta name="description" content="{esc(desc)}">', 1)
    s = s.replace('<link rel="canonical" href="https://kjllin.dpdns.org/docs/">',
                  f'<link rel="canonical" href="{url}">', 1)

    extra = HEAD_EXTRA.format(og_type="article", title=esc(title), desc=esc(desc),
                              url=url, BASE=BASE, article_meta="",
                              ld=json_script({
                                  "@context": "https://schema.org",
                                  "@type": "TechArticle",
                                  "headline": title,
                                  "description": desc,
                                  "url": url,
                                  "inLanguage": "zh-CN",
                                  "isPartOf": {"@type": "WebSite", "name": "KJLLin 帮助文档",
                                               "url": f"{BASE}/docs/"},
                                  "publisher": {"@type": "Organization", "name": "KJLLin"},
                              }))
    s = s.replace("</head>", extra + "</head>", 1)

    s = s.replace("<body>", f'<body data-doc-section="{esc(slug)}">', 1)

    # 侧边栏由 JS 生成，禁用 JS 时为空；预渲染时写进 HTML，爬虫才能顺着内链发现各章节
    sb = re.sub(r'class="sidebar-link active"', 'class="sidebar-link"', sidebar_inner)
    sb = sb.replace(f'<a class="sidebar-link" href="/docs/{slug}/"',
                    f'<a class="sidebar-link active" href="/docs/{slug}/"')
    s = s.replace('<ul class="sidebar-menu" id="sidebarMenu"></ul>',
                  f'<ul class="sidebar-menu" id="sidebarMenu">{sb}</ul>', 1)
    s = s.replace('<div class="docs-content-inner" id="docMain"></div>',
                  f'<div class="docs-content-inner" id="docMain">{main_inner}</div>', 1)
    s = s.replace('<nav class="docs-toc" id="toc"></nav>',
                  f'<nav class="docs-toc" id="toc">{toc_inner}</nav>', 1)
    return s


def gen_docs(page):
    tpl = read("docs/index.html")
    page.goto(f"{LOCAL}/docs/", wait_until="domcontentloaded", timeout=45000)
    page.wait_for_selector(".sidebar-link", timeout=20000)
    sections = page.evaluate("""() => Array.from(document.querySelectorAll('.sidebar-link'))
        .map(a => ({slug: a.dataset.section, title: a.textContent.trim()}))""")
    sidebar_inner = page.inner_html("#sidebarMenu")
    made = []
    for i, sec in enumerate(sections, 1):
        slug = sec["slug"]
        page.goto(f"{LOCAL}/docs/#/{slug}", wait_until="domcontentloaded", timeout=45000)
        page.wait_for_selector("#docMain .doc-body", timeout=20000)
        page.wait_for_timeout(200)
        main_inner = page.inner_html("#docMain")
        toc_inner = page.inner_html("#toc")
        title = page.inner_text("#docMain .doc-title").strip()
        meta = ""
        el = page.query_selector("#docMain .doc-meta")
        if el:
            meta = el.inner_text().strip()
        write(f"docs/{slug}/index.html",
              build_doc_page(tpl, slug, title, meta, main_inner, toc_inner, sidebar_inner))
        made.append({"slug": slug, "title": title})
        print(f"  [{i}/{len(sections)}] /docs/{slug}/  {title}")
    return made


# ---------------------------------------------------------------- sitemap / robots

STATIC_PAGES = [
    ("/", "1.0", "daily"),
    ("/discuss/", "0.9", "daily"),
    ("/docs/", "0.8", "weekly"),
    ("/game/", "0.8", "weekly"),
    ("/news/", "0.7", "daily"),
    ("/status/", "0.4", "weekly"),
]


def gen_meta(posts, docs):
    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    items = []
    for path, pri, freq in STATIC_PAGES:
        items.append((path, today, freq, pri))
    for p in posts:
        items.append((f"/discuss/view/{p['id']}/",
                      iso_date(p.get("updated_at") or p.get("created_at")) or today,
                      "monthly", "0.8"))
    for d in docs:
        items.append((f"/docs/{d['slug']}/", today, "monthly", "0.7"))

    body = []
    for path, lastmod, freq, pri in items:
        body.append(
            "  <url>\n"
            f"    <loc>{BASE}{path}</loc>\n"
            f"    <lastmod>{lastmod}</lastmod>\n"
            f"    <changefreq>{freq}</changefreq>\n"
            f"    <priority>{pri}</priority>\n"
            "  </url>"
        )
    sitemap = ('<?xml version="1.0" encoding="UTF-8"?>\n'
               '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n'
               + "\n".join(body) + "\n</urlset>\n")
    write("sitemap.xml", sitemap)

    robots = """User-agent: *
Allow: /

# 需要登录的页面不收录
Disallow: /chat/
Disallow: /cloud/
Disallow: /settings/
Disallow: /notifications/
Disallow: /admin/
Disallow: /login/
Disallow: /u/
Disallow: /discuss/new/
Disallow: /discuss/edit/
Disallow: /discuss/saved/
Disallow: /migration/
Disallow: /scripts/

Sitemap: %s/sitemap.xml
""" % BASE
    write("robots.txt", robots)
    print(f"  sitemap.xml  {len(items)} 条")
    print("  robots.txt")


# ---------------------------------------------------------------- 主流程

def main():
    mode = (sys.argv[1] if len(sys.argv) > 1 else "all").lower()
    from playwright.sync_api import sync_playwright

    posts = fetch_posts()
    print(f"公开文章 {len(posts)} 篇")

    srv = serve()
    made_posts, made_docs = [], []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch()
            ctx = browser.new_context(viewport={"width": 1280, "height": 900},
                                      user_agent="KJLLinPrerender/1.0")
            page = ctx.new_page()
            page.on("pageerror", lambda e: None)

            if mode in ("all", "posts"):
                print("文章详情：")
                made_posts = gen_posts(page, posts)
            if mode in ("all", "docs"):
                print("文档章节：")
                made_docs = gen_docs(page)

            browser.close()

        if mode in ("all", "meta"):
            print("站点地图：")
            if not made_docs:
                # 只生成 meta 时，从已有目录推断章节
                made_docs = [{"slug": d.name} for d in (ROOT / "docs").iterdir()
                             if d.is_dir() and (d / "index.html").exists()]
            gen_meta(posts, made_docs)
    finally:
        srv.shutdown()

    print("完成")


if __name__ == "__main__":
    main()
