-- =====================================================
-- 21-notifications-refactor.sql  通知中心重构
--
-- 问题：
--   1. 每条私信都 INSERT 一条通知，同一人连发 10 条就有 10 条未读
--   2. 前端 select('*') + offset 翻页，新通知到达时列表会错位
--   3. 缺少「筛选 / 统计 / 全部已读 / 清空已读」的服务端接口
-- =====================================================

-- -----------------------------------------------------
-- 1. 私信通知去重：同一发送者 30 分钟内只保留一条未读
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.create_notification(
  p_user_id uuid,
  p_actor_id uuid,
  p_type text,
  p_title text,
  p_link text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  -- 不通知自己
  IF p_actor_id IS NOT NULL AND p_actor_id = p_user_id THEN RETURN; END IF;

  -- 私信聚合：同一人已有 30 分钟内的未读私信通知，则不再新增
  IF p_type = 'pm' AND p_actor_id IS NOT NULL THEN
    IF EXISTS (
      SELECT 1 FROM public.notifications n
      WHERE n.user_id = p_user_id
        AND n.actor_id = p_actor_id
        AND n.type = 'pm'
        AND n.read IS NOT TRUE
        AND n.created_at > now() - interval '30 minutes'
    ) THEN
      RETURN;
    END IF;
  END IF;

  INSERT INTO public.notifications (user_id, actor_id, type, title, link)
  VALUES (p_user_id, p_actor_id, p_type, p_title, p_link);
END;
$$;

REVOKE ALL ON FUNCTION public.create_notification(uuid, uuid, text, text, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.create_notification(uuid, uuid, text, text, text) TO authenticated;

-- 一次性清理：同一(用户,发送者)的未读私信通知只保留最新一条
WITH ranked AS (
  SELECT id,
         row_number() OVER (PARTITION BY user_id, actor_id ORDER BY created_at DESC) AS rn
  FROM public.notifications
  WHERE type = 'pm' AND read IS NOT TRUE AND actor_id IS NOT NULL
)
DELETE FROM public.notifications n
USING ranked r
WHERE n.id = r.id AND r.rn > 1;

-- -----------------------------------------------------
-- 2. 列表：游标分页 + 类型筛选 + 未读筛选
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_list(
  p_before timestamptz DEFAULT NULL,
  p_before_id uuid DEFAULT NULL,
  p_limit integer DEFAULT 30,
  p_type text DEFAULT NULL,
  p_unread_only boolean DEFAULT false
)
RETURNS TABLE(
  id uuid,
  type text,
  title text,
  link text,
  read boolean,
  created_at timestamptz,
  actor_id uuid
)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT n.id, n.type, n.title, n.link, n.read, n.created_at, n.actor_id
  FROM public.notifications n
  WHERE auth.uid() IS NOT NULL
    AND n.user_id = auth.uid()
    AND (p_unread_only IS NOT TRUE OR n.read IS NOT TRUE)
    AND (
      p_type IS NULL OR p_type = ''
      OR n.type = p_type
      OR (p_type = 'interaction' AND n.type IN ('like', 'follow'))
    )
    AND (
      p_before IS NULL
      OR n.created_at < p_before
      OR (n.created_at = p_before AND n.id < COALESCE(p_before_id, '00000000-0000-0000-0000-000000000000'::uuid))
    )
  ORDER BY n.created_at DESC, n.id DESC
  LIMIT LEAST(GREATEST(COALESCE(p_limit, 30), 1), 100);
$$;

REVOKE ALL ON FUNCTION public.notif_list(timestamptz, uuid, integer, text, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_list(timestamptz, uuid, integer, text, boolean) TO authenticated;

-- -----------------------------------------------------
-- 3. 统计：总数 / 未读 / 各类型未读
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_stats()
RETURNS TABLE(total bigint, unread bigint, unread_pm bigint, unread_interaction bigint, unread_announce bigint)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT
    count(*)::bigint AS total,
    count(*) FILTER (WHERE read IS NOT TRUE)::bigint AS unread,
    count(*) FILTER (WHERE read IS NOT TRUE AND type = 'pm')::bigint AS unread_pm,
    count(*) FILTER (WHERE read IS NOT TRUE AND type IN ('like','follow'))::bigint AS unread_interaction,
    count(*) FILTER (WHERE read IS NOT TRUE AND type = 'announce')::bigint AS unread_announce
  FROM public.notifications
  WHERE user_id = auth.uid();
$$;

REVOKE ALL ON FUNCTION public.notif_stats() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_stats() TO authenticated;

-- -----------------------------------------------------
-- 4. 批量操作
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.notif_mark_all_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 0; END IF;
  UPDATE public.notifications
     SET read = true
   WHERE user_id = auth.uid() AND read IS NOT TRUE;
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notif_mark_all_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_mark_all_read() TO authenticated;

-- 清空已读：保留公告（公告会随公告变更同步，删了也会再生成）
CREATE OR REPLACE FUNCTION public.notif_delete_read()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE v_count integer := 0;
BEGIN
  IF auth.uid() IS NULL THEN RETURN 0; END IF;
  DELETE FROM public.notifications
   WHERE user_id = auth.uid()
     AND read IS TRUE
     AND type <> 'announce';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.notif_delete_read() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.notif_delete_read() TO authenticated;
