-- ============================================================================
-- 28-news-sources.sql
-- 资讯多源化 + 取消导购拦截
--
-- 背景
--   1. IT 之家官方只有全量 RSS，没有「精选」频道；
--      央视网官方 RSS 停更于 2007 年、站点为 JS 渲染、api.cntv.cn 有访问校验，
--      拿不到稳定的实时源。按需求：不再用黑名单拦截，全部收录。
--   2. 新增中新网滚动新闻（官方 RSS，实时更新，UTF-8），与 IT 之家互补。
--
-- 改造
--   · news_feeds 表：源配置（名称 / URL / 域名 / 抓取间隔），加源只需插一行
--   · news_fetch_jobs 加 source，按源分别抓取与去重
--   · news_list 取消 is_ad 过滤，支持按来源筛选，返回来源名称
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 源配置
-- ---------------------------------------------------------------------------
create table if not exists public.news_feeds (
  id               bigserial primary key,
  source           text not null unique,
  name             text not null,
  url              text not null,
  link_host        text not null,
  interval_minutes int  not null default 25,
  enabled          boolean not null default true,
  last_fetch_at    timestamptz,
  created_at       timestamptz not null default now()
);

alter table public.news_feeds enable row level security;
drop policy if exists news_feeds_read on public.news_feeds;
create policy news_feeds_read on public.news_feeds
  for select to anon, authenticated using (true);

revoke all on public.news_feeds from anon, authenticated;
grant select (source, name, enabled) on public.news_feeds to anon, authenticated;

insert into public.news_feeds (source, name, url, link_host, interval_minutes)
values
  ('ithome',    'IT 之家', 'https://www.ithome.com/rss/',                   'ithome.com',     25),
  ('chinanews', '中新网',  'https://www.chinanews.com.cn/rss/scroll-news.xml', 'chinanews.com.cn', 20)
on conflict (source) do update
  set name = excluded.name, url = excluded.url,
      link_host = excluded.link_host, interval_minutes = excluded.interval_minutes;

-- ---------------------------------------------------------------------------
-- 2. 任务表按源区分
-- ---------------------------------------------------------------------------
alter table public.news_fetch_jobs add column if not exists source text;
update public.news_fetch_jobs set source = 'ithome' where source is null;
create index if not exists news_fetch_jobs_src_idx on public.news_fetch_jobs (source, processed_at);

-- ---------------------------------------------------------------------------
-- 3. 主循环：按 feed 抓取 + 通用 RSS 解析
-- ---------------------------------------------------------------------------
create or replace function public.news_sync_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feed     record;
  v_job      record;
  v_host     text;
  v_code     int;
  v_body     text;
  v_parts    text[];
  v_item     text;
  v_title    text;
  v_link     text;
  v_guid     text;
  v_desc     text;
  v_pub      text;
  v_pubts    timestamptz;
  v_plain    text;
  v_html     text;
  v_cover    text;
  v_ad       boolean;
  v_imp      smallint;
  v_touched  int;
  v_total    int := 0;
  v_rid      bigint;
  v_n        int;
begin
  -- ---- 阶段 1：解析所有已回来的抓取结果 ----
  for v_job in
    select j.id, j.request_id, j.created_at, coalesce(j.source, 'ithome') as source
    from public.news_fetch_jobs j
    where j.processed_at is null
    order by j.id
    limit 8
  loop
    select f.link_host into v_host from public.news_feeds f where f.source = v_job.source;
    v_host := coalesce(v_host, 'ithome.com');

    v_code := null;
    v_body := null;

    select r.status_code, r.content into v_code, v_body
    from net._http_response r
    where r.id = v_job.request_id;

    if v_code is null then
      if v_job.created_at < now() - interval '10 minutes' then
        update public.news_fetch_jobs set processed_at = now(), error = 'timeout' where id = v_job.id;
      end if;
      continue;
    end if;

    if v_code <> 200 or coalesce(v_body, '') = '' then
      update public.news_fetch_jobs
         set processed_at = now(), error = 'http ' || v_code::text
       where id = v_job.id;
      continue;
    end if;

    v_parts := regexp_split_to_array(v_body, '<item>');
    v_touched := 0;

    for v_n in 2 .. coalesce(array_length(v_parts, 1), 0) loop
      v_item := v_parts[v_n];

      v_title := btrim(coalesce((regexp_match(v_item, '<title>([\s\S]*?)</title>'))[1], ''));
      v_link  := btrim(coalesce((regexp_match(v_item, '<link>([\s\S]*?)</link>'))[1], ''));
      v_guid  := btrim(coalesce((regexp_match(v_item, '<guid>([\s\S]*?)</guid>'))[1], v_link));
      v_desc  := coalesce((regexp_match(v_item, '<description>([\s\S]*?)</description>'))[1], '');
      v_pub   := btrim(coalesce((regexp_match(v_item, '<pubDate>([\s\S]*?)</pubDate>'))[1], ''));

      -- 去掉 CDATA 包裹
      v_title := btrim(regexp_replace(v_title, '^<!\[CDATA\[|\]\]>$', '', 'g'));
      v_link  := btrim(regexp_replace(v_link,  '^<!\[CDATA\[|\]\]>$', '', 'g'));
      v_guid  := btrim(regexp_replace(v_guid,  '^<!\[CDATA\[|\]\]>$', '', 'g'));

      if v_title = '' or v_link = '' or v_guid = '' then
        continue;
      end if;

      -- 只接受该源自己域名的链接
      if v_link !~* ('^https?://([a-z0-9-]+\.)*' || replace(v_host, '.', '\.') || '/') then
        continue;
      end if;

      v_title := public.news_unescape(v_title);
      v_html  := public.news_unescape(v_desc);
      v_plain := public.news_plain(v_desc, 140);
      v_cover := (regexp_match(v_html, '<img[^>]+src="(https?://[^"<> ]+)"'))[1];

      v_ad  := public.news_is_ad(v_title);
      v_imp := public.news_importance(v_title, v_cover is not null);

      begin
        v_pubts := v_pub::timestamptz;
      exception when others then
        v_pubts := now();
      end;
      if v_pubts is null or v_pubts > now() + interval '1 day' then
        v_pubts := now();
      end if;

      insert into public.news_items
        (source, guid, title, summary, cover_url, link, published_at, is_ad, importance)
      values
        (v_job.source, v_guid, v_title, v_plain, v_cover, v_link, v_pubts, v_ad, v_imp)
      on conflict (source, guid) do update
        set title        = excluded.title,
            summary      = excluded.summary,
            cover_url    = coalesce(excluded.cover_url, public.news_items.cover_url),
            link         = excluded.link,
            published_at = excluded.published_at,
            is_ad        = excluded.is_ad,
            importance   = excluded.importance
        where public.news_items.title is distinct from excluded.title
           or public.news_items.summary is distinct from excluded.summary;

      get diagnostics v_n = row_count;
      v_touched := v_touched + v_n;
    end loop;

    v_total := v_total + v_touched;

    update public.news_fetch_jobs
       set processed_at = now(), items_count = v_touched
     where id = v_job.id;
  end loop;

  -- ---- 阶段 2：按源各自的间隔发起抓取 ----
  for v_feed in select * from public.news_feeds where enabled loop
    if not exists (
         select 1 from public.news_fetch_jobs j
         where j.source = v_feed.source and j.processed_at is null
       )
       and coalesce(v_feed.last_fetch_at, 'epoch'::timestamptz)
           < now() - (v_feed.interval_minutes::text || ' minutes')::interval
    then
      v_rid := net.http_get(url := v_feed.url, timeout_milliseconds := 60000);
      insert into public.news_fetch_jobs (request_id, source) values (v_rid, v_feed.source);
      update public.news_feeds set last_fetch_at = now() where id = v_feed.id;
    end if;
  end loop;

  delete from public.news_fetch_jobs where created_at < now() - interval '2 days';
  delete from public.news_items where published_at < now() - interval '45 days';

  return jsonb_build_object('upserted', v_total);
end;
$$;

revoke all on function public.news_sync_tick() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 前端接口：不再按 is_ad 过滤，支持按来源筛选
-- ---------------------------------------------------------------------------
drop function if exists public.news_list(timestamptz, bigint, int, boolean);

create function public.news_list(
  p_before_ts timestamptz default null,
  p_before_id bigint default null,
  p_limit     int default 20,
  p_source    text default null
)
returns table (
  id bigint, title text, summary text, cover_url text,
  link text, published_at timestamptz,
  source text, source_name text, importance smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.title, n.summary, n.cover_url, n.link, n.published_at,
         n.source,
         coalesce(f.name, '资讯') as source_name,
         n.importance
  from public.news_items n
  left join public.news_feeds f on f.source = n.source
  where (p_source is null or n.source = p_source)
    and (p_before_ts is null
         or (n.published_at, n.id) < (p_before_ts, coalesce(p_before_id, 0)))
  order by n.published_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.news_list(timestamptz, bigint, int, text) from public;
grant execute on function public.news_list(timestamptz, bigint, int, text) to anon, authenticated;

drop function if exists public.news_stats();

create function public.news_stats()
returns table (total bigint, latest timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*), max(n.published_at) from public.news_items n;
$$;

revoke all on function public.news_stats() from public;
grant execute on function public.news_stats() to anon, authenticated;

-- 各源条数（前端做来源筛选标签时用）
create or replace function public.news_source_stats()
returns table (source text, source_name text, total bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select n.source, coalesce(f.name, n.source), count(*)
  from public.news_items n
  left join public.news_feeds f on f.source = n.source
  group by n.source, f.name
  order by count(*) desc;
$$;

revoke all on function public.news_source_stats() from public;
grant execute on function public.news_source_stats() to anon, authenticated;
