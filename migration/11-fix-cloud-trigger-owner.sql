-- =====================================================
-- KJLLin 修复：云盘大文件上传 100% 后 P0001
-- 根因：存储服务以内部角色写入 storage.objects 时，request.jwt.claims 不可用，
--       触发器里 auth.uid() 恒为空，导致 >5MB 上传始终找不到票据 → P0001。
--       但 Storage 会把上传者写入 NEW.owner，因此改为以 NEW.owner 为准，auth.uid() 兜底。
-- 幂等，可重复执行（CREATE OR REPLACE FUNCTION）。
-- =====================================================

CREATE OR REPLACE FUNCTION public.enforce_cloud_upload_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid;
  v_size BIGINT;
  v_banned BOOLEAN;
  v_ticket_ok BOOLEAN;
BEGIN
  IF NEW.bucket_id NOT IN ('cloud-drive', 'cloud-drive-private') THEN
    RETURN NEW;
  END IF;

  -- 存储服务以内部角色写入时 auth.uid() 为空，但 NEW.owner 由 Storage 写入，指向上传者
  v_uid := COALESCE(NEW.owner, auth.uid());
  IF v_uid IS NULL THEN
    RAISE EXCEPTION '无法识别上传用户';
  END IF;

  -- ① 云盘封禁检查
  SELECT EXISTS (
    SELECT 1 FROM public.users u
    WHERE u.id = v_uid AND 'cloud' = ANY (u.banned_features)
  ) INTO v_banned;
  IF v_banned THEN
    RAISE EXCEPTION '云盘上传功能已被禁用，请联系管理员';
  END IF;

  -- ② 大文件（>5MB）必须持有效票据
  v_size := COALESCE((NEW.metadata ->> 'size')::BIGINT, 0);
  IF v_size > 5 * 1024 * 1024 THEN
    SELECT EXISTS (
      SELECT 1 FROM public.upload_tickets t
      WHERE t.user_id = v_uid AND t.used = false
        AND t.files_allowed > 0 AND t.valid_until > now()
    ) INTO v_ticket_ok;
    IF NOT v_ticket_ok THEN
      RAISE EXCEPTION '大文件上传需要先完成人机验证';
    END IF;
    UPDATE public.upload_tickets
      SET files_allowed = files_allowed - 1,
          used = (files_allowed <= 1)
      WHERE id = (
        SELECT id FROM public.upload_tickets
        WHERE user_id = v_uid AND used = false
          AND files_allowed > 0 AND valid_until > now()
        ORDER BY issued_at DESC LIMIT 1
      );
  END IF;

  RETURN NEW;
END;
$$;