-- ============================================================================
-- 37-invite-card.sql
-- 站内信「对战邀请卡片」：attachment.kind = 'invite'
--
--   { "kind":"invite", "name":"石头剪刀布对战邀请",
--     "url":"https://<site>/game/rps/?invite=ABCD2345WXYZ", "note":"..." }
--
-- 结构上沿用 33-message-attachment.sql 的 pm_attachment_shape 约束
-- （只要求 name + https 链接），因此无需新增列或改约束。
-- 这里只调整会话列表的预览前缀：邀请卡片显示「[邀请]」而非「[文件]」。
-- ============================================================================

drop function if exists public.chat_conversations();

create function public.chat_conversations()
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
           then (case when m.attachment->>'kind' = 'invite' then '[邀请] ' else '[文件] ' end)
                || coalesce(m.attachment->>'name', m.text)
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
