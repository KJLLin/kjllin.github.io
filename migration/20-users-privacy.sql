-- =====================================================
-- 20-users-privacy.sql  收敛 users 表的读取权限
--
-- 背景：
--   原策略 users_select = (auth.uid() IS NOT NULL)，
--   即任何登录用户都能 SELECT 全表，拿到所有人的
--   email / phone / message_privacy / last_login_time。
--
-- 目标：
--   1. 登录用户只能读自己那一行；管理员可读全部
--   2. 需要「别人的昵称」的场景统一走 profiles_public 视图
--   3. 需要「按邮箱/手机号找人」的场景统一走 search_users() RPC，
--      只返回昵称 + 脱敏提示，不返回原值
-- =====================================================

-- -----------------------------------------------------
-- 1. 管理员判定（SECURITY DEFINER，避免策略自引用递归）
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.is_admin(p_uid uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
STABLE
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT u.is_admin FROM public.users u WHERE u.id = p_uid),
    false
  );
$$;

REVOKE ALL ON FUNCTION public.is_admin(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.is_admin(uuid) TO authenticated;

-- -----------------------------------------------------
-- 2. 通用用户搜索（站内信 / 云盘分享 / 游戏邀请共用）
--    返回：id、昵称、管理员标识、脱敏提示
-- -----------------------------------------------------
CREATE OR REPLACE FUNCTION public.search_users(p_term text)
RETURNS TABLE(id uuid, nick text, is_admin boolean, hint text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_uid uuid := auth.uid();
  v_term text := btrim(COALESCE(p_term, ''));
  v_norm text;
  v_local text;
  v_domain text;
  v_pattern text;
BEGIN
  IF v_uid IS NULL OR char_length(v_term) < 2 THEN
    RETURN;
  END IF;
  IF char_length(v_term) > 100 THEN
    v_term := left(v_term, 100);
  END IF;

  v_norm := regexp_replace(v_term, '[\s\-()]', '', 'g');
  IF v_norm ~ '^1[3-9][0-9]{9}$' THEN
    v_norm := '+86' || v_norm;
  ELSIF v_norm !~ '^\+[0-9]{6,15}$' THEN
    v_norm := '';
  END IF;

  IF position('@' IN v_term) > 0 THEN
    v_local  := split_part(v_term, '@', 1);
    v_domain := split_part(v_term, '@', 2);
    IF v_local = '' THEN
      RETURN;
    END IF;
    v_local  := replace(replace(replace(v_local,  '\', '\\'), '%', '\%'), '_', '\_');
    v_domain := replace(replace(replace(v_domain, '\', '\\'), '%', '\%'), '_', '\_');
    v_pattern := v_local || '@' || v_domain || '%';
  ELSE
    v_pattern := replace(replace(replace(v_term, '\', '\\'), '%', '\%'), '_', '\_') || '@%';
  END IF;

  RETURN QUERY
  SELECT
    u.id,
    COALESCE(u.nick, '') AS nick,
    COALESCE(u.is_admin, false) AS is_admin,
    CASE
      WHEN u.email IS NOT NULL AND u.email <> '' THEN
        left(u.email, 1) || '***@' || split_part(u.email, '@', 2)
      WHEN u.phone IS NOT NULL AND u.phone <> '' THEN
        left(u.phone, 3) || '****' || right(u.phone, 2)
      ELSE ''
    END AS hint
  FROM public.users u
  WHERE u.id <> v_uid
    AND (
      u.email ILIKE v_pattern
      OR (v_norm <> '' AND u.phone = v_norm)
      OR u.nick = v_term
    )
  ORDER BY (u.nick = v_term) DESC, u.nick NULLS LAST
  LIMIT 8;
END;
$$;

REVOKE ALL ON FUNCTION public.search_users(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.search_users(text) TO authenticated;

-- 兼容旧调用方：chat_search_users 作为别名保留
CREATE OR REPLACE FUNCTION public.chat_search_users(p_term text)
RETURNS TABLE(id uuid, nick text, is_admin boolean, hint text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT * FROM public.search_users(p_term);
$$;

REVOKE ALL ON FUNCTION public.chat_search_users(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.chat_search_users(text) TO authenticated;

-- -----------------------------------------------------
-- 3. 收紧 users 的读取策略
-- -----------------------------------------------------
DROP POLICY IF EXISTS users_select ON public.users;

CREATE POLICY users_select ON public.users
  FOR SELECT TO authenticated
  USING (auth.uid() = id OR public.is_admin());

-- 顺带把两条旧策略里的自引用子查询换成 helper（避免潜在递归）
DROP POLICY IF EXISTS users_admin_update ON public.users;
CREATE POLICY users_admin_update ON public.users
  FOR UPDATE TO authenticated
  USING (public.is_admin())
  WITH CHECK (public.is_admin());

DROP POLICY IF EXISTS users_update_own ON public.users;
CREATE POLICY users_update_own ON public.users
  FOR UPDATE TO authenticated
  USING (auth.uid() = id)
  WITH CHECK (
    auth.uid() = id
    AND NOT (is_admin IS DISTINCT FROM public.is_admin())
  );
