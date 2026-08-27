-- =====================================================
-- KJLLin 迁移 15：公告同步到通知中心 + 通知自动清理
--
-- 内容：
--   1. notifications 支持 announce 类型 + announce_id 关联字段
--   2. 公告发布/停用/删除时自动向所有用户同步一条真实通知
--      （让公告出现在通知中心与铃铛未读数，而非仅靠横幅）
--   3. 自动清理：
--      - 公告被取消（停用/删除）→ 立即清掉其所有通知
--      - 已读超过 30 天的通知（含公告）→ 每日清理（沿用原 cron）
--      - 失效公告的通知（状态兜底）→ 每日清理
--
-- 幂等，可重复执行
-- =====================================================

-- ==================== 1. 通知类型扩展 ====================
ALTER TABLE public.notifications
  DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE public.notifications
  ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('pm', 'like', 'follow', 'system', 'announce'));

-- ==================== 2. announce_id 关联列 ====================
ALTER TABLE public.notifications
  ADD COLUMN IF NOT EXISTS announce_id UUID;
CREATE INDEX IF NOT EXISTS idx_notifications_announce_id
  ON public.notifications (announce_id) WHERE announce_id IS NOT NULL;

-- ==================== 3. 公告 → 通知 同步函数 ====================
-- 幂等广播：公告激活时给所有用户插入一条 announce 通知；
-- 停用/删除时清掉对应的通知。SECURITY DEFINER 以 owner 身份写入，
-- 绕过 RLS，仅做与公告 id 关联的增量同步。
CREATE OR REPLACE FUNCTION public.sync_announce_notification()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_title TEXT;
BEGIN
  v_title := COALESCE(NULLIF(NEW.title, ''), '系统公告');

  -- 发布（或发布时即启用）：广播，link 携带公告配置的外链（可跳站外）
  IF (TG_OP = 'INSERT' AND NEW.active) THEN
    INSERT INTO public.notifications (user_id, type, title, link, announce_id, read)
    SELECT u.id, 'announce', v_title, COALESCE(NEW.link, '/notifications/'), NEW.id, false
      FROM public.users u
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications np
        WHERE np.user_id = u.id AND np.announce_id = NEW.id
     );
    RETURN NEW;

  -- 停用/删除：清掉对应通知
  ELSIF (TG_OP = 'UPDATE') THEN
    IF NOT NEW.active AND OLD.active THEN
      DELETE FROM public.notifications WHERE announce_id = NEW.id;
      RETURN NEW;
    ELSIF NEW.active AND NOT OLD.active THEN
      -- 恢复启用：补齐通知（link 携带公告配置的外链）
      INSERT INTO public.notifications (user_id, type, title, link, announce_id, read)
      SELECT u.id, 'announce', v_title, COALESCE(NEW.link, '/notifications/'), NEW.id, false
        FROM public.users u
       WHERE NOT EXISTS (
         SELECT 1 FROM public.notifications np
          WHERE np.user_id = u.id AND np.announce_id = NEW.id
       );
      RETURN NEW;
    END IF;
    RETURN NEW;

  ELSIF (TG_OP = 'DELETE') THEN
    DELETE FROM public.notifications WHERE announce_id = OLD.id;
    RETURN OLD;
  END IF;

  RETURN NULL;
END;
$$;

-- ==================== 4. 触发器 ====================
DROP TRIGGER IF EXISTS trg_sync_announce_insert ON public.announcements;
CREATE TRIGGER trg_sync_announce_insert
  AFTER INSERT ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.sync_announce_notification();

DROP TRIGGER IF EXISTS trg_sync_announce_update ON public.announcements;
CREATE TRIGGER trg_sync_announce_update
  AFTER UPDATE OF active ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.sync_announce_notification();

DROP TRIGGER IF EXISTS trg_sync_announce_delete ON public.announcements;
CREATE TRIGGER trg_sync_announce_delete
  AFTER DELETE ON public.announcements
  FOR EACH ROW EXECUTE FUNCTION public.sync_announce_notification();

-- ==================== 5. 回填存量启用的公告 ====================
-- 首次执行时，把已存在的启用公告也同步给所有用户（幂等，不会重复插）
DO $$
DECLARE r RECORD; v_title TEXT;
BEGIN
  FOR r IN SELECT id, title, link FROM public.announcements WHERE active IS TRUE LOOP
    v_title := COALESCE(NULLIF(r.title, ''), '系统公告');
    INSERT INTO public.notifications (user_id, type, title, link, announce_id, read)
    SELECT u.id, 'announce', v_title, COALESCE(r.link, '/notifications/'), r.id, false
      FROM public.users u
     WHERE NOT EXISTS (
       SELECT 1 FROM public.notifications np
        WHERE np.user_id = u.id AND np.announce_id = r.id
     );
  END LOOP;
END $$;

-- ==================== 6. 自动清理（pg_cron 每日） ====================
-- a. 时间过长/已读的普通通知 → 删除：
--    - 已读超过 30 天（含 pm/like/follow/announce 等）
--    - 超过 90 天的通知（无论是否已读，如站内信等失去时效的冗余通知）
SELECT cron.unschedule('clean-old-read-notifications')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clean-old-read-notifications');
SELECT cron.schedule(
  'clean-old-read-notifications',
  '17 3 * * *',
  $$DELETE FROM public.notifications WHERE read = true AND created_at < now() - interval '30 days';
    DELETE FROM public.notifications WHERE created_at < now() - interval '90 days';$$
);

-- b. 失效（已停用/已删除）公告的通知 → 无条件清掉（公告取消的兜底）
SELECT cron.unschedule('clean-invalid-announce-notifications')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clean-invalid-announce-notifications');
SELECT cron.schedule(
  'clean-invalid-announce-notifications',
  '17 4 * * *',
  $$DELETE FROM public.notifications n
    WHERE n.type = 'announce' AND n.announce_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM public.announcements a WHERE a.id = n.announce_id AND a.active)$$
);