-- ============================================================================
-- 23-home-layouts.sql
-- 首页小组件排版云端存储（跨设备同步）
--
-- 设计要点
--   1. 一个用户一行（user_id 主键），layout 为组件 id 的有序数组。
--   2. 只存 id 顺序，不存任何展示数据/统计值 —— 统计仍由各 RPC 实时取。
--   3. client_ts 由客户端写入，用于跨设备判定「谁更新」；
--      updated_at 由服务端 now() 覆盖，仅作审计，不参与比较（避免时钟域混用）。
--   4. 前端不直接访问表：只通过 get_home_layout / save_home_layout 两个
--      SECURITY DEFINER 函数读写，表权限对 anon / authenticated 全部收回。
--   5. save_home_layout 带 client_ts 单调保护，慢网络下的旧请求不会覆盖新排版。
-- ============================================================================

create table if not exists public.home_layouts (
  user_id    uuid primary key references auth.users(id) on delete cascade,
  layout     jsonb       not null default '[]'::jsonb,
  client_ts  bigint      not null default 0,
  updated_at timestamptz not null default now(),
  constraint home_layouts_shape check (
        jsonb_typeof(layout) = 'array'
    and jsonb_array_length(layout) between 1 and 40
    and not jsonb_path_exists(layout, '$[*] ? (@.type() != "string" || @.size() > 40)')
  )
);

comment on table  public.home_layouts            is '首页小组件排版（仅组件 id 顺序）';
comment on column public.home_layouts.client_ts  is '客户端更新时间戳(ms)，跨设备 last-write-wins 依据';
comment on column public.home_layouts.updated_at is '服务端落库时间，仅审计';

alter table public.home_layouts enable row level security;

drop policy if exists home_layouts_select on public.home_layouts;
drop policy if exists home_layouts_insert on public.home_layouts;
drop policy if exists home_layouts_update on public.home_layouts;
drop policy if exists home_layouts_delete on public.home_layouts;

create policy home_layouts_select on public.home_layouts
  for select to authenticated using (auth.uid() = user_id);
create policy home_layouts_insert on public.home_layouts
  for insert to authenticated with check (auth.uid() = user_id);
create policy home_layouts_update on public.home_layouts
  for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id);
create policy home_layouts_delete on public.home_layouts
  for delete to authenticated using (auth.uid() = user_id);

-- 表本身不对客户端开放，一切读写走函数
revoke all on public.home_layouts from public;
revoke all on public.home_layouts from anon;
revoke all on public.home_layouts from authenticated;

-- updated_at 强制由服务端接管，客户端无法伪造
create or replace function public.home_layouts_touch()
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

drop trigger if exists trg_home_layouts_touch on public.home_layouts;
create trigger trg_home_layouts_touch
  before insert or update on public.home_layouts
  for each row execute function public.home_layouts_touch();

-- ---------------------------------------------------------------------------
-- 读：返回当前用户的一行（无行则由前端决定初始化）
-- ---------------------------------------------------------------------------
create or replace function public.get_home_layout()
returns table (layout jsonb, client_ts bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select h.layout, h.client_ts
  from public.home_layouts h
  where h.user_id = auth.uid();
$$;

-- ---------------------------------------------------------------------------
-- 写：upsert，且拒绝比库里更旧的 client_ts
-- ---------------------------------------------------------------------------
create or replace function public.save_home_layout(
  p_layout    jsonb,
  p_client_ts bigint default 0
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_ts  bigint := coalesce(nullif(p_client_ts, 0), (extract(epoch from now()) * 1000)::bigint);
  v_hit int := 0;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;

  if p_layout is null
     or jsonb_typeof(p_layout) <> 'array'
     or jsonb_array_length(p_layout) < 1
     or jsonb_array_length(p_layout) > 40 then
    raise exception 'invalid layout' using errcode = '22023';
  end if;

  insert into public.home_layouts as h (user_id, layout, client_ts)
  values (v_uid, p_layout, v_ts)
  on conflict (user_id) do update
    set layout    = excluded.layout,
        client_ts = excluded.client_ts
    where h.client_ts <= excluded.client_ts;

  get diagnostics v_hit = row_count;

  return jsonb_build_object('ok', true, 'applied', v_hit > 0, 'client_ts', v_ts);
end;
$$;

revoke all on function public.get_home_layout() from public, anon;
revoke all on function public.save_home_layout(jsonb, bigint) from public, anon;
grant execute on function public.get_home_layout() to authenticated;
grant execute on function public.save_home_layout(jsonb, bigint) to authenticated;

-- 旧版本辅助函数若存在则清理
drop function if exists public.home_layout_meta();
