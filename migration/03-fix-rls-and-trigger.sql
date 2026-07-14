-- =====================================================
-- KJLLin RLS 安全加固 + 自动用户触发器
-- 在 Supabase SQL Editor 中运行此脚本
-- =====================================================

-- ==================== 1. 修复 users 表 RLS ====================
-- 问题：原策略允许任何已认证用户修改自己的 is_admin 字段

-- 修复 INSERT：强制新用户 is_admin = false
DROP POLICY IF EXISTS "users_insert" ON users;
CREATE POLICY "users_insert" ON users FOR INSERT 
  WITH CHECK (auth.uid() = id AND is_admin = false);

-- 修复 UPDATE：禁止用户自行修改 is_admin
DROP POLICY IF EXISTS "users_update_own" ON users;
CREATE POLICY "users_update_own" ON users FOR UPDATE 
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id 
    AND is_admin IS NOT DISTINCT FROM (
      SELECT u.is_admin FROM users u WHERE u.id = auth.uid()
    )
  );

-- ==================== 2. 自动触发器：auth signup → users 表 ====================
-- 解决 auth-gate 注册后 users 表无记录的问题
-- SECURITY DEFINER 绕过 RLS，无需服务端 key

CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  INSERT INTO public.users (id, nick, email, is_admin, status, created_at)
  VALUES (
    NEW.id,
    COALESCE(NEW.raw_user_meta_data ->> 'nick', split_part(NEW.email, '@', 1)),
    NEW.email,
    false,
    'active',
    NOW()
  )
  ON CONFLICT (id) DO NOTHING;
  RETURN NEW;
END;
$$;

-- 绑定到 auth.users 表的新用户创建事件
DROP TRIGGER IF EXISTS on_auth_user_created ON auth.users;
CREATE TRIGGER on_auth_user_created
  AFTER INSERT ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION public.handle_new_user();
