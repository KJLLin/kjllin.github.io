-- ============================================================================
-- 41-user-prefs.sql
-- 账号偏好云同步（主题 / 阅读字号 / 资讯组件偏好）
--
-- 背景
--   这些偏好原本只存在 localStorage，换设备就没了；而首页组件布局早就有
--   home_layouts 表在同步，体验割裂。
--
-- 设计
--   1. 一个用户一行，prefs 是一个受限的小对象，只允许下列键：
--        theme            'auto' | 'light' | 'dark'
--        read_fs          0 | 1 | 2
--        news_dismissed   0 | 1        （首页资讯组件被手动移除的标记）
--      服务端逐键白名单校验，多余键直接丢弃 —— 客户端塞不进任意 JSON。
--   2. client_ts 由客户端写入，跨设备 last-write-wins；与前几轮一样做
--      「未来时间戳钳制」，避免一次错误的大值把写入永久锁死。
--   3. 表对 anon / authenticated 全部收回权限，只通过 get_prefs / save_prefs 读写。
--   4. 未登录用户的偏好在本地打 touched 标记，登录时由前端询问是否合并，
--      服务端不参与这个决策，只提供「当前云端是什么」。
-- ============================================================================

create table if not exists public.user_prefs (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  prefs      jsonb       not null default '{}'::jsonb,
  client_ts  bigint      not null default 0,
  updated_at timestamptz not null default now(),
  constraint user_prefs_shape check (
        jsonb_typeof(prefs) = 'object'
    and length(prefs::text) <= 2048
  )
);

comment on table  public.user_prefs           is '账号偏好（主题/字号/资讯组件），跨设备同步';
comment on column public.user_prefs.client_ts is '客户端更新时间戳(ms)，last-write-wins 依据';

alter table public.user_prefs enable row level security;

-- 表不直接对客户端开放
revoke all on public.user_prefs from public;
revoke all on public.user_prefs from anon;
revoke all on public.user_prefs from authenticated;

-- updated_at 由服务端接管
create or replace function public.user_prefs_touch()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists trg_user_prefs_touch on public.user_prefs;
create trigger trg_user_prefs_touch
  before update on public.user_prefs
  for each row execute function public.user_prefs_touch();

revoke all on function public.user_prefs_touch() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 读取
-- ---------------------------------------------------------------------------
create or replace function public.get_prefs()
returns table (prefs jsonb, client_ts bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p.prefs, '{}'::jsonb), coalesce(p.client_ts, 0)
  from (select auth.uid() as uid) me
  left join public.user_prefs p on p.user_id = me.uid
  where me.uid is not null;
$$;

revoke all on function public.get_prefs() from public, anon;
grant execute on function public.get_prefs() to authenticated;

-- ---------------------------------------------------------------------------
-- 写入（带白名单清洗 + 单调保护）
-- ---------------------------------------------------------------------------
create or replace function public.save_prefs(p_prefs jsonb, p_client_ts bigint)
returns table (applied boolean, prefs jsonb, client_ts bigint)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid    uuid := auth.uid();
  v_clean  jsonb := '{}'::jsonb;
  v_ts     bigint;
  v_now    bigint;
  v_row    public.user_prefs%rowtype;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'invalid prefs' using errcode = '22023';
  end if;

  -- 逐键白名单：能识别的留下，其余静默丢弃
  if (p_prefs ? 'theme') then
    if (p_prefs ->> 'theme') in ('auto', 'light', 'dark') then
      v_clean := v_clean || jsonb_build_object('theme', p_prefs ->> 'theme');
    end if;
  end if;

  if (p_prefs ? 'read_fs') then
    if (p_prefs ->> 'read_fs') in ('0', '1', '2') then
      v_clean := v_clean || jsonb_build_object('read_fs', (p_prefs ->> 'read_fs')::int);
    end if;
  end if;

  if (p_prefs ? 'news_dismissed') then
    if (p_prefs ->> 'news_dismissed') in ('0', '1', 'true', 'false') then
      v_clean := v_clean || jsonb_build_object(
        'news_dismissed',
        case when (p_prefs ->> 'news_dismissed') in ('1', 'true') then 1 else 0 end
      );
    end if;
  end if;

  v_now := (extract(epoch from now()) * 1000)::bigint;
  v_ts  := coalesce(p_client_ts, 0);
  -- 超前一天的时间戳一律按当前时间处理，防止一次错误的大值锁死后续写入
  if v_ts > v_now + 86400000 then
    v_ts := v_now;
  end if;

  insert into public.user_prefs as up (user_id, prefs, client_ts)
  values (v_uid, v_clean, v_ts)
  on conflict (user_id) do update
    set prefs     = excluded.prefs,
        client_ts = excluded.client_ts
    where up.client_ts <= excluded.client_ts
  returning * into v_row;

  if not found then
    -- 云端已有更新的一份：把现状返回给客户端，让它自己对齐
    select * into v_row from public.user_prefs p where p.user_id = v_uid;
    if not found then
      return query select false, '{}'::jsonb, 0::bigint;
      return;
    end if;
    return query select false, coalesce(v_row.prefs, '{}'::jsonb), coalesce(v_row.client_ts, 0);
    return;
  end if;

  return query select true, coalesce(v_row.prefs, '{}'::jsonb), coalesce(v_row.client_ts, 0);
end;
$$;

revoke all on function public.save_prefs(jsonb, bigint) from public, anon;
grant execute on function public.save_prefs(jsonb, bigint) to authenticated;
