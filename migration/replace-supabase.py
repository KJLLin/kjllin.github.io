#!/usr/bin/env python3
"""
批量替换所有网站文件中的 Supabase URL 和 Key
用法: python3 replace-supabase.py <新URL> <新AnonKey>
"""
import os, sys, re

BASE_DIR = os.path.dirname(os.path.abspath(__file__))

# 旧项目的公开标识（非机密：URL 与 anon key 本就出现在前端源码中）。
# 原文件曾把完整 anon key 硬编码在此，已改为从环境变量读取，避免仓库中出现明文 JWT。
OLD_URL = os.environ.get("OLD_SUPABASE_URL", "https://ayavdkodhdmcxfufnnxo.supabase.co")
OLD_KEY = os.environ.get("OLD_SUPABASE_ANON_KEY", "")
if not OLD_KEY:
    print("错误：请先设置环境变量 OLD_SUPABASE_ANON_KEY（旧项目的 anon key）")
    sys.exit(1)

if len(sys.argv) != 3:
    print("用法: python3 replace-supabase.py <新URL> <新AnonKey>")
    print(f"旧URL: {OLD_URL}")
    print("环境变量: OLD_SUPABASE_ANON_KEY（必填，旧项目 anon key）")
    sys.exit(1)

new_url = sys.argv[1].rstrip('/')
new_key = sys.argv[2]

# 收集需要替换的文件
html_files = []
for root, dirs, files in os.walk(BASE_DIR):
    # 跳过 node_modules, .git, migration 目录
    dirs[:] = [d for d in dirs if d not in ['node_modules', '.git', 'migration', '.codebuddy']]
    for f in files:
        if f.endswith('.html') or f.endswith('.js') or f.endswith('.ts'):
            html_files.append(os.path.join(root, f))

replaced_count = 0
for fpath in html_files:
    with open(fpath, 'r', encoding='utf-8') as f:
        content = f.read()
    
    new_content = content
    url_replaced = False
    key_replaced = False
    
    if OLD_URL in new_content:
        new_content = new_content.replace(OLD_URL, new_url)
        url_replaced = True
    
    if OLD_KEY in new_content:
        new_content = new_content.replace(OLD_KEY, new_key)
        key_replaced = True
    
    if url_replaced or key_replaced:
        with open(fpath, 'w', encoding='utf-8') as f:
            f.write(new_content)
        relpath = os.path.relpath(fpath, BASE_DIR)
        print(f"✓ {relpath}  (URL: {url_replaced}, Key: {key_replaced})")
        replaced_count += 1

print(f"\n完成！共替换了 {replaced_count} 个文件。")
