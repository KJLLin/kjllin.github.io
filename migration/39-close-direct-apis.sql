-- ============================================================================
-- 39-close-direct-apis.sql
-- 关闭「好友列表读取」与「直连发消息」两个敞口
--
-- 前提：38 已建好 send_message / get_profiles，且前端已全部切换（已上线）。
--
-- 收口内容：
--   1. private_messages：撤销 authenticated 的 INSERT（含列级），
--      写入只能走 send_message()；SELECT/UPDATE(read)/DELETE 保留给会话双方。
--   2. profiles_public：撤销授权并删除。这个视图以 owner 身份执行，
--      绕过了 users 的 RLS，anon 能整表拉走全站用户 —— 换成 get_profiles()。
--   3. 顺手清掉 TRUNCATE / TRIGGER / REFERENCES 这类用不到的过度授权。
-- ============================================================================

-- ---------------------------------------------------------------- 1. 私信直写
revoke insert on public.private_messages from authenticated;
revoke insert on public.private_messages from anon;
revoke select on public.private_messages from anon;

-- 列级授权独立于表级，必须单独撤销（否则照样能 INSERT）
revoke insert (id, sender_id, recipient_id, text, read, created_at, attachment)
  on public.private_messages from authenticated;
revoke insert (client_id) on public.private_messages from authenticated;

revoke truncate, references, trigger on public.private_messages from authenticated;

-- 读写分离：发消息走 RPC，读消息仍走 chat_messages / 实时订阅
grant select on public.private_messages to authenticated;
grant update (read) on public.private_messages to authenticated;
grant delete on public.private_messages to authenticated;

comment on table public.private_messages is
  '站内信消息；写入必须通过 send_message()，客户端无 INSERT 权限';

-- ---------------------------------------------------------------- 2. 公开档案视图
revoke all on public.profiles_public from anon, authenticated;
drop view if exists public.profiles_public;

-- ---------------------------------------------------------------- 3. users 收尾
revoke truncate, references, trigger on public.users from authenticated;

-- 自己那一行仍然要能读（设置页、头像、昵称都依赖），管理员读全表
grant select on public.users to authenticated;
