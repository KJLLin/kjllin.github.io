-- =====================================================
-- KJLLin 云盘私有空间（cloud-drive-private 私有桶）+ pg_cron 房间清理
-- 在 Supabase SQL Editor 中运行此脚本（幂等，可重复执行）
-- =====================================================

-- ==================== 1. 私有桶 ====================
-- 私有空间：文件不提供公开 URL，预览/下载需签名 URL（仅文件所有者/管理员可列出）
INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('cloud-drive-private', 'cloud-drive-private', false, 52428800)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 52428800;

-- ==================== 2. 私有桶 RLS 策略 ====================
-- 读取（list / 签名 URL）：仅自己目录；管理员可列出全部
DROP POLICY IF EXISTS "cloud_private_read_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_private_read_own_or_admin" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cloud-drive-private'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- 上传：仅认证用户，且路径第一级目录必须是自己的 uid
DROP POLICY IF EXISTS "cloud_private_insert_own" ON storage.objects;
CREATE POLICY "cloud_private_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cloud-drive-private'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 更新：自己目录或管理员
DROP POLICY IF EXISTS "cloud_private_update_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_private_update_own_or_admin" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cloud-drive-private'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- 删除：自己目录或管理员
DROP POLICY IF EXISTS "cloud_private_delete_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_private_delete_own_or_admin" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cloud-drive-private'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- ==================== 3. pg_cron 定时清理过期 RPS 房间 ====================
-- 替代原 Edge Function Deno.cron 方案（后者与 Deno.serve 共存会报错）
CREATE EXTENSION IF NOT EXISTS pg_cron;

-- 幂等：先移除同名任务再注册
SELECT cron.unschedule('clean-expired-rps-rooms')
WHERE EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'clean-expired-rps-rooms');

SELECT cron.schedule(
  'clean-expired-rps-rooms',
  '* * * * *',
  $$UPDATE rps_rooms SET status = 'closed' WHERE status <> 'closed' AND expires_at < now()$$
);

-- ==================== 4. 过期房间清理 RPC（保持最新，前端懒清理调用） ====================
-- 旧版本签名不同，先删除再重建（幂等）
DROP FUNCTION IF EXISTS public.clean_expired_rps_rooms();
CREATE FUNCTION public.clean_expired_rps_rooms()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  n INTEGER;
BEGIN
  UPDATE rps_rooms SET status = 'closed'
  WHERE status <> 'closed' AND expires_at < now();
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;
