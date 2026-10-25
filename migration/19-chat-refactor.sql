-- =====================================================
-- 19-chat-refactor.sql  站内信深度重构
--
-- 目标：
--   1. 服务端强制消息长度（不能只靠前端 maxlength）
--   2. 会话列表由数据库聚合，替代「拉 500 条消息在前端归并」
--   3. 消息分页（游标），替代一次性拉 200 条
--   4. 用户搜索改为 SECURITY DEFINER RPC，返回脱敏提示，
--      避免登录用户直接扫 users 表拿到所有人的 email / phone
--   5. Realtime 支持已读回执（UPDATE）与删除同步
-- =====================================================

-- -----------------------------------------------------
-- 1. 消息长度约束
-- -----------------------------------------------------
ALTER TABLE public.private_messages
  DROP CONSTRAINT IF EXISTS pm_text_length;
ALTER TABLE public.private_messages
  ADD CONSTRAINT pm_text_length
  CHECK (char_length(text) >= 1 AND char_length(text) <= 2000);

-- -----------------------------------------------------
-- 2. Realtime：UPDATE / DELETE 需要完整旧记录才能按行过滤
-- -----------------------------------------------------
ALTER TABLE public.private_messages REPLICA IDENTITY FULL;

-- -----------------------------------------------------
-- 3. 会话列表：一次查询得到「对端 + 最新一条 + 未读数」
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_conversations()
RETURNS TABLE(
  partner_id uuid,
  nick text,
  is_admin boolean,
  latest_text text,
  latest_time timestamptz,
  unread integer
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
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
    l.text AS latest_text,
    l.created_at AS latest_time,
    COALESCE(r.cnt, 0) AS unread
  FROM latest l
  LEFT JOIN public.users u ON u.id = l.partner_id
  LEFT JOIN unread r ON r.partner_id = l.partner_id
  ORDER BY l.created_at DESC
  LIMIT 300;
$$;

-- -----------------------------------------------------
-- 4. 消息分页（游标：取比 p_before 更早的 N 条，返回时间正序）
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_messages(
  p_partner uuid,
  p_before timestamptz DEFAULT NULL,
  p_limit integer DEFAULT 30
)
RETURNS TABLE(
  id uuid,
  sender_id uuid,
  recipient_id uuid,
  text text,
  read boolean,
  created_at timestamptz
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT m.id, m.sender_id, m.recipient_id, m.text, m.read, m.created_at
  FROM (
    SELECT pm.id, pm.sender_id, pm.recipient_id, pm.text, pm.read, pm.created_at
    FROM public.private_messages pm
    WHERE auth.uid() IS NOT NULL
      AND p_partner IS NOT NULL
      AND (
        (pm.sender_id = auth.uid() AND pm.recipient_id = p_partner)
        OR (pm.sender_id = p_partner AND pm.recipient_id = auth.uid())
      )
      AND (p_before IS NULL OR pm.created_at < p_before)
    ORDER BY pm.created_at DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100)
  ) m
  ORDER BY m.created_at ASC;
$$;

-- -----------------------------------------------------
-- 5. 标记会话已读（返回实际更新条数）
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_mark_read(p_partner uuid)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_count integer := 0;
BEGIN
  IF v_uid IS NULL OR p_partner IS NULL THEN
    RETURN 0;
  END IF;

  UPDATE public.private_messages
     SET read = true
   WHERE recipient_id = v_uid
     AND sender_id = p_partner
     AND read IS NOT TRUE;

  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

-- -----------------------------------------------------
-- 6. 用户搜索：只返回 id / 昵称 / 管理员标识 / 脱敏提示
--    不返回 email、phone 原值，避免登录用户批量抓取
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.chat_search_users(p_term text)
RETURNS TABLE(id uuid, nick text, is_admin boolean, hint text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_term text := btrim(COALESCE(p_term, ''));
  v_norm text;
  v_local text;
  v_domain text;
  v_pattern text;
BEGIN
  IF v_uid IS NULL OR char_length(v_term) < 2 THEN
    RETURN;
  END IF;
  IF char_length(v_term) > 100 THEN
    v_term := left(v_term, 100);
  END IF;

  -- 手机号规范化：大陆 11 位补 +86
  v_norm := regexp_replace(v_term, '[\s\-()]', '', 'g');
  IF v_norm ~ '^1[3-9][0-9]{9}$' THEN
    v_norm := '+86' || v_norm;
  ELSIF v_norm !~ '^\+[0-9]{6,15}$' THEN
    v_norm := '';
  END IF;

  -- 邮箱匹配模式（对 % _ \ 做转义，避免用户输入被当成通配符）
  IF position('@' IN v_term) > 0 THEN
    v_local  := split_part(v_term, '@', 1);
    v_domain := split_part(v_term, '@', 2);
    IF v_local = '' THEN
      RETURN;
    END IF;
    v_local  := replace(replace(replace(v_local,  '\', '\\'), '%', '\%'), '_', '\_');
    v_domain := replace(replace(replace(v_domain, '\', '\\'), '%', '\%'), '_', '\_');
    v_pattern := v_local || '@' || v_domain || '%';
  ELSE
    v_pattern := replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '@%';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    COALESCE(u.nick, '') AS nick,
    COALESCE(u.is_admin, false) AS is_admin,
    CASE
      WHEN u.email IS NOT NULL AND u.email <> '' THEN
        left(u.email, 1) || '***@' || split_part(u.email, '@', 2)
      WHEN u.phone IS NOT NULL AND u.phone <> '' THEN
        left(u.phone, 3) || '****' || right(u.phone, 2)
      ELSE ''
    END AS hint
  FROM public.users u
  WHERE u.id <> v_uid
    AND (
      u.email ILIKE v_pattern
      OR (v_norm <> '' AND u.phone = v_norm)
      OR u.nick = v_term
    )
  ORDER BY (u.nick = v_term) DESC, u.nick NULLS LAST
  LIMIT 8;
END;
$$;

-- -----------------------------------------------------
-- 7. 权限：仅登录用户可执行，anon 一律拒绝
-- -----------------------------------------------------
REVOKE ALL ON FUNCTION public.chat_conversations() FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_messages(uuid, timestamptz, integer) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_mark_read(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.chat_search_users(text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.chat_conversations() TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_messages(uuid, timestamptz, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_mark_read(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.chat_search_users(text) TO authenticated;
