-- =====================================================
-- KJLLin 云盘存储按用户路径隔离 + 管理员放行（SEC-002）
-- ⚠️ 此脚本已在线上执行（策略名与线上完全一致，本文件为线上真实状态的存档）
-- 对应前端：cloud/index.html（上传路径 {userId}/{timestamp}_{文件名}）
-- 前置：已执行 04-fix-storage-rls.sql（本脚本会替换其中的宽松策略）
-- =====================================================

-- 1. 删除旧的宽松策略（04 脚本创建的全桶开放策略）
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
DROP POLICY IF EXISTS "Allow public read" ON storage.objects;
DROP POLICY IF EXISTS "Allow owner update" ON storage.objects;
DROP POLICY IF EXISTS "Allow owner delete" ON storage.objects;

-- 2. 读取（list API）：仅能列出自己目录下的文件；管理员可列出全部
--    说明：cloud-drive 为 public bucket，公开 URL 下载不走 RLS；
--    此策略仅约束 Storage list API，实现"列表按用户隔离"。
DROP POLICY IF EXISTS "cloud_read_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_read_own_or_admin" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cloud-drive'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- 3. 上传：仅认证用户，且路径第一级目录必须是自己的 uid
DROP POLICY IF EXISTS "cloud_insert_own" ON storage.objects;
CREATE POLICY "cloud_insert_own" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cloud-drive'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );

-- 4. 更新：自己目录或管理员
DROP POLICY IF EXISTS "cloud_update_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_update_own_or_admin" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cloud-drive'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- 5. 删除：自己目录或管理员（管理员可管理所有用户文件）
DROP POLICY IF EXISTS "cloud_delete_own_or_admin" ON storage.objects;
CREATE POLICY "cloud_delete_own_or_admin" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cloud-drive'
    AND (
      (storage.foldername(name))[1] = auth.uid()::text
      OR EXISTS (
        SELECT 1 FROM public.users u
        WHERE u.id = auth.uid() AND u.is_admin = true
      )
    )
  );

-- 6. rps_rooms 表（若尚未创建，联机对战需要；已存在则跳过报错无妨）
--    前端依赖字段：code/host_id/host_nick/invite_only/invited_users/expires_at/
--    status/joined_by/host_move/guest_move/round_status
CREATE TABLE IF NOT EXISTS rps_rooms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code TEXT UNIQUE NOT NULL,
  host_id UUID NOT NULL,
  host_nick TEXT,
  invite_only BOOLEAN DEFAULT false,
  invited_users UUID[] DEFAULT '{}',
  expires_at TIMESTAMPTZ NOT NULL,
  status TEXT DEFAULT 'waiting',
  joined_by UUID,
  host_move TEXT,
  guest_move TEXT,
  round_status TEXT DEFAULT 'waiting',
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE rps_rooms ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "rps_select" ON rps_rooms;
CREATE POLICY "rps_select" ON rps_rooms FOR SELECT USING (true);
DROP POLICY IF EXISTS "rps_insert" ON rps_rooms;
CREATE POLICY "rps_insert" ON rps_rooms FOR INSERT
  WITH CHECK (auth.uid() = host_id);
DROP POLICY IF EXISTS "rps_update" ON rps_rooms;
CREATE POLICY "rps_update" ON rps_rooms FOR UPDATE
  USING (auth.uid() = host_id OR auth.uid() = joined_by OR joined_by IS NULL);

-- 7. rps_rooms 开启 Realtime（postgres_changes 揭晓依赖）
--    注意：还需在 Dashboard → Database → Replication 将 rps_rooms 加入
--    supabase_realtime publication，并设置 REPLICA IDENTITY FULL：
--    ALTER PUBLICATION supabase_realtime ADD TABLE rps_rooms;
--    ALTER TABLE rps_rooms REPLICA IDENTITY FULL;

-- 8. 过期房间清理 RPC（前端创建房间时懒清理调用；room-cleaner 函数亦可）
CREATE OR REPLACE FUNCTION public.clean_expired_rps_rooms()
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
