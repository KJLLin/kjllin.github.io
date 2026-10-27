-- ============================================================================
-- 31-game-rank-and-release.sql
-- 1) 游戏排行榜：分数去重为「每人每游戏一条最优」，支持「是否参加排行榜」
-- 2) 站点更新说明：每次发版写一条，用户下次打开时弹窗告知
-- ============================================================================

-- ===========================================================================
-- 一、排行榜
-- ===========================================================================

-- 是否公开上榜（默认参加，保持现状；可在排行榜页关闭）
alter table public.users add column if not exists game_public boolean not null default true;

-- 成绩表补 updated_at
alter table public.game_scores add column if not exists updated_at timestamptz not null default now();

-- 历史数据：每个 (user, game) 只保留最优一条
--   schulte_* 是「用时×100」，越小越好；其余越大越好
delete from public.game_scores a
using public.game_scores b
where a.user_id = b.user_id
  and a.game = b.game
  and (
    case when a.game like 'schulte\_%' then a.score > b.score else a.score < b.score end
    or (a.score = b.score and a.id < b.id)
  );

-- 唯一约束（如果历史还有重复会失败，上面的 delete 已保证唯一）
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'game_scores_user_game_key'
  ) then
    alter table public.game_scores
      add constraint game_scores_user_game_key unique (user_id, game);
  end if;
end $$;

-- 白名单与合理性上限（复用原逻辑，抽成函数便于排行接口判断方向）
create or replace function public.game_is_lower_better(p_game text)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select p_game like 'schulte\_%';
$$;

revoke all on function public.game_is_lower_better(text) from public, anon, authenticated;

-- 提交成绩：upsert 保留最优
create or replace function public.submit_game_score(p_game text, p_score integer)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_banned boolean;
  v_max    integer;
  v_min    integer;
begin
  if auth.uid() is null then
    raise exception '请先登录后再同步成绩';
  end if;
  if p_score is null or p_score < 0 then
    raise exception '无效分数';
  end if;

  if p_game in ('schulte_3','schulte_4','schulte_5','schulte_6','schulte_7') then
    v_max := 3600000;
    v_min := 100;
  else
    v_max := case p_game
      when 'dino'  then 10000000
      when 'snake' then 100000
      when 'tfe'   then 4000000
      else null
    end;
    v_min := 1;
  end if;

  if v_max is null then
    raise exception '未知游戏类型';
  end if;
  if p_score > v_max then
    raise exception '分数超出合理范围';
  end if;
  if p_score < v_min then
    raise exception '无效成绩';
  end if;

  select exists (
    select 1 from public.users u
    where u.id = auth.uid() and 'games' = any (u.banned_features)
  ) into v_banned;
  if v_banned then
    raise exception '游戏云端成绩功能已被禁用';
  end if;

  insert into public.game_scores (user_id, game, score, updated_at)
  values (auth.uid(), p_game, p_score, now())
  on conflict (user_id, game) do update
    set score = case
                  when p_game like 'schulte\_%' then least(public.game_scores.score, excluded.score)
                  else greatest(public.game_scores.score, excluded.score)
                end,
        updated_at = now();

  return true;
end;
$$;

-- 排行榜：只包含选择公开的用户
create or replace function public.game_leaderboard(p_game text, p_limit int default 20)
returns table (
  rank bigint, user_id uuid, nick text, avatar_url text,
  score integer, is_me boolean, updated_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  with ranked as (
    select s.user_id, s.score, s.updated_at,
           row_number() over (
             order by case when public.game_is_lower_better(p_game) then s.score else -s.score end asc,
                      s.updated_at asc
           ) as rn
    from public.game_scores s
    join public.users u on u.id = s.user_id
    where s.game = p_game and u.game_public
  )
  select r.rn, r.user_id, coalesce(nullif(u.nick, ''), '用户'), u.avatar_url,
         r.score, (r.user_id = auth.uid()), r.updated_at
  from ranked r
  join public.users u on u.id = r.user_id
  where r.rn <= least(greatest(coalesce(p_limit, 20), 1), 100)
  order by r.rn;
$$;

revoke all on function public.game_leaderboard(text, int) from public;
grant execute on function public.game_leaderboard(text, int) to anon, authenticated;

-- 我的排名（榜外也能看到）
create or replace function public.game_my_rank(p_game text)
returns table (rank bigint, total bigint, score integer, joined boolean, has_score boolean)
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_rank  bigint;
  v_total bigint;
  v_score integer;
  v_pub   boolean;
begin
  if v_uid is null then
    return;
  end if;

  select u.game_public into v_pub from public.users u where u.id = v_uid;
  select s.score into v_score from public.game_scores s where s.user_id = v_uid and s.game = p_game;

  select count(*) into v_total
  from public.game_scores s join public.users u on u.id = s.user_id
  where s.game = p_game and u.game_public;

  if v_score is not null then
    select count(*) + 1 into v_rank
    from public.game_scores s join public.users u on u.id = s.user_id
    where s.game = p_game and u.game_public
      and s.user_id <> v_uid
      and case when public.game_is_lower_better(p_game)
               then s.score < v_score else s.score > v_score end;
  end if;

  return query select v_rank, coalesce(v_total, 0), v_score, coalesce(v_pub, true), v_score is not null;
end;
$$;

revoke all on function public.game_my_rank(text) from public, anon;
grant execute on function public.game_my_rank(text) to authenticated;

-- 我的各游戏最好成绩（排行榜页概览用）
create or replace function public.game_my_scores()
returns table (game text, score integer, updated_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select s.game, s.score, s.updated_at
  from public.game_scores s
  where s.user_id = auth.uid()
  order by s.game;
$$;

revoke all on function public.game_my_scores() from public, anon;
grant execute on function public.game_my_scores() to authenticated;

-- 是否参加排行榜
create or replace function public.set_game_public(p_public boolean)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  update public.users set game_public = coalesce(p_public, true) where id = auth.uid();
  return coalesce(p_public, true);
end;
$$;

revoke all on function public.set_game_public(boolean) from public, anon;
grant execute on function public.set_game_public(boolean) to authenticated;

create or replace function public.game_public()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select u.game_public from public.users u where u.id = auth.uid()), true);
$$;

revoke all on function public.game_public() from public, anon;
grant execute on function public.game_public() to authenticated;

-- 各游戏参与人数（排行榜切换栏用）
create or replace function public.game_board_stats()
returns table (game text, players bigint, best integer)
language sql
stable
security definer
set search_path = ''
as $$
  select s.game,
         count(*)::bigint,
         case when public.game_is_lower_better(s.game) then min(s.score) else max(s.score) end
  from public.game_scores s
  join public.users u on u.id = s.user_id
  where u.game_public
  group by s.game
  order by s.game;
$$;

revoke all on function public.game_board_stats() from public;
grant execute on function public.game_board_stats() to anon, authenticated;

-- ===========================================================================
-- 二、站点更新说明
-- ===========================================================================
create table if not exists public.site_releases (
  version     text primary key,
  title       text not null,
  changes     jsonb not null default '[]'::jsonb,
  released_at timestamptz not null default now(),
  active      boolean not null default true
);

alter table public.site_releases enable row level security;
drop policy if exists site_releases_read on public.site_releases;
create policy site_releases_read on public.site_releases
  for select to anon, authenticated using (active);

revoke all on public.site_releases from anon, authenticated;
grant select on public.site_releases to anon, authenticated;

create or replace function public.latest_release()
returns table (version text, title text, changes jsonb, released_at timestamptz)
language sql
stable
security definer
set search_path = ''
as $$
  select r.version, r.title, r.changes, r.released_at
  from public.site_releases r
  where r.active
  order by r.released_at desc
  limit 1;
$$;

revoke all on function public.latest_release() from public;
grant execute on function public.latest_release() to anon, authenticated;

-- 管理员发布更新说明
create or replace function public.admin_publish_release(
  p_version text, p_title text, p_changes jsonb
)
returns text
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if coalesce(btrim(p_version), '') = '' or coalesce(btrim(p_title), '') = '' then
    raise exception '版本号与标题不能为空' using errcode = '22023';
  end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'array' then
    raise exception '更新内容必须是数组' using errcode = '22023';
  end if;

  insert into public.site_releases (version, title, changes, released_at, active)
  values (btrim(p_version), btrim(p_title), p_changes, now(), true)
  on conflict (version) do update
    set title = excluded.title,
        changes = excluded.changes,
        released_at = now(),
        active = true;

  return btrim(p_version);
end;
$$;

revoke all on function public.admin_publish_release(text, text, jsonb) from public, anon;
grant execute on function public.admin_publish_release(text, text, jsonb) to authenticated;
