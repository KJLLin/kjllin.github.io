-- ===========================================================================
-- 34 · 文章收藏
--   · post_bookmarks：每人每篇一条，仅本人可见可写
--   · my_bookmarks()：收藏列表（带文章摘要与作者信息），游标分页
--   · bookmark_stats()：我的收藏总数，供列表页与设置中心展示
-- ===========================================================================

create table if not exists public.post_bookmarks (
  user_id    uuid not null references public.users(id)  on delete cascade,
  post_id    uuid not null references public.posts(id)  on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, post_id)
);

create index if not exists idx_post_bookmarks_user
  on public.post_bookmarks (user_id, created_at desc);

alter table public.post_bookmarks enable row level security;

drop policy if exists bm_select on public.post_bookmarks;
drop policy if exists bm_insert on public.post_bookmarks;
drop policy if exists bm_delete on public.post_bookmarks;

create policy bm_select on public.post_bookmarks
  for select to authenticated using (auth.uid() = user_id);

create policy bm_insert on public.post_bookmarks
  for insert to authenticated with check (auth.uid() = user_id);

create policy bm_delete on public.post_bookmarks
  for delete to authenticated using (auth.uid() = user_id);

revoke all on public.post_bookmarks from anon;
revoke all on public.post_bookmarks from authenticated;
grant select, insert, delete on public.post_bookmarks to authenticated;

-- ---------------------------------------------------------------------------
-- 收藏列表
-- ---------------------------------------------------------------------------
create or replace function public.my_bookmarks(
  p_limit  integer default 20,
  p_before timestamptz default null
)
returns table (
  post_id       uuid,
  title         text,
  excerpt       text,
  bookmarked_at timestamptz,
  published_at  timestamptz,
  author_id     uuid,
  author_nick   text,
  author_avatar text,
  likes_count   integer,
  visibility    text
)
language sql
security definer
set search_path = ''
as $$
  select
    b.post_id,
    coalesce(p.title, '无标题') as title,
    left(regexp_replace(coalesce(p.content, ''), '\s+', ' ', 'g'), 400) as excerpt,
    b.created_at,
    p.created_at,
    p.user_id,
    coalesce(u.nick, p.nick, '匿名') as author_nick,
    coalesce(u.avatar_url, '') as author_avatar,
    coalesce(p.likes_count, 0),
    coalesce(p.visibility, 'public')
  from public.post_bookmarks b
  join public.posts p on p.id = b.post_id
  left join public.users u on u.id = p.user_id
  where b.user_id = auth.uid()
    and (p.visibility = 'public' or p.user_id = auth.uid())
    and (p_before is null or b.created_at < p_before)
  order by b.created_at desc
  limit least(coalesce(p_limit, 20), 50);
$$;

revoke all on function public.my_bookmarks(integer, timestamptz) from public, anon;
grant execute on function public.my_bookmarks(integer, timestamptz) to authenticated;

-- ---------------------------------------------------------------------------
-- 收藏总数
-- ---------------------------------------------------------------------------
create or replace function public.bookmark_stats()
returns table (total integer)
language sql
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.post_bookmarks b
  join public.posts p on p.id = b.post_id
  where b.user_id = auth.uid()
    and (p.visibility = 'public' or p.user_id = auth.uid());
$$;

revoke all on function public.bookmark_stats() from public, anon;
grant execute on function public.bookmark_stats() to authenticated;
