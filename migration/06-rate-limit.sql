-- =====================================================
-- KJLLin 服务端限流（SEC-008：DB 触发器，防客户端限流绕过）
-- 在 Supabase SQL Editor 中运行此脚本
-- 原理：BEFORE INSERT 触发器检查滑动窗口内该用户的插入次数，
--       超限直接 RAISE EXCEPTION，PostgREST 会把错误返回给前端
-- =====================================================

CREATE OR REPLACE FUNCTION public.enforce_insert_rate_limit()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  max_ops INTEGER;
  win TEXT;        -- 窗口 interval 字符串
  time_col TEXT;   -- 时间列名
  uid UUID;
  n INTEGER;
BEGIN
  -- 各表限流配置：表名 → (窗口内最大插入数, 窗口, 时间列)
  CASE TG_TABLE_NAME
    WHEN 'game_scores'       THEN max_ops := 12; win := '60 seconds';  time_col := 'created_at';
    WHEN 'posts'             THEN max_ops := 5;  win := '600 seconds'; time_col := 'created_at';
    WHEN 'private_messages'  THEN max_ops := 30; win := '60 seconds';  time_col := 'created_at';
    WHEN 'login_devices'     THEN max_ops := 10; win := '300 seconds'; time_col := 'logged_in_at';
    ELSE RETURN NEW; -- 未配置的表不限流
  END CASE;

  -- 取用户标识（private_messages 用 sender_id，其余用 user_id）
  IF TG_TABLE_NAME = 'private_messages' THEN
    uid := NEW.sender_id;
  ELSE
    uid := NEW.user_id;
  END IF;
  IF uid IS NULL THEN
    uid := auth.uid();
  END IF;
  IF uid IS NULL THEN
    RETURN NEW; -- 无法识别用户则放行（交给 RLS 拦截匿名写入）
  END IF;

  EXECUTE format(
    'SELECT count(*) FROM %I.%I WHERE %I = $1 AND %I > now() - $2::interval',
    TG_TABLE_SCHEMA, TG_TABLE_NAME,
    CASE WHEN TG_TABLE_NAME = 'private_messages' THEN 'sender_id' ELSE 'user_id' END,
    time_col
  ) INTO n USING uid, win;

  IF n >= max_ops THEN
    RAISE EXCEPTION '操作过于频繁，请稍后重试';
  END IF;

  RETURN NEW;
END;
$$;

-- 绑定触发器（幂等：先删后建）
DROP TRIGGER IF EXISTS trg_rate_limit_game_scores ON game_scores;
CREATE TRIGGER trg_rate_limit_game_scores
  BEFORE INSERT ON game_scores
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insert_rate_limit();

DROP TRIGGER IF EXISTS trg_rate_limit_posts ON posts;
CREATE TRIGGER trg_rate_limit_posts
  BEFORE INSERT ON posts
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insert_rate_limit();

DROP TRIGGER IF EXISTS trg_rate_limit_private_messages ON private_messages;
CREATE TRIGGER trg_rate_limit_private_messages
  BEFORE INSERT ON private_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insert_rate_limit();

DROP TRIGGER IF EXISTS trg_rate_limit_login_devices ON login_devices;
CREATE TRIGGER trg_rate_limit_login_devices
  BEFORE INSERT ON login_devices
  FOR EACH ROW EXECUTE FUNCTION public.enforce_insert_rate_limit();
