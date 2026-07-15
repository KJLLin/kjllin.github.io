-- CPOAuth 第三方登录 — 数据库迁移
-- 在 Supabase SQL Editor 中执行: https://supabase.com/dashboard/project/vzqspcuxnwpakofwumat/sql/new

-- 1. 为 users 表添加 CPOAuth 绑定字段
ALTER TABLE public.users 
  ADD COLUMN IF NOT EXISTS cpoauth_sub text UNIQUE,
  ADD COLUMN IF NOT EXISTS cpoauth_linked_at timestamptz,
  ADD COLUMN IF NOT EXISTS cpoauth_username text;

-- 2. 创建索引加速查询
CREATE INDEX IF NOT EXISTS idx_users_cpoauth_sub ON public.users(cpoauth_sub) WHERE cpoauth_sub IS NOT NULL;

-- 3. RLS 策略：允许用户更新自己的 CPOAuth 绑定字段
-- (如果已有 users 表的 RLS 策略，这条可能需要调整)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_policies 
    WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'Users can update own cpoauth fields'
  ) THEN
    CREATE POLICY "Users can update own cpoauth fields" ON public.users
      FOR UPDATE USING (auth.uid() = id)
      WITH CHECK (auth.uid() = id);
  END IF;
END $$;

-- 验证
-- SELECT id, email, cpoauth_sub, cpoauth_username FROM public.users WHERE cpoauth_sub IS NOT NULL;
