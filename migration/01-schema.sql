-- =====================================================
-- KJLLin Supabase 完整建表 + RLS 策略
-- 在新项目的 SQL Editor 中运行此脚本
-- =====================================================

-- 启用 UUID 扩展
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ==================== 1. users 表 ====================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  nick TEXT,
  email TEXT UNIQUE,
  is_admin BOOLEAN DEFAULT false,
  status TEXT DEFAULT 'active',
  last_login_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- RLS: 用户可读所有用户基本信息，可写自身记录
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_select" ON users FOR SELECT USING (true);
CREATE POLICY "users_insert" ON users FOR INSERT WITH CHECK (auth.uid() = id);
CREATE POLICY "users_update_own" ON users FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "users_delete_own" ON users FOR DELETE USING (auth.uid() = id);

-- ==================== 2. posts 表（文章广场） ====================
CREATE TABLE IF NOT EXISTS posts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  nick TEXT,
  title TEXT NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ
);

ALTER TABLE posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY "posts_select" ON posts FOR SELECT USING (true);
CREATE POLICY "posts_insert" ON posts FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "posts_update_own" ON posts FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "posts_delete_own" ON posts FOR DELETE USING (auth.uid() = user_id);

-- ==================== 3. private_messages 表（站内信） ====================
CREATE TABLE IF NOT EXISTS private_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id UUID NOT NULL,
  recipient_id UUID NOT NULL,
  text TEXT NOT NULL,
  read BOOLEAN DEFAULT false,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE private_messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pm_select" ON private_messages FOR SELECT
  USING (auth.uid() = sender_id OR auth.uid() = recipient_id);
CREATE POLICY "pm_insert" ON private_messages FOR INSERT
  WITH CHECK (auth.uid() = sender_id);
CREATE POLICY "pm_update_own" ON private_messages FOR UPDATE
  USING (auth.uid() = recipient_id);  -- 收件人可标记已读
CREATE POLICY "pm_delete_own" ON private_messages FOR DELETE
  USING (auth.uid() = sender_id);

-- ==================== 4. game_scores 表 ====================
CREATE TABLE IF NOT EXISTS game_scores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID,
  game TEXT NOT NULL,
  score INTEGER NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE game_scores ENABLE ROW LEVEL SECURITY;
CREATE POLICY "gs_select" ON game_scores FOR SELECT USING (true);
CREATE POLICY "gs_insert_own" ON game_scores FOR INSERT WITH CHECK (auth.uid() = user_id);

-- ==================== 5. user_blocks 表 ====================
CREATE TABLE IF NOT EXISTS user_blocks (
  blocker_id UUID NOT NULL,
  blocked_id UUID NOT NULL,
  PRIMARY KEY (blocker_id, blocked_id)
);

ALTER TABLE user_blocks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ub_select" ON user_blocks FOR SELECT
  USING (auth.uid() = blocker_id);
CREATE POLICY "ub_insert" ON user_blocks FOR INSERT
  WITH CHECK (auth.uid() = blocker_id);
CREATE POLICY "ub_delete" ON user_blocks FOR DELETE
  USING (auth.uid() = blocker_id);

-- ==================== 6. Storage Bucket ====================
-- 需要通过 Supabase Dashboard 手动创建 "cloud-drive" bucket
-- 或使用 Management API
-- Storage → New Bucket → Name: cloud-drive → Public bucket: ON
-- Storage Policy for cloud-drive:
--   SELECT: true (公开读取)
--   INSERT: auth.role() = 'authenticated'
--   UPDATE: auth.role() = 'authenticated'
--   DELETE: auth.role() = 'authenticated'

-- ==================== 7. Realtime 订阅 ====================
-- 需要在 Supabase Dashboard → Database → Replication 中
-- 为 private_messages 表启用 Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE private_messages;
