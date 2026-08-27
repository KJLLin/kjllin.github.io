-- =====================================================
-- KJLLin 帖子可见范围：公开 / 私有
-- 1) posts 表新增 visibility（'public' 公开 默认 / 'private' 私有）
-- 2) RLS：私有帖仅作者与管理员可见，其他人仅能看到公开帖
-- 幂等，可重复执行
-- =====================================================

ALTER TABLE public.posts ADD COLUMN IF NOT EXISTS visibility TEXT NOT NULL DEFAULT 'public';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'posts_visibility_check' AND conrelid = 'public.posts'::regclass
  ) THEN
    ALTER TABLE public.posts
      ADD CONSTRAINT posts_visibility_check CHECK (visibility IN ('public','private'));
  END IF;
END $$;

-- 筛选策略：公开皆可读；私有仅作者本人与管理员可读
DROP POLICY IF EXISTS posts_select ON public.posts;
CREATE POLICY posts_select ON public.posts
  FOR SELECT
  USING (
    visibility = 'public'
    OR user_id = auth.uid()
    OR EXISTS (
      SELECT 1 FROM public.users u
      WHERE u.id = auth.uid() AND u.is_admin IS TRUE
    )
  );