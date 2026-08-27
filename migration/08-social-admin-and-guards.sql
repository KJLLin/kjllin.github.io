-- =====================================================
-- KJLLin 大文件服务端验证 + 分数校验 + 管理员权限体系 + 文章广场社交功能
-- 在 Supabase SQL Editor 中运行（幂等，可重复执行）
-- =====================================================

-- ==================== 1. 大文件上传票据（一次性） ====================
-- 配合 Edge Function upload-ticket：完成 hCaptcha 后签发票据，
-- 存储触发器在上传 >5MB 文件时校验并消耗票据（服务端强制）
CREATE TABLE IF NOT EXISTS public.upload_tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  files_allowed INTEGER NOT NULL DEFAULT 1,  -- 票据可覆盖的大文件数
  issued_at TIMESTAMPTZ DEFAULT now(),
  valid_until TIMESTAMPTZ NOT NULL,
  used BOOLEAN DEFAULT false
);
ALTER TABLE public.upload_tickets ENABLE ROW LEVEL SECURITY;
-- 无任何 policy：仅 service_role（Edge Function）与 SECURITY DEFINER 触发器可读写

-- ==================== 2. 用户功能封禁（管理员后台） ====================
-- banned_features 取值：'chat'（站内信发送）/ 'discuss'（写文章/点赞/关注）
--                       'cloud'（云盘上传）/ 'games'（游戏云分数）
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS banned_features TEXT[] NOT NULL DEFAULT '{}';

-- 管理员可更新任意用户（用于封禁/解禁）
DROP POLICY IF EXISTS "users_admin_update" ON public.users;
CREATE POLICY "users_admin_update" ON public.users FOR UPDATE TO authenticated
  USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.is_admin = true)
  )
  WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.is_admin = true)
  );

-- ==================== 3. 存储上传规则触发器（服务端强制） ====================
-- ① 云盘功能封禁检查 ② >5MB 文件必须持有效票据（hCaptcha 服务端验证过）
CREATE OR REPLACE FUNCTION public.enforce_cloud_upload_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_size BIGINT;
  v_banned BOOLEAN;
  v_ticket_ok BOOLEAN;
BEGIN
  IF NEW.bucket_id NOT IN ('cloud-drive', 'cloud-drive-private') THEN
    RETURN NEW;
  END IF;

  -- ① 云盘封禁检查
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'cloud' = ANY (u.banned_features)
  ) INTO v_banned;
  IF v_banned THEN
    RAISE EXCEPTION '云盘上传功能已被禁用，请联系管理员';
  END IF;

  -- ② 大文件（>5MB）必须持有效票据
  v_size := COALESCE((NEW.metadata ->> 'size')::BIGINT, 0);
  IF v_size > 5 * 1024 * 1024 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.upload_tickets t
      WHERE t.user_id = auth.uid() AND t.used = false
        AND t.files_allowed > 0 AND t.valid_until > now()
    ) INTO v_ticket_ok;
    IF NOT v_ticket_ok THEN
      RAISE EXCEPTION '大文件上传需要先完成人机验证';
    END IF;
    -- 消耗一次票据额度（单次有效）
    UPDATE public.upload_tickets
      SET files_allowed = files_allowed - 1,
          used = (files_allowed <= 1)
      WHERE id = (
        SELECT id FROM public.upload_tickets
        WHERE user_id = auth.uid() AND used = false
          AND files_allowed > 0 AND valid_until > now()
        ORDER BY issued_at DESC LIMIT 1
      );
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_cloud_upload_rules ON storage.objects;
CREATE TRIGGER trg_cloud_upload_rules
  BEFORE INSERT ON storage.objects
  FOR EACH ROW EXECUTE FUNCTION public.enforce_cloud_upload_rules();

-- 票据过期清理（每 10 分钟）
CREATE EXTENSION IF NOT EXISTS pg_cron;
SELECT cron.unschedule('clean-expired-upload-tickets')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clean-expired-upload-tickets');
SELECT cron.schedule(
  'clean-expired-upload-tickets',
  '*/10 * * * *',
  $$DELETE FROM public.upload_tickets WHERE valid_until < now() - interval '1 day'$$
);

-- ==================== 4. game_scores 服务端分数校验（RPC） ====================
-- 撤销直插权限，仅允许通过 submit_game_score RPC（白名单 + 合理性上限 + 封禁检查）
DROP POLICY IF EXISTS "gs_insert_own" ON public.game_scores;

CREATE OR REPLACE FUNCTION public.submit_game_score(p_game TEXT, p_score INTEGER)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_banned BOOLEAN;
  v_max INTEGER;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION '请先登录后再同步成绩';
  END IF;
  IF p_score IS NULL OR p_score < 0 THEN
    RAISE EXCEPTION '无效分数';
  END IF;

  -- 游戏白名单 + 每游戏合理性上限（防伪造）
  IF p_game IN ('schulte_3', 'schulte_4', 'schulte_5', 'schulte_6', 'schulte_7') THEN
    v_max := 3600000;  -- 舒尔特：用时(秒)×100，上限 10 小时
  ELSE
    v_max := CASE p_game
      WHEN 'dino'   THEN 10000000   -- 恐龙快跑
      WHEN 'snake'  THEN 100000     -- 贪吃蛇
      WHEN 'tfe'    THEN 4000000    -- 2048
      ELSE NULL
    END;
  END IF;
  IF v_max IS NULL THEN
    RAISE EXCEPTION '未知游戏类型';
  END IF;
  IF p_game LIKE 'schulte\_%' AND p_score < 100 THEN
    RAISE EXCEPTION '无效成绩';
  END IF;
  IF p_score > v_max THEN
    RAISE EXCEPTION '分数超出合理范围';
  END IF;

  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'games' = ANY (u.banned_features)
  ) INTO v_banned;
  IF v_banned THEN
    RAISE EXCEPTION '游戏云端成绩功能已被禁用';
  END IF;

  INSERT INTO public.game_scores (user_id, game, score)
  VALUES (auth.uid(), p_game, p_score);
  RETURN TRUE;
END;
$$;

REVOKE ALL ON FUNCTION public.submit_game_score(TEXT, INTEGER) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_game_score(TEXT, INTEGER) TO authenticated;

-- ==================== 5. 文章广场：点赞 ====================
ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS likes_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS public.post_likes (
  post_id UUID NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (post_id, user_id)
);
ALTER TABLE public.post_likes ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "pl_select" ON public.post_likes;
CREATE POLICY "pl_select" ON public.post_likes FOR SELECT USING (true);
DROP POLICY IF EXISTS "pl_insert" ON public.post_likes;
CREATE POLICY "pl_insert" ON public.post_likes FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'discuss' = ANY (u.banned_features)
  )
);
DROP POLICY IF EXISTS "pl_delete" ON public.post_likes;
CREATE POLICY "pl_delete" ON public.post_likes FOR DELETE USING (auth.uid() = user_id);

-- likes_count 由触发器维护
CREATE OR REPLACE FUNCTION public.sync_post_likes_count()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE public.posts SET likes_count = likes_count + 1 WHERE id = NEW.post_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE public.posts SET likes_count = GREATEST(0, likes_count - 1) WHERE id = OLD.post_id;
  END IF;
  RETURN NULL;
END;
$$;
DROP TRIGGER IF EXISTS trg_post_likes_count ON public.post_likes;
CREATE TRIGGER trg_post_likes_count
  AFTER INSERT OR DELETE ON public.post_likes
  FOR EACH ROW EXECUTE FUNCTION public.sync_post_likes_count();

-- ==================== 6. 文章广场：关注用户 ====================
CREATE TABLE IF NOT EXISTS public.user_follows (
  follower_id UUID NOT NULL,
  followed_id UUID NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (follower_id, followed_id),
  CHECK (follower_id <> followed_id)
);
ALTER TABLE public.user_follows ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "uf_select" ON public.user_follows;
CREATE POLICY "uf_select" ON public.user_follows FOR SELECT USING (true);
DROP POLICY IF EXISTS "uf_insert" ON public.user_follows;
CREATE POLICY "uf_insert" ON public.user_follows FOR INSERT WITH CHECK (
  auth.uid() = follower_id
  AND NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'discuss' = ANY (u.banned_features)
  )
);
DROP POLICY IF EXISTS "uf_delete" ON public.user_follows;
CREATE POLICY "uf_delete" ON public.user_follows FOR DELETE USING (auth.uid() = follower_id);

-- ==================== 7. 功能封禁落到既有策略 ====================
-- 写文章封禁
DROP POLICY IF EXISTS "posts_insert" ON public.posts;
CREATE POLICY "posts_insert" ON public.posts FOR INSERT WITH CHECK (
  auth.uid() = user_id
  AND NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'discuss' = ANY (u.banned_features)
  )
);

-- 站内信封禁（发送）
DROP POLICY IF EXISTS "pm_insert" ON public.private_messages;
CREATE POLICY "pm_insert" ON public.private_messages FOR INSERT WITH CHECK (
  auth.uid() = sender_id
  AND NOT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = auth.uid() AND 'chat' = ANY (u.banned_features)
  )
);

-- 云盘上传封禁（两个桶）
DROP POLICY IF EXISTS "cloud_insert_own" ON storage.objects;
CREATE POLICY "cloud_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cloud-drive'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND 'cloud' = ANY (u.banned_features)
    )
  );

DROP POLICY IF EXISTS "cloud_private_insert_own" ON storage.objects;
CREATE POLICY "cloud_private_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cloud-drive-private'
    AND (storage.foldername(name))[1] = auth.uid()::text
    AND NOT EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND 'cloud' = ANY (u.banned_features)
    )
  );

-- ==================== 8. 公共空间全用户可见（共享视图） ====================
-- cloud-drive 本就是公开桶（URL 可直接访问），列表对所有登录用户开放；
-- 删除仍仅限文件所有者与管理员（cloud_delete_own_or_admin 不变）
DROP POLICY IF EXISTS "cloud_read_own_or_admin" ON storage.objects;
DROP POLICY IF EXISTS "cloud_read_all" ON storage.objects;
CREATE POLICY "cloud_read_all" ON storage.objects
  FOR SELECT TO authenticated
  USING (bucket_id = 'cloud-drive');
