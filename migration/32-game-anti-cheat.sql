-- ============================================================================
-- 32-game-anti-cheat.sql
-- 1) 成绩提交防刷：频率限制 + 提交日志
-- 2) 舒尔特方格排行榜只统计 5×5（其他规格仍然记录个人成绩，但不进榜）
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 提交日志（客户端不可见）
-- ---------------------------------------------------------------------------
create table if not exists public.game_submit_log (
  id      bigserial primary key,
  user_id uuid not null references public.users(id) on delete cascade,
  game    text not null,
  score   integer not null,
  at      timestamptz not null default now()
);

create index if not exists game_submit_log_user_at_idx on public.game_submit_log (user_id, at desc);

alter table public.game_submit_log enable row level security;
revoke all on public.game_submit_log from anon, authenticated, public;

-- ---------------------------------------------------------------------------
-- 2. 提交成绩：加频率限制
-- ---------------------------------------------------------------------------
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
  v_recent integer;
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

  -- 频率限制：60 秒内最多 6 次提交（正常一局远超 10 秒）
  select count(*) into v_recent
  from public.game_submit_log g
  where g.user_id = auth.uid() and g.at > now() - interval '60 seconds';

  if v_recent >= 6 then
    raise exception '提交过于频繁，请稍后再试';
  end if;

  insert into public.game_submit_log (user_id, game, score) values (auth.uid(), p_game, p_score);

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

-- ---------------------------------------------------------------------------
-- 3. 排行榜只统计舒尔特 5×5
-- ---------------------------------------------------------------------------
create or replace function public.game_leaderboard(p_game text, p_limit int default 20)
returns table (
  rank bigint, user_id uuid, nick text, avatar_url text,
  score integer, is_me boolean, updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- 舒尔特只有 5×5 上公开榜，其余规格只保留个人成绩
  if p_game like 'schulte\_%' and p_game <> 'schulte_5' then
    return;
  end if;

  return query
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
end;
$$;

revoke all on function public.game_leaderboard(text, int) from public;
grant execute on function public.game_leaderboard(text, int) to anon, authenticated;

-- 榜单统计同样只算 5×5
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
    and (s.game not like 'schulte\_%' or s.game = 'schulte_5')
  group by s.game
  order by s.game;
$$;

revoke all on function public.game_board_stats() from public;
grant execute on function public.game_board_stats() to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. 日志清理（7 天）
-- ---------------------------------------------------------------------------
do $$
declare
  v_job bigint;
begin
  for v_job in select jobid from cron.job where jobname = 'clean-game-submit-log' loop
    perform cron.unschedule(v_job);
  end loop;
end $$;

select cron.schedule('clean-game-submit-log', '23 5 * * *',
  $$delete from public.game_submit_log where at < now() - interval '7 days';$$);
