-- =====================================================
-- KJLLin 迁移 09：通知系统 + 已读修复 + 越权防护加固
-- 在 Supabase SQL Editor 中运行此脚本（幂等，可重复执行）
--
-- 内容：
--   1. 修复 private_messages UPDATE 策略（已读无法记录的根因：
--      旧策略 WITH CHECK 中的自连接子查询损坏，多行时必报错）
--   2. private_messages 内容保护触发器（收件人只能改 read 字段）
--   3. users 敏感列保护触发器（非管理员不能改 is_admin/banned_features 等）
--   4. posts UPDATE 策略补 WITH CHECK（防转移文章所有权）
--   5. notifications 通知表 + RLS + Realtime + 触发器（站内信/点赞/关注）
--   6. users SELECT 策略收紧（需登录才能查用户表，防匿名爬取邮箱）
--   7. pg_cron 定期清理过期已读通知
-- =====================================================

-- ==================== 1. 修复 private_messages UPDATE 策略 ====================
-- 旧线上策略 pm_update_read_only 的 WITH CHECK 子查询缺少关联条件
-- （private_messages_1.id = private_messages_1.id 恒真），表内多于一行时
-- 标量子查询返回多行 → 所有 UPDATE 报错 → 已读状态永远无法写入。
DROP POLICY IF EXISTS pm_update_read_only ON public.private_messages;
CREATE POLICY pm_update_read_only ON public.private_messages
  FOR UPDATE
  USING (auth.uid() = recipient_id)
  WITH CHECK (auth.uid() = recipient_id);

-- 历史脏数据兜底：read 为 NULL 的行按未读处理并回填
UPDATE public.private_messages SET read = false WHERE read IS NULL;

-- ==================== 2. private_messages 内容保护 ====================
-- 策略放宽后（收件人可 UPDATE），用触发器锁死除 read 外的所有列，
-- 防止收件人篡改消息正文 / 发件人 / 收件人 / 时间。
CREATE OR REPLACE FUNCTION public.pm_protect_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION '不能修改消息 ID';
  END IF;
  IF NEW.sender_id IS DISTINCT FROM OLD.sender_id
     OR NEW.recipient_id IS DISTINCT FROM OLD.recipient_id
     OR NEW.text IS DISTINCT FROM OLD.text
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION '只能修改消息的已读状态';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_pm_protect_content ON public.private_messages;
CREATE TRIGGER trg_pm_protect_content
  BEFORE UPDATE ON public.private_messages
  FOR EACH ROW EXECUTE FUNCTION public.pm_protect_content();

-- ==================== 3. users 敏感列保护（防普通用户越权） ====================
-- 旧 users_update_own 策略允许用户更新自己的任意列（仅 is_admin 受限），
-- 普通用户可自行清空 banned_features 解除封禁。此触发器在策略之上再加一道锁：
-- 非管理员不能改 id / is_admin / banned_features / created_at。
CREATE OR REPLACE FUNCTION public.users_protect_sensitive()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_is_admin BOOLEAN;
BEGIN
  IF NEW.id <> OLD.id THEN
    RAISE EXCEPTION '不能修改用户 ID';
  END IF;

  SELECT COALESCE(
    (SELECT u.is_admin FROM public.users u WHERE u.id = auth.uid()),
    false
  ) INTO v_is_admin;

  IF NOT v_is_admin THEN
    IF NEW.is_admin IS DISTINCT FROM OLD.is_admin THEN
      RAISE EXCEPTION '无权修改管理员状态';
    END IF;
    IF NEW.banned_features IS DISTINCT FROM OLD.banned_features THEN
      RAISE EXCEPTION '无权修改功能权限';
    END IF;
    IF NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION '无权修改注册时间';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_users_protect_sensitive ON public.users;
CREATE TRIGGER trg_users_protect_sensitive
  BEFORE UPDATE ON public.users
  FOR EACH ROW EXECUTE FUNCTION public.users_protect_sensitive();

-- ==================== 4. posts UPDATE 策略补 WITH CHECK ====================
-- 旧策略只有 USING，作者可把文章的 user_id 改成他人（转移所有权）。
DROP POLICY IF EXISTS posts_update_own ON public.posts;
CREATE POLICY posts_update_own ON public.posts
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ==================== 5. notifications 通知表 ====================
CREATE TABLE IF NOT EXISTS public.notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,             -- 通知接收者
  actor_id UUID,                     -- 触发者（系统通知为空）
  type TEXT NOT NULL CHECK (type IN ('pm', 'like', 'follow', 'system')),
  title TEXT NOT NULL,               -- 通知内容（生成时已拼好昵称等）
  link TEXT,                         -- 点击跳转链接
  read BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_user_read
  ON public.notifications (user_id, read, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_notifications_actor
  ON public.notifications (actor_id, type);

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notif_select_own ON public.notifications;
CREATE POLICY notif_select_own ON public.notifications
  FOR SELECT USING (auth.uid() = user_id);

-- 接收者只能标记已读；其余列由 trg_notif_protect_content 触发器锁死
DROP POLICY IF EXISTS notif_update_own ON public.notifications;
CREATE POLICY notif_update_own ON public.notifications
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);
CREATE OR REPLACE FUNCTION public.notif_protect_content()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.user_id <> OLD.user_id
     OR NEW.actor_id IS DISTINCT FROM OLD.actor_id
     OR NEW.type <> OLD.type
     OR NEW.title <> OLD.title
     OR NEW.link IS DISTINCT FROM OLD.link
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '只能修改通知的已读状态';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notif_protect_content ON public.notifications;
CREATE TRIGGER trg_notif_protect_content
  BEFORE UPDATE ON public.notifications
  FOR EACH ROW EXECUTE FUNCTION public.notif_protect_content();

DROP POLICY IF EXISTS notif_delete_own ON public.notifications;
CREATE POLICY notif_delete_own ON public.notifications
  FOR DELETE USING (auth.uid() = user_id);

GRANT SELECT, UPDATE, DELETE ON public.notifications TO authenticated;

-- Realtime：导航铃铛订阅 INSERT 事件
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND schemaname = 'public' AND tablename = 'notifications'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
  END IF;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ==================== 5.1 通知生成触发器 ====================
-- 统一入口：写入通知（跳过自己给自己触发的通知）
CREATE OR REPLACE FUNCTION public.create_notification(
  p_user_id UUID, p_actor_id UUID, p_type TEXT, p_title TEXT, p_link TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF p_user_id IS NULL THEN RETURN; END IF;
  IF p_actor_id IS NOT NULL AND p_actor_id = p_user_id THEN RETURN; END IF; -- 不通知自己
  INSERT INTO public.notifications (user_id, actor_id, type, title, link)
  VALUES (p_user_id, p_actor_id, p_type, p_title, p_link);
END;
$$;

-- 站内信：新消息 → 通知收件人
CREATE OR REPLACE FUNCTION public.notify_on_private_message()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_nick TEXT;
BEGIN
  SELECT COALESCE(NULLIF(u.nick, ''), split_part(COALESCE(u.email, '用户'), '@', 1))
    INTO v_nick FROM public.users u WHERE u.id = NEW.sender_id;
  PERFORM public.create_notification(
    NEW.recipient_id,
    NEW.sender_id,
    'pm',
    COALESCE(v_nick, '有人') || '给你发来了站内信',
    '/chat/'
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_pm ON public.private_messages;
CREATE TRIGGER trg_notify_pm
  AFTER INSERT ON public.private_messages
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_private_message();

-- 文章点赞：通知文章作者（取消点赞时删除对应未读通知，避免残留）
CREATE OR REPLACE FUNCTION public.notify_on_post_like()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_author UUID;
  v_title TEXT;
  v_nick TEXT;
BEGIN
  SELECT p.user_id, p.title INTO v_author, v_title
    FROM public.posts p WHERE p.id = NEW.post_id;
  IF v_author IS NULL OR v_author = NEW.user_id THEN RETURN NEW; END IF;

  SELECT COALESCE(NULLIF(u.nick, ''), split_part(COALESCE(u.email, '用户'), '@', 1))
    INTO v_nick FROM public.users u WHERE u.id = NEW.user_id;

  PERFORM public.create_notification(
    v_author,
    NEW.user_id,
    'like',
    COALESCE(v_nick, '有人') || ' 赞了你的文章《' || COALESCE(v_title, '无标题') || '》',
    '/discuss/view/?id=' || NEW.post_id::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_like ON public.post_likes;
CREATE TRIGGER trg_notify_like
  AFTER INSERT ON public.post_likes
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_post_like();

CREATE OR REPLACE FUNCTION public.cleanup_notification_on_unlike()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.notifications
   WHERE type = 'like' AND actor_id = OLD.user_id
     AND link = '/discuss/view/?id=' || OLD.post_id::text
     AND read = false;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_unlike ON public.post_likes;
CREATE TRIGGER trg_notify_unlike
  AFTER DELETE ON public.post_likes
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_notification_on_unlike();

-- 关注用户：通知被关注者（取关时删除对应未读通知）
CREATE OR REPLACE FUNCTION public.notify_on_follow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_nick TEXT;
BEGIN
  SELECT COALESCE(NULLIF(u.nick, ''), split_part(COALESCE(u.email, '用户'), '@', 1))
    INTO v_nick FROM public.users u WHERE u.id = NEW.follower_id;

  PERFORM public.create_notification(
    NEW.followed_id,
    NEW.follower_id,
    'follow',
    COALESCE(v_nick, '有人') || ' 关注了你',
    '/u/?id=' || NEW.follower_id::text
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_follow ON public.user_follows;
CREATE TRIGGER trg_notify_follow
  AFTER INSERT ON public.user_follows
  FOR EACH ROW EXECUTE FUNCTION public.notify_on_follow();

CREATE OR REPLACE FUNCTION public.cleanup_notification_on_unfollow()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  DELETE FROM public.notifications
   WHERE type = 'follow' AND actor_id = OLD.follower_id
     AND user_id = OLD.followed_id AND read = false;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_unfollow ON public.user_follows;
CREATE TRIGGER trg_notify_unfollow
  AFTER DELETE ON public.user_follows
  FOR EACH ROW EXECUTE FUNCTION public.cleanup_notification_on_unfollow();

-- ==================== 6. users SELECT 收紧（防匿名爬取全部邮箱） ====================
DROP POLICY IF EXISTS users_select ON public.users;
CREATE POLICY users_select ON public.users
  FOR SELECT USING (auth.uid() IS NOT NULL);

-- 公开资料视图：个人主页等场景匿名可读（仅暴露昵称/管理员标识/注册时间，不含邮箱）
CREATE OR REPLACE VIEW public.profiles_public AS
  SELECT id, nick, is_admin, created_at FROM public.users;
GRANT SELECT ON public.profiles_public TO anon, authenticated;

-- ==================== 7. pg_cron：清理 30 天前的已读通知 ====================
SELECT cron.unschedule('clean-old-read-notifications')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clean-old-read-notifications');

SELECT cron.schedule(
  'clean-old-read-notifications',
  '17 3 * * *',
  $$DELETE FROM public.notifications WHERE read = true AND created_at < now() - interval '30 days'$$
);
