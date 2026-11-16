-- 46 · Coil 线圈加入云端排行榜
-- 1) submit_game_score 增加 coil 分数区间
-- 2) 排行榜 RPC 无需改动（coil 越高越好，走默认分支）

create or replace function public.submit_game_score(p_game text, p_score integer)
 returns boolean
 language plpgsql
 security definer
 set search_path to ''
as $function$
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
      when 'coil'  then 200000
      else null
    end;
    -- Coil 开局撞死就是 0 分，允许 0 入榜
    v_min := case p_game when 'coil' then 0 else 1 end;
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
$function$;
