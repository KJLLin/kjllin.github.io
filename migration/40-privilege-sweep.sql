-- ============================================================================
-- 40-privilege-sweep.sql
--
-- 背景：Supabase 建表时默认会给 anon / authenticated 一串「表级」授权，
--       其中 TRUNCATE 不受 RLS 约束 —— 一旦暴露就是「清空整表」。
--       PostgREST 目前不转发 TRUNCATE，所以不是可直接利用的漏洞，
--       但没有理由把这种权限留在业务角色手里（防御纵深）。
--
-- 同时：login_devices 之前给 anon 开了 SELECT，虽然 RLS 会挡住（auth.uid() 为空），
--       但登录记录这种数据不该给匿名角色任何入口。
--
-- 本次只做「收回」，不新增任何授权，属于纯收敛操作。
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. 收回 authenticated / anon 的 TRUNCATE、REFERENCES、TRIGGER
--    （业务只通过 PostgREST 做 SELECT / INSERT / UPDATE / DELETE）
-- ---------------------------------------------------------------------------
do $$
declare
  t text;
  tbls text[] := array[
    'announcements',
    'game_scores',
    'login_devices',
    'notifications',
    'post_likes',
    'posts',
    'rps_rooms',
    'user_blocks',
    'user_follows'
  ];
begin
  foreach t in array tbls loop
    execute format('revoke truncate, references, trigger on public.%I from authenticated', t);
    execute format('revoke truncate, references, trigger on public.%I from anon', t);
  end loop;
end $$;

-- ---------------------------------------------------------------------------
-- 2. 登录记录不再对匿名角色开放
-- ---------------------------------------------------------------------------
revoke select on public.login_devices from anon;

-- ---------------------------------------------------------------------------
-- 3. 注释：提醒后来者不要再把 INSERT 权限开回 private_messages
-- ---------------------------------------------------------------------------
comment on table public.private_messages is
  '私信：写入只能走 public.send_message()，浏览器角色没有 INSERT 权限，请勿恢复';
comment on table public.login_devices is
  '登录记录：仅本人可读写，匿名角色无任何权限';

commit;
