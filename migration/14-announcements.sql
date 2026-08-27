-- =====================================================
-- KJLLin 全站公告
-- announcements：管理员创建，全站展示的公告横幅
-- 安全：所有人可读；仅管理员可增删改
-- 幂等，可重复执行（ONLY 首次生效）
-- =====================================================

CREATE TABLE IF NOT EXISTS public.announcements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  link TEXT,
  created_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ,
  active BOOLEAN NOT NULL DEFAULT true
);

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

-- 只读（含匿名访问者，用于全站横幅）
DROP POLICY IF EXISTS announcements_select ON public.announcements;
CREATE POLICY announcements_select ON public.announcements
  FOR SELECT USING (true);

-- 写操作仅限管理员
DROP POLICY IF EXISTS announcements_insert ON public.announcements;
CREATE POLICY announcements_insert ON public.announcements
  FOR INSERT WITH CHECK (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.is_admin IS TRUE)
  );

DROP POLICY IF EXISTS announcements_update ON public.announcements;
CREATE POLICY announcements_update ON public.announcements
  FOR UPDATE USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.is_admin IS TRUE)
  );

DROP POLICY IF EXISTS announcements_delete ON public.announcements;
CREATE POLICY announcements_delete ON public.announcements
  FOR DELETE USING (
    EXISTS (SELECT 1 FROM public.users u WHERE u.id = auth.uid() AND u.is_admin IS TRUE)
  );

GRANT SELECT ON public.announcements TO anon, authenticated;
GRANT INSERT, UPDATE, DELETE ON public.announcements TO authenticated;