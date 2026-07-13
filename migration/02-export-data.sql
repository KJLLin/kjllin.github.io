-- =====================================================
-- 数据导出脚本
-- 在旧项目 (ap-southeast-2) 的 SQL Editor 中运行
-- 将输出的 INSERT 语句复制到新项目中执行
-- =====================================================

-- 注意：password hashes 无法迁移，用户需要在新项目重新设置密码
-- Supabase auth.users 表数据也无法直接导出

-- ==================== users 表数据 ====================
SELECT
  'INSERT INTO users (id, nick, email, is_admin, status, created_at) VALUES (' ||
  quote_literal(id) || ', ' ||
  quote_nullable(nick) || ', ' ||
  quote_nullable(email) || ', ' ||
  COALESCE(is_admin::text, 'false') || ', ' ||
  quote_nullable(status) || ', ' ||
  quote_nullable(created_at::text) || ');'
FROM users
ORDER BY created_at;

-- ==================== posts 表数据 ====================
SELECT
  'INSERT INTO posts (id, user_id, nick, title, content, created_at) VALUES (' ||
  quote_literal(id) || ', ' ||
  quote_literal(user_id) || ', ' ||
  quote_nullable(nick) || ', ' ||
  quote_literal(title) || ', ' ||
  quote_nullable(content) || ', ' ||
  quote_nullable(created_at::text) || ');'
FROM posts
ORDER BY created_at;

-- ==================== private_messages 表数据 ====================
SELECT
  'INSERT INTO private_messages (id, sender_id, recipient_id, text, read, created_at) VALUES (' ||
  quote_literal(id) || ', ' ||
  quote_literal(sender_id) || ', ' ||
  quote_literal(recipient_id) || ', ' ||
  quote_literal(text) || ', ' ||
  COALESCE(read::text, 'false') || ', ' ||
  quote_nullable(created_at::text) || ');'
FROM private_messages
ORDER BY created_at;

-- ==================== game_scores 表数据 ====================
SELECT
  'INSERT INTO game_scores (id, user_id, game, score, created_at) VALUES (' ||
  quote_literal(id) || ', ' ||
  quote_nullable(user_id) || ', ' ||
  quote_literal(game) || ', ' ||
  score::text || ', ' ||
  quote_nullable(created_at::text) || ');'
FROM game_scores
ORDER BY created_at;

-- ==================== user_blocks 表数据 ====================
SELECT
  'INSERT INTO user_blocks (blocker_id, blocked_id) VALUES (' ||
  quote_literal(blocker_id) || ', ' ||
  quote_literal(blocked_id) || ');'
FROM user_blocks;
