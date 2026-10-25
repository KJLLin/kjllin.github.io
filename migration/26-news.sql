-- ============================================================================
-- 26-news.sql
-- IT 之家资讯聚合（服务器端订阅）
--
-- 架构
--   pg_cron（每 2 分钟）→ news_sync_tick()
--        ├─ 1. 处理已回来的抓取结果：解析 RSS → upsert 进 news_items
--        └─ 2. 距上次抓取超过 25 分钟且没有在途请求 → net.http_get 发起新一轮
--
--   两段式是因为 pg_net 是异步的：发起请求拿不到响应体，必须下一轮再取。
--   job 表记录 request_id，超时 / 非 200 都会落一条 error，方便排查。
--
-- 权限
--   客户端只能 SELECT（RLS），写入完全由 SECURITY DEFINER 函数完成。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 资讯表
-- ---------------------------------------------------------------------------
create table if not exists public.news_items (
  id           bigserial primary key,
  source       text        not null default 'ithome',
  guid         text        not null,
  title        text        not null,
  summary      text,
  cover_url    text,
  link         text        not null,
  published_at timestamptz not null default now(),
  created_at   timestamptz not null default now(),
  constraint news_items_guid_key unique (source, guid)
);

create index if not exists news_items_pub_idx on public.news_items (published_at desc, id desc);

comment on table public.news_items is '聚合资讯（当前来源：IT之家 RSS）';

alter table public.news_items enable row level security;

drop policy if exists news_items_read on public.news_items;
create policy news_items_read on public.news_items
  for select to anon, authenticated using (true);

revoke all on public.news_items from anon, authenticated;
grant select on public.news_items to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. 抓取任务表（客户端完全不可见）
-- ---------------------------------------------------------------------------
create table if not exists public.news_fetch_jobs (
  id           bigserial primary key,
  request_id   bigint,
  created_at   timestamptz not null default now(),
  processed_at timestamptz,
  items_count  integer,
  error        text
);

alter table public.news_fetch_jobs enable row level security;
revoke all on public.news_fetch_jobs from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 3. 工具函数
-- ---------------------------------------------------------------------------

/** HTML 实体反转义（顺序很重要：&amp; 必须最后处理） */
create or replace function public.news_unescape(t text)
returns text
language sql
immutable
set search_path = ''
as $$
  select replace(replace(replace(replace(replace(replace(
           coalesce(t, ''),
         '&lt;',   '<'),
         '&gt;',   '>'),
         '&quot;', '"'),
         '&#39;',  ''''),
         '&nbsp;', ' '),
         '&amp;',  '&');
$$;

/** 从转义过的 description 里生成纯文本摘要 */
create or replace function public.news_plain(html text, max_len int default 140)
returns text
language sql
immutable
set search_path = ''
as $$
  with t as (
    select regexp_replace(
             regexp_replace(public.news_unescape(html), '<[^>]*>', ' ', 'g'),
             '\s+', ' ', 'g') as s
  )
  select nullif(btrim(left(s, greatest(20, coalesce(max_len, 140)))), '') from t;
$$;

-- ---------------------------------------------------------------------------
-- 4. 主循环：抓取 + 入库
-- ---------------------------------------------------------------------------
create or replace function public.news_sync_tick()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job      record;
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
  v_touched  int := 0;
  v_upserted int := 0;
  v_last     timestamptz;
  v_rid      bigint;
  v_idx      int;
begin
  -- ---- 阶段 1：处理待解析的抓取结果 ----
  for v_job in
    select j.id, j.request_id, j.created_at
    from public.news_fetch_jobs j
    where j.processed_at is null
    order by j.id
    limit 5
  loop
    v_code := null;
    v_body := null;

    select r.status_code, r.content into v_code, v_body
    from net._http_response r
    where r.id = v_job.request_id;

    if v_code is null then
      -- 请求还没回来：超过 10 分钟判定失败，避免永远卡住
      if v_job.created_at < now() - interval '10 minutes' then
        update public.news_fetch_jobs
           set processed_at = now(), error = 'timeout'
         where id = v_job.id;
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

    for v_idx in 2 .. coalesce(array_length(v_parts, 1), 0) loop
      v_item := v_parts[v_idx];

      v_title := btrim(coalesce((regexp_match(v_item, '<title>([^<]*)</title>'))[1], ''));
      v_link  := btrim(coalesce((regexp_match(v_item, '<link>([^<]*)</link>'))[1], ''));
      v_guid  := btrim(coalesce((regexp_match(v_item, '<guid>([^<]*)</guid>'))[1], v_link));
      v_desc  := coalesce((regexp_match(v_item, '<description>([\s\S]*?)</description>'))[1], '');
      v_pub   := btrim(coalesce((regexp_match(v_item, '<pubDate>([^<]*)</pubDate>'))[1], ''));

      if v_title = '' or v_link = '' or v_guid = '' then
        continue;
      end if;

      -- 只接受本站链接，避免 RSS 被注入外链
      if v_link !~* '^https://([a-z0-9-]+\.)*ithome\.com/' then
        continue;
      end if;

      v_title := public.news_unescape(v_title);
      v_html  := public.news_unescape(v_desc);
      v_plain := public.news_plain(v_desc, 140);
      v_cover := (regexp_match(v_html, '<img[^>]+src="(https://[^"<> ]+)"'))[1];

      begin
        v_pubts := v_pub::timestamptz;
      exception when others then
        v_pubts := now();
      end;
      if v_pubts is null or v_pubts > now() + interval '1 day' then
        v_pubts := now();
      end if;

      insert into public.news_items (source, guid, title, summary, cover_url, link, published_at)
      values ('ithome', v_guid, v_title, v_plain, v_cover, v_link, v_pubts)
      on conflict (source, guid) do update
        set title        = excluded.title,
            summary      = excluded.summary,
            cover_url    = coalesce(excluded.cover_url, public.news_items.cover_url),
            link         = excluded.link,
            published_at = excluded.published_at
        where public.news_items.title is distinct from excluded.title
           or public.news_items.summary is distinct from excluded.summary;

      get diagnostics v_idx = row_count;
      v_touched := v_touched + v_idx;
    end loop;

    v_upserted := v_upserted + v_touched;

    update public.news_fetch_jobs
       set processed_at = now(), items_count = v_touched
     where id = v_job.id;
  end loop;

  -- ---- 阶段 2：需要时发起新一轮抓取 ----
  select max(j.created_at) into v_last from public.news_fetch_jobs j;

  if (v_last is null or v_last < now() - interval '25 minutes')
     and not exists (select 1 from public.news_fetch_jobs j where j.processed_at is null)
  then
    v_rid := net.http_get(
      url := 'https://www.ithome.com/rss/',
      timeout_milliseconds := 60000
    );
    insert into public.news_fetch_jobs (request_id) values (v_rid);
  end if;

  -- ---- 顺手清理：任务记录 2 天、资讯 45 天 ----
  delete from public.news_fetch_jobs where created_at < now() - interval '2 days';
  delete from public.news_items where published_at < now() - interval '45 days';

  return jsonb_build_object('upserted', v_upserted);
end;
$$;

revoke all on function public.news_sync_tick() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. 前端读取接口（游标分页）
-- ---------------------------------------------------------------------------
create or replace function public.news_list(
  p_before_ts timestamptz default null,
  p_before_id bigint default null,
  p_limit     int default 20
)
returns table (
  id bigint, title text, summary text, cover_url text,
  link text, published_at timestamptz, source text
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.title, n.summary, n.cover_url, n.link, n.published_at, n.source
  from public.news_items n
  where p_before_ts is null
     or (n.published_at, n.id) < (p_before_ts, coalesce(p_before_id, 0))
  order by n.published_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.news_list(timestamptz, bigint, int) from public;
grant execute on function public.news_list(timestamptz, bigint, int) to anon, authenticated;

create or replace function public.news_stats()
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

-- ---------------------------------------------------------------------------
-- 6. 定时任务
-- ---------------------------------------------------------------------------
do $$
declare
  v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname = 'news-sync-ithome' loop
    perform cron.unschedule(v_job);
  end loop;
end $$;

select cron.schedule('news-sync-ithome', '*/2 * * * *', $$select public.news_sync_tick();$$);
