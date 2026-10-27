-- ============================================================================
-- 30-notif-prefs.sql
-- 通知偏好：按功能类型选择收/不收
--
-- 类型取值（与前端一致）：pm / like / follow / announce / system
-- 存储：users.notif_prefs jsonb，缺失的键视为「接收」，所以老用户默认全开。
-- 写入口只有 save_notif_prefs()，客户端改不了 users 表本身。
--
-- 附带：站内信单条长度上限从 2000 降到 1000（前端输入框同步调整）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 偏好字段
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists notif_prefs jsonb not null default '{}'::jsonb;

comment on column public.users.notif_prefs is '通知偏好：{"pm":false} 表示不收私信通知；缺省视为接收';

-- ---------------------------------------------------------------------------
-- 2. 是否应该发通知（缺省 true）
-- ---------------------------------------------------------------------------
create or replace function public.should_notify(p_uid uuid, p_type text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select (u.notif_prefs ->> p_type)::boolean from public.users u where u.id = p_uid),
    true
  );
$$;

revoke all on function public.should_notify(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. 统一出口加拦截
-- ---------------------------------------------------------------------------
create or replace function public.create_notification(p_user_id uuid, p_actor_id uuid, p_type text, p_title text, p_link text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user_id is null then return; end if;
  -- 不通知自己
  if p_actor_id is not null and p_actor_id = p_user_id then return; end if;
  -- 用户关闭了这一类通知
  if not public.should_notify(p_user_id, p_type) then return; end if;

  -- 私信聚合：同一人已有 30 分钟内的未读私信通知，则不再新增
  if p_type = 'pm' and p_actor_id is not null then
    if exists (
      select 1 from public.notifications n
      where n.user_id = p_user_id
        and n.actor_id = p_actor_id
        and n.type = 'pm'
        and n.read is not true
        and n.created_at > now() - interval '30 minutes'
    ) then
      return;
    end if;
  end if;

  insert into public.notifications (user_id, actor_id, type, title, link)
  values (p_user_id, p_actor_id, p_type, p_title, p_link);
end;
$$;

-- 公告是批量直插，单独加条件
create or replace function public.sync_announce_notification()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_title text;
begin
  v_title := coalesce(nullif(new.title, ''), '系统公告');

  if (tg_op = 'INSERT' and new.active) then
    insert into public.notifications (user_id, type, title, link, announce_id, read)
    select u.id, 'announce', v_title, coalesce(new.link, '/notifications/'), new.id, false
      from public.users u
     where public.should_notify(u.id, 'announce')
       and not exists (
         select 1 from public.notifications np
          where np.user_id = u.id and np.announce_id = new.id
       );
    return new;

  elsif (tg_op = 'UPDATE') then
    if not new.active and old.active then
      delete from public.notifications where announce_id = new.id;
      return new;
    elsif new.active and not old.active then
      insert into public.notifications (user_id, type, title, link, announce_id, read)
      select u.id, 'announce', v_title, coalesce(new.link, '/notifications/'), new.id, false
        from public.users u
       where public.should_notify(u.id, 'announce')
         and not exists (
           select 1 from public.notifications np
            where np.user_id = u.id and np.announce_id = new.id
         );
      return new;
    end if;
    return new;

  elsif (tg_op = 'DELETE') then
    delete from public.notifications where announce_id = old.id;
    return old;
  end if;

  return null;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. 读写接口
-- ---------------------------------------------------------------------------
create or replace function public.notif_prefs()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select u.notif_prefs from public.users u where u.id = auth.uid()), '{}'::jsonb);
$$;

revoke all on function public.notif_prefs() from public, anon;
grant execute on function public.notif_prefs() to authenticated;

create or replace function public.save_notif_prefs(p_prefs jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid := auth.uid();
  v_clean jsonb := '{}'::jsonb;
  v_key   text;
  v_val   text;
begin
  if v_uid is null then
    raise exception 'not authenticated' using errcode = '28000';
  end if;
  if p_prefs is null or jsonb_typeof(p_prefs) <> 'object' then
    raise exception 'invalid prefs' using errcode = '22023';
  end if;

  for v_key, v_val in select * from jsonb_each_text(p_prefs) loop
    if v_key not in ('pm', 'like', 'follow', 'announce', 'system') then continue; end if;
    if v_val not in ('true', 'false') then continue; end if;
    v_clean := v_clean || jsonb_build_object(v_key, v_val::boolean);
  end loop;

  update public.users set notif_prefs = v_clean where id = v_uid;
  return v_clean;
end;
$$;

revoke all on function public.save_notif_prefs(jsonb) from public, anon;
grant execute on function public.save_notif_prefs(jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. 站内信单条上限 2000 → 1000（前端输入框同步为 1000）
--    已有超长消息不删除，只约束新写入；因此先截断校验改为「仅新数据」
-- ---------------------------------------------------------------------------
alter table public.private_messages drop constraint if exists pm_text_length;
alter table public.private_messages
  add constraint pm_text_length check (char_length(text) between 1 and 1000) not valid;

-- 历史数据若有超 1000 的，保留不动（not valid 表示只对新增/修改生效）
