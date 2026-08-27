-- =====================================================
-- KJLLin 私信接收设置 + 服务端强制
-- 1) users 表新增 message_privacy
--    'everyone' 所有人（拉黑除外，默认）
--    'follows'  仅关注的人与管理员
--    'admin'    仅管理员
-- 2) private_messages 前置触发器，强制校验私信接收隐私（含拉黑）
-- 幂等，可重复执行
-- =====================================================

ALTER TABLE public.users ADD COLUMN IF NOT EXISTS message_privacy TEXT NOT NULL DEFAULT 'everyone';

-- 私信隐私强制校验（REST 以用户 JWT 插入时 auth.uid() 可用）
CREATE OR REPLACE FUNCTION public.enforce_private_message_rules()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_sender uuid := auth.uid();
  v_privacy text;
  v_is_admin bool;
  v_blocked bool;
BEGIN
  IF v_sender IS NULL THEN
    RETURN NEW; -- 非用户上下文（如服务端导入）放行
  END IF;

  IF NEW.sender_id IS DISTINCT FROM v_sender THEN
    RAISE EXCEPTION '只能发送自己的私信';
  END IF;
  IF NEW.sender_id = NEW.recipient_id THEN
    RAISE EXCEPTION '不能给自己发送私信';
  END IF;

  -- 拉黑：接收方屏蔽了发送者
  SELECT EXISTS (
    SELECT 1 FROM public.user_blocks WHERE blocker_id = NEW.recipient_id AND blocked_id = v_sender
  ) INTO v_blocked;
  IF v_blocked IS TRUE THEN
    RAISE EXCEPTION '对方已屏蔽你，无法发送私信';
  END IF;

  -- 接收隐私
  SELECT message_privacy INTO v_privacy FROM public.users WHERE id = NEW.recipient_id;
  v_privacy := COALESCE(v_privacy, 'everyone');

  IF v_privacy = 'admin' THEN
    SELECT is_admin INTO v_is_admin FROM public.users WHERE id = v_sender;
    IF COALESCE(v_is_admin, false) IS NOT TRUE THEN
      RAISE EXCEPTION '对方仅接收管理员的私信';
    END IF;
  ELSIF v_privacy = 'follows' THEN
    SELECT is_admin INTO v_is_admin FROM public.users WHERE id = v_sender;
    IF COALESCE(v_is_admin, false) IS NOT TRUE THEN
      PERFORM 1 FROM public.user_follows WHERE follower_id = v_sender AND followed_id = NEW.recipient_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION '对方仅接收关注的人和管理员的私信';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_private_message_rules ON private_messages;
CREATE TRIGGER trg_private_message_rules
  BEFORE INSERT ON private_messages
  FOR EACH ROW EXECUTE FUNCTION public.enforce_private_message_rules();