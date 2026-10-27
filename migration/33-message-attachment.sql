-- ============================================================================
-- 33-message-attachment.sql
-- 站内信「文件卡片」：消息可携带一个附件描述，前端渲染成卡片
--
-- attachment 结构：
--   { "kind":"file", "name":"xxx.docx", "size":858000,
--     "url":"https://...", "mime":"...", "note":"私有空间链接 1 小时内有效" }
-- text 仍保存文件名，用于会话列表预览与通知文案。
-- ============================================================================

alter table public.private_messages add column if not exists attachment jsonb;

alter table public.private_messages drop constraint if exists pm_attachment_shape;
alter table public.private_messages add constraint pm_attachment_shape check (
  attachment is null
  or (
    jsonb_typeof(attachment) = 'object'
    and attachment ? 'name' and attachment ? 'url'
    and length(coalesce(attachment->>'name', '')) between 1 and 200
    and length(coalesce(attachment->>'url', '')) between 8 and 2000
    and (attachment->>'url') ~ '^https://'
    and (
      not (attachment ? 'size')
      or (attachment->>'size') ~ '^[0-9]{1,12}$'
    )
    and (
      not (attachment ? 'note')
      or length(attachment->>'note') <= 100
    )
  )
);

comment on column public.private_messages.attachment is '文件卡片描述；为空表示普通文本消息';

-- 列级权限：读写都要放开 attachment
grant select (attachment) on public.private_messages to authenticated;
grant insert (attachment) on public.private_messages to authenticated;

-- 读取接口带上 attachment（返回类型变了，必须重建）
drop function if exists public.chat_messages(uuid, timestamptz, integer);

create function public.chat_messages(
  p_partner uuid,
  p_before  timestamptz default null,
  p_limit   integer default 30
)
returns table (
  id uuid, sender_id uuid, recipient_id uuid, text text,
  read boolean, created_at timestamptz, attachment jsonb
)
language sql
security definer
set search_path = ''
as $$
  select m.id, m.sender_id, m.recipient_id, m.text, m.read, m.created_at, m.attachment
  from (
    select pm.id, pm.sender_id, pm.recipient_id, pm.text, pm.read, pm.created_at, pm.attachment
    from public.private_messages pm
    where auth.uid() is not null
      and p_partner is not null
      and (
        (pm.sender_id = auth.uid() and pm.recipient_id = p_partner)
        or (pm.sender_id = p_partner and pm.recipient_id = auth.uid())
      )
      and (p_before is null or pm.created_at < p_before)
    order by pm.created_at desc
    limit least(greatest(coalesce(p_limit, 30), 1), 100)
  ) m
  order by m.created_at asc;
$$;

revoke all on function public.chat_messages(uuid, timestamptz, integer) from public, anon;
grant execute on function public.chat_messages(uuid, timestamptz, integer) to authenticated;

-- 会话列表：卡片消息预览显示「[文件] 文件名」
create or replace function public.chat_conversations()
returns table (
  partner_id uuid, nick text, is_admin boolean, avatar_url text,
  latest_text text, latest_time timestamptz, unread integer
)
language sql
security definer
set search_path = ''
as $$
  with me as (
    select auth.uid() as uid
  ),
  conv as (
    select
      case when m.sender_id = me.uid then m.recipient_id else m.sender_id end as partner_id,
      case when m.attachment is not null
           then '[文件] ' || coalesce(m.attachment->>'name', m.text)
           else m.text end as text,
      m.created_at,
      m.read,
      m.recipient_id
    from public.private_messages m, me
    where me.uid is not null
      and (m.sender_id = me.uid or m.recipient_id = me.uid)
  ),
  latest as (
    select distinct on (partner_id) partner_id, text, created_at
    from conv
    order by partner_id, created_at desc
  ),
  unread as (
    select partner_id, count(*)::integer as cnt
    from conv
    where recipient_id = (select uid from me)
      and read is not true
    group by partner_id
  )
  select
    l.partner_id,
    coalesce(u.nick, '') as nick,
    coalesce(u.is_admin, false) as is_admin,
    coalesce(u.avatar_url, '') as avatar_url,
    l.text as latest_text,
    l.created_at as latest_time,
    coalesce(r.cnt, 0) as unread
  from latest l
  left join public.users u on u.id = l.partner_id
  left join unread r on r.partner_id = l.partner_id
  order by l.created_at desc
  limit 300;
$$;

revoke all on function public.chat_conversations() from public, anon;
grant execute on function public.chat_conversations() to authenticated;
