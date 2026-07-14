-- =====================================================
-- KJLLin 云盘存储 Storage RLS 策略修复
-- 错误: new row violates row-level security policy
-- =====================================================

-- 1. 确保 cloud-drive bucket 存在并公开可访问
-- (Bucket 必须在 Supabase Dashboard 手动创建，这里只修复 RLS)

-- 2. 允许已认证用户上传文件
DROP POLICY IF EXISTS "Allow authenticated uploads" ON storage.objects;
CREATE POLICY "Allow authenticated uploads" ON storage.objects 
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'cloud-drive');

-- 3. 允许所有人（含匿名）查看文件（公开读取）
DROP POLICY IF EXISTS "Allow public read" ON storage.objects;
CREATE POLICY "Allow public read" ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'cloud-drive');

-- 4. 允许文件拥有者更新文件
DROP POLICY IF EXISTS "Allow owner update" ON storage.objects;
CREATE POLICY "Allow owner update" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'cloud-drive' AND owner = auth.uid());

-- 5. 允许文件拥有者删除文件
DROP POLICY IF EXISTS "Allow owner delete" ON storage.objects;
CREATE POLICY "Allow owner delete" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'cloud-drive' AND owner = auth.uid());
