-- =====================================================
-- KJLLin 手机号登录支持
-- 1) users 表新增 phone 列，用于后台展示与绑定（唯一）
-- 2) 仅供管理员通过 admin-phone 函数写 phone；普通用户不承诺自行修改
-- =====================================================

-- users 表新增 phone 列（唯一，可空）
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone TEXT UNIQUE;

-- 允许管理员（通过 service role 调用 admin-phone 函数）更新 phone；
-- 现有策略 users_update_own 只允许本人更新自身，服务端函数走 service key 不受 RLS 限制，
-- 这里无需新增策略。