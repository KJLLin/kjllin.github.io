-- ============================================================================
-- 38-server-side-send.sql
-- 把「发消息」和「取公开资料」收敛到服务端函数
--
-- 背景：
--   1. 前端一直直连 private_messages 表插入，等于把「信息发送接口」开放给
--      任何持有 anon key 的人（虽然有触发器校验，但接口面本身不该暴露）。
--   2. profiles_public 是普通视图，以视图 owner 身份执行，绕过 users 的 RLS，
--      anon 可以直接把全站用户列表拉走 —— 这是「好友列表读取接口」的敞口。
--
-- 本迁移只做「建能力 + 収紧搜索」，不撤销旧权限；
-- 撤销动作放在前端切换到新接口之后执行（39），避免空窗期。
-- ============================================================================

-- ---------------------------------------------------------------- 1. 幂等列
-- 同一次点击重复提交时（网络重试 / 双击），不会再插入第二条
alter table public.private_messages
  add column if not exists client_id uuid;

create unique index if not exists pm_sender_client_uniq
  on public.private_messages (sender_id, recipient_id, client_id)
  where client_id is not null;

comment on column public.private_messages.client_id is
  '客户端生成的幂等键；同一 sender+recipient 下唯一，用于防止重复发送';

-- ---------------------------------------------------------------- 2. 服务端发送
drop function if exists public.send_message(uuid[], text, jsonb, uuid);

create function public.send_message(
  p_recipients uuid[],
  p_text text default '',
  p_attachment jsonb default null,
  p_client_id uuid default null
)
returns table (
  recipient_id uuid,
  message_id uuid,
  ok boolean,
  reason text
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := auth.uid();
  v_text text := btrim(coalesce(p_text, ''));
  v_ids  uuid[];
  v_id   uuid;
  v_mid  uuid;
  v_hit  uuid;
  v_n    integer;
begin
  if v_uid is null then
    raise exception '请先登录' using errcode = '42501';
  end if;
  if coalesce(public.i_am_banned('chat'), false) then
    raise exception '你的站内信功能已被限制' using errcode = '42501';
  end if;

  -- 收件人清洗：去空、去自己、去重
  select coalesce(array_agg(t.x), '{}'::uuid[]) into v_ids
  from (
    select distinct x
    from unnest(coalesce(p_recipients, '{}'::uuid[])) as x
    where x is not null and x <> v_uid
  ) t;

  v_n := coalesce(array_length(v_ids, 1), 0);
  if v_n = 0 then
    raise exception '请选择收件人' using errcode = '22023';
  end if;
  if v_n > 20 then
    raise exception '一次最多发送给 20 位好友' using errcode = '22023';
  end if;

  if v_text = '' and p_attachment is null then
    raise exception '不能发送空消息' using errcode = '22023';
  end if;
  if char_length(v_text) > 1000 then
    raise exception '消息不能超过 1000 个字符' using errcode = '22023';
  end if;

  foreach v_id in array v_ids loop
    -- 收件人必须真实存在（表上没有外键，由这里兜底）
    if not exists (select 1 from public.users u where u.id = v_id) then
      recipient_id := v_id; message_id := null; ok := false; reason := '收件人不存在';
      return next;
      continue;
    end if;

    -- 幂等：同一 client_id 已经发过就直接返回原消息
    if p_client_id is not null then
      select m.id into v_hit
      from public.private_messages m
      where m.sender_id = v_uid and m.recipient_id = v_id and m.client_id = p_client_id
      limit 1;
      if v_hit is not null then
        recipient_id := v_id; message_id := v_hit; ok := true; reason := 'duplicate';
        return next;
        continue;
      end if;
    end if;

    begin
      insert into public.private_messages (sender_id, recipient_id, text, attachment, client_id)
      values (v_uid, v_id, v_text, p_attachment, p_client_id)
      returning id into v_mid;

      recipient_id := v_id; message_id := v_mid; ok := true; reason := '';
      return next;

    exception
      when unique_violation then
        select m.id into v_hit
        from public.private_messages m
        where m.sender_id = v_uid and m.recipient_id = v_id and m.client_id = p_client_id
        limit 1;
        recipient_id := v_id; message_id := v_hit; ok := true; reason := 'duplicate';
        return next;

      when others then
        recipient_id := v_id; message_id := null; ok := false;
        reason := case
          when sqlerrm like '%屏蔽%'        then '对方已屏蔽你'
          when sqlerrm like '%仅接收%'      then sqlerrm
          when sqlerrm like '%频繁%'        then '操作过于频繁，请稍后重试'
          when sqlerrm like '%超过%'        then sqlerrm
          when sqlerrm like '%格式%'        then '消息格式不正确'
          else '发送失败，请稍后重试'
        end;
        return next;
    end;
  end loop;
end;
$$;

revoke all on function public.send_message(uuid[], text, jsonb, uuid) from public, anon;
grant execute on function public.send_message(uuid[], text, jsonb, uuid) to authenticated;

comment on function public.send_message(uuid[], text, jsonb, uuid) is
  '站内信统一发送出口：批量收件人、幂等、屏蔽与隐私校验、频率限制';

-- ---------------------------------------------------------------- 3. 公开资料
-- 只按已知 id 取白名单字段，无法枚举；替代可被全表拉取的 profiles_public
drop function if exists public.get_profiles(uuid[]);

create function public.get_profiles(p_ids uuid[])
returns table (
  id uuid, nick text, avatar_url text, is_admin boolean, created_at timestamptz
)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id,
         coalesce(u.nick, '') as nick,
         coalesce(u.avatar_url, '') as avatar_url,
         coalesce(u.is_admin, false) as is_admin,
         u.created_at
  from public.users u
  where p_ids is not null
    and u.id = any(p_ids[1:60]);
$$;

-- 文章作者、个人主页对未登录访客也应可见；
-- 只能按已知 uuid 查（最多 60 个），无法像原视图那样整表拉取。
revoke all on function public.get_profiles(uuid[]) from public;
grant execute on function public.get_profiles(uuid[]) to anon, authenticated;

-- ---------------------------------------------------------------- 4. 收紧搜索
-- 原来 1 个字符就能搜，等于「按字母表遍历所有昵称」。
-- 改成至少 2 个字符、最多 15 条，并保留昵称命中的排序。
drop function if exists public.chat_search_users(text);

create function public.chat_search_users(term text)
returns table (id uuid, nick text, is_admin boolean, avatar_url text, hint text)
language sql
stable
security definer
set search_path = ''
as $$
  with me as (
    select auth.uid() as uid
  ),
  t as (
    select btrim(coalesce(term, '')) as q
  )
  select
    u.id,
    coalesce(u.nick, '') as nick,
    coalesce(u.is_admin, false) as is_admin,
    coalesce(u.avatar_url, '') as avatar_url,
    case
      when lower(coalesce(u.nick, '')) = lower(t.q) then ''
      when coalesce(u.nick, '') ilike t.q || '%' then '昵称以该词开头'
      else '昵称包含该词'
    end as hint
  from public.users u, me, t
  where me.uid is not null
    and char_length(t.q) >= 2
    and u.id <> me.uid
    and (
      u.nick ilike '%' || t.q || '%'
      or lower(split_part(coalesce(u.email, ''), '@', 1)) = lower(t.q)
    )
  order by
    case when lower(coalesce(u.nick, '')) = lower(t.q) then 0
         when coalesce(u.nick, '') ilike t.q || '%' then 1
         else 2 end,
    u.nick
  limit 15;
$$;

revoke all on function public.chat_search_users(text) from public, anon;
grant execute on function public.chat_search_users(text) to authenticated;
