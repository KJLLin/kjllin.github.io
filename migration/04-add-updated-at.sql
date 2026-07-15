-- =====================================================
-- 添加 posts 表 updated_at 列
-- 支持讨论帖编辑时间追踪
-- =====================================================
ALTER TABLE posts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ;

-- 可选：为已有帖子填充 updated_at（设为 created_at 的值）
UPDATE posts SET updated_at = created_at WHERE updated_at IS NULL;
