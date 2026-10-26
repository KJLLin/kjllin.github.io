-- ============================================================================
-- 29-admin-news.sql
-- 管理后台的资讯源视图与手动同步（仅管理员）
-- ============================================================================

create or replace function public.admin_news_overview()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_feeds jsonb;
  v_jobs  jsonb;
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  select jsonb_agg(jsonb_build_object(
           'source',        f.source,
           'name',          f.name,
           'url',           f.url,
           'enabled',       f.enabled,
           'interval',      f.interval_minutes,
           'last_fetch_at', f.last_fetch_at,
           'total',         (select count(*) from public.news_items n where n.source = f.source),
           'latest',        (select max(n.published_at) from public.news_items n where n.source = f.source)
         ) order by f.id)
    into v_feeds
  from public.news_feeds f;

  select jsonb_agg(jsonb_build_object(
           'id', j.id, 'source', j.source, 'error', j.error,
           'items', j.items_count, 'created', j.created_at, 'processed', j.processed_at
         ) order by j.id desc)
    into v_jobs
  from (select * from public.news_fetch_jobs order by id desc limit 6) j;

  return jsonb_build_object('feeds', coalesce(v_feeds, '[]'::jsonb),
                            'jobs',  coalesce(v_jobs, '[]'::jsonb));
end;
$$;

revoke all on function public.admin_news_overview() from public, anon;
grant execute on function public.admin_news_overview() to authenticated;

create or replace function public.admin_news_sync()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  return public.news_sync_tick();
end;
$$;

revoke all on function public.admin_news_sync() from public, anon;
grant execute on function public.admin_news_sync() to authenticated;

-- 管理后台用户列表要显示头像
create or replace function public.admin_user_avatars()
returns table (id uuid, avatar_url text)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.avatar_url
  from public.users u
  where public.is_admin();
$$;

revoke all on function public.admin_user_avatars() from public, anon;
grant execute on function public.admin_user_avatars() to authenticated;
