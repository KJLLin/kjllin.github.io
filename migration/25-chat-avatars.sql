-- ============================================================================
-- 25-chat-avatars.sql
-- 站内信会话列表 / 用户搜索返回头像
--   只增列，不改原语义；DROP + CREATE 是因为 RETURNS TABLE 的列定义变了，
--   CREATE OR REPLACE 不允许改返回类型。
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
  WITH me AS (
    SELECT auth.uid() AS uid
  ),
  conv AS (
    SELECT
      CASE WHEN m.sender_id = me.uid THEN m.recipient_id ELSE m.sender_id END AS partner_id,
      m.text,
      m.created_at,
      m.read,
      m.recipient_id
    FROM public.private_messages m, me
    WHERE me.uid IS NOT NULL
      AND (m.sender_id = me.uid OR m.recipient_id = me.uid)
  ),
  latest AS (
    SELECT DISTINCT ON (partner_id) partner_id, text, created_at
    FROM conv
    ORDER BY partner_id, created_at DESC
  ),
  unread AS (
    SELECT partner_id, count(*)::integer AS cnt
    FROM conv
    WHERE recipient_id = (SELECT uid FROM me)
      AND read IS NOT TRUE
    GROUP BY partner_id
  )
  SELECT
    l.partner_id,
    COALESCE(u.nick, '') AS nick,
    COALESCE(u.is_admin, false) AS is_admin,
    COALESCE(u.avatar_url, '') AS avatar_url,
    l.text AS latest_text,
    l.created_at AS latest_time,
    COALESCE(r.cnt, 0) AS unread
  FROM latest l
  LEFT JOIN public.users u ON u.id = l.partner_id
  LEFT JOIN unread r ON r.partner_id = l.partner_id
  ORDER BY l.created_at DESC
  LIMIT 300;
$$;

revoke all on function public.chat_conversations() from public, anon;
grant execute on function public.chat_conversations() to authenticated;

drop function if exists public.chat_search_users(text);
create function public.chat_search_users(term text)
returns table (id uuid, nick text, is_admin boolean, avatar_url text, hint text)
language sql
stable
security definer
set search_path = ''
as $$
  WITH me AS (
    SELECT auth.uid() AS uid
  )
  SELECT
    u.id,
    COALESCE(u.nick, '') AS nick,
    COALESCE(u.is_admin, false) AS is_admin,
    COALESCE(u.avatar_url, '') AS avatar_url,
    CASE
      WHEN lower(COALESCE(u.nick, '')) = lower(btrim(term)) THEN ''
      WHEN COALESCE(u.nick, '') ILIKE btrim(term) || '%' THEN '昵称以该词开头'
      ELSE '昵称包含该词'
    END AS hint
  FROM public.users u, me
  WHERE me.uid IS NOT NULL
    AND u.id <> me.uid
    AND btrim(term) <> ''
    AND char_length(btrim(term)) >= 1
    AND (u.nick ILIKE '%' || btrim(term) || '%'
         OR lower(split_part(COALESCE(u.email, ''), '@', 1)) = lower(btrim(term)))
  ORDER BY
    CASE WHEN lower(COALESCE(u.nick, '')) = lower(btrim(term)) THEN 0
         WHEN COALESCE(u.nick, '') ILIKE btrim(term) || '%' THEN 1
         ELSE 2 END,
    u.nick
  LIMIT 20;
$$;

revoke all on function public.chat_search_users(text) from public, anon;
grant execute on function public.chat_search_users(text) to authenticated;
