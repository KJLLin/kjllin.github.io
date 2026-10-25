-- ============================================================================
-- 27-news-filter.sql
-- 资讯精选：去掉电商导购，保留有价值的行业/技术新闻
--
-- 目标（按需求）：只收录重要和精选的新闻，去掉广告，但不要砍太多。
--   · news_is_ad(title)      → 明确的价格/促销/导购稿，默认不展示（约 20~30%）
--   · news_importance(...)   → 0~13 的重要度评分，>=5 在页面上标「精选」
--                             只用来加角标，不做二次过滤，避免内容太少
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 判定函数
-- ---------------------------------------------------------------------------

-- 广告/导购判定
--   规则一：标题里出现明确的促销词
--   规则二：标题带价格（元），且不是财报/投资/监管这类商业新闻
--   注意：先剔掉「美元 / 亿元 / 亿美金」，否则「投资 500 亿美元」会被误判成商品价格。
create or replace function public.news_is_ad(p_title text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  with t as (
    select coalesce(p_title, '') as raw,
           regexp_replace(coalesce(p_title, ''), '美元|亿元|亿美金', '', 'g') as nocur
  )
  select
    raw ~ '好价|直降|国补|促销|狂促|秒杀|返现|包邮|到手价|券后|优惠券|优惠|值得买|好物|清单|怎么选|限时|特惠|补贴|凑单|满减|元购|低至|开卖|抢购'
    or (
      nocur ~ '元'
      and raw !~ '财报|净利润|营收|利润|同比|环比|裁员|收购|并购|融资|投资|起诉|诉讼|调查|监管|反垄断|产能|出货|市场规模|市占|营收'
    )
  from t;
$$;

-- 重要度评分（只用于「精选」角标）
create or replace function public.news_importance(p_title text, p_has_cover boolean)
returns smallint
language sql
immutable
set search_path = ''
as $$
  select least(20, greatest(0,
      (case when p_title ~ '财报|净利润|营收|利润|同比|环比|毛利率' then 4 else 0 end)
    + (case when p_title ~ '裁员|收购|并购|合并|融资|投资|入股|退市|起诉|诉讼|调查|监管|反垄断|解雇|离职|破产' then 4 else 0 end)
    + (case when p_title ~ '漏洞|安全|攻击|泄露|隐私|劫持|故障|宕机|事故' then 3 else 0 end)
    + (case when p_title ~ '标准|协议|专利|规范|白皮书|商用|量产|出货|产能|下线' then 3 else 0 end)
    + (case when p_title ~* 'AI|大模型|智能体|芯片|算力|数据中心|机器人|自动驾驶' then 2 else 0 end)
    + (case when p_title ~* '鸿蒙|harmonyos|android|ios|windows|linux|macos|originos' then 2 else 0 end)
    + (case when p_title ~ '官宣|宣布|正式发布|曝光|亮相|上线|开源|首次|首个|全球首|达成|合作' then 2 else 0 end)
    + (case when coalesce(p_has_cover, false) then 2 else 0 end)
  ))::smallint;
$$;

-- ---------------------------------------------------------------------------
-- 2. 字段
-- ---------------------------------------------------------------------------
alter table public.news_items add column if not exists is_ad      boolean   not null default false;
alter table public.news_items add column if not exists importance smallint  not null default 0;

create index if not exists news_items_feed_idx
  on public.news_items (published_at desc, id desc)
  where is_ad = false;

comment on column public.news_items.is_ad      is '电商导购/促销稿，默认不展示';
comment on column public.news_items.importance is '重要度 0~13，>=5 标为精选';

-- ---------------------------------------------------------------------------
-- 3. 回填历史数据
-- ---------------------------------------------------------------------------
update public.news_items
   set is_ad = public.news_is_ad(title),
       importance = public.news_importance(title, cover_url is not null)
 where true;

-- ---------------------------------------------------------------------------
-- 4. 抓取时同步计算（重写主循环里的一段逻辑）
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
  v_ad       boolean;
  v_imp      smallint;
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
      if v_job.created_at < now() - interval '10 minutes' then
        update public.news_fetch_jobs set processed_at = now(), error = 'timeout' where id = v_job.id;
      end if;
      continue;
    end if;

    if v_code <> 200 or coalesce(v_body, '') = '' then
      update public.news_fetch_jobs set processed_at = now(), error = 'http ' || v_code::text where id = v_job.id;
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

      if v_link !~* '^https://([a-z0-9-]+\.)*ithome\.com/' then
        continue;
      end if;

      v_title := public.news_unescape(v_title);
      v_html  := public.news_unescape(v_desc);
      v_plain := public.news_plain(v_desc, 140);
      v_cover := (regexp_match(v_html, '<img[^>]+src="(https://[^"<> ]+)"'))[1];

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
        ('ithome', v_guid, v_title, v_plain, v_cover, v_link, v_pubts, v_ad, v_imp)
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
    v_rid := net.http_get(url := 'https://www.ithome.com/rss/', timeout_milliseconds := 60000);
    insert into public.news_fetch_jobs (request_id) values (v_rid);
  end if;

  delete from public.news_fetch_jobs where created_at < now() - interval '2 days';
  delete from public.news_items where published_at < now() - interval '45 days';

  return jsonb_build_object('upserted', v_upserted);
end;
$$;

revoke all on function public.news_sync_tick() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5. 前端接口：默认过滤广告，带上精选标记
-- ---------------------------------------------------------------------------
drop function if exists public.news_list(timestamptz, bigint, int);

create function public.news_list(
  p_before_ts timestamptz default null,
  p_before_id bigint default null,
  p_limit     int default 20,
  p_all       boolean default false
)
returns table (
  id bigint, title text, summary text, cover_url text,
  link text, published_at timestamptz, source text,
  importance smallint
)
language sql
stable
security definer
set search_path = ''
as $$
  select n.id, n.title, n.summary, n.cover_url, n.link, n.published_at, n.source, n.importance
  from public.news_items n
  where (p_all or n.is_ad = false)
    and (p_before_ts is null
         or (n.published_at, n.id) < (p_before_ts, coalesce(p_before_id, 0)))
  order by n.published_at desc, n.id desc
  limit least(greatest(coalesce(p_limit, 20), 1), 50);
$$;

revoke all on function public.news_list(timestamptz, bigint, int, boolean) from public;
grant execute on function public.news_list(timestamptz, bigint, int, boolean) to anon, authenticated;

drop function if exists public.news_stats();

create function public.news_stats()
returns table (total bigint, latest timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) filter (where n.is_ad = false), max(n.published_at)
  from public.news_items n;
$$;

revoke all on function public.news_stats() from public;
grant execute on function public.news_stats() to anon, authenticated;
