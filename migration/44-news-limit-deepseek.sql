-- 44-news-limit-deepseek.sql
-- 1) 资讯按「每个源保留最新 N 条」裁剪，避免只靠 45 天时间窗仍堆积上万条
-- 2) 新增 DeepSeek 服务状态源（RSS 2.0，与现有解析器兼容）

-- ---------------------------------------------------------------- 裁剪
create index if not exists news_items_source_pub_idx
  on public.news_items (source, published_at desc, id desc);

create or replace function public.news_trim(p_keep integer default 600)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  with ranked as (
    select id,
           row_number() over (
             partition by source
             order by published_at desc nulls last, id desc
           ) as rn
    from public.news_items
  ), doomed as (
    -- 每个源至少留 50 条，防止误传 0 把数据清空
    select id from ranked where rn > greatest(coalesce(p_keep, 600), 50)
  )
  delete from public.news_items n
  using doomed d
  where n.id = d.id;

  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke all on function public.news_trim(integer) from public, anon, authenticated;

-- 每小时第 7 分钟裁剪一次（tick 每 2 分钟跑，裁剪单独降频）
do $$
begin
  perform cron.unschedule('news_trim_hourly');
exception when others then null;
end $$;

select cron.schedule('news_trim_hourly', '7 * * * *', $$select public.news_trim();$$);

-- ---------------------------------------------------------------- DeepSeek 状态源
insert into public.news_feeds (source, name, url, link_host, interval_minutes, enabled)
values (
  'deepseek',
  'DeepSeek 状态',
  'https://status.deepseek.com/feed.rss',
  'status.deepseek.com',
  10,
  true
)
on conflict (source) do update
  set name             = excluded.name,
      url              = excluded.url,
      link_host        = excluded.link_host,
      interval_minutes = excluded.interval_minutes,
      enabled          = true;

-- 立即执行一次，把历史积压降下来
select public.news_trim(600) as trimmed_now;
