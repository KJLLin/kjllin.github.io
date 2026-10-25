-- ============================================================================
-- 24-avatars.sql
-- 用户头像：自定义上传（Storage）+ 昵称首字兜底
--
-- 设计要点
--   1. users.avatar_url 只存两种值：
--        · 本系统 Storage 的相对路径 {uid}/a-{ts}.{ext}
--        · 外部 https URL（历史 GitHub 头像等）
--      CHECK 约束在库层挡掉 javascript: / data: 等危险协议。
--   2. Storage 桶 avatars：公开读（头像要能在任何页面 <img> 直出），
--      写 / 改 / 删仅限本人目录 {uid}/**，并限制 2MB 与图片 MIME 白名单。
--   3. profiles_public 视图补 avatar_url，让列表页能一次性拿到头像，
--      不必再回 users 表（users 的 SELECT 仍限本人/管理员）。
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. 字段
-- ---------------------------------------------------------------------------
alter table public.users add column if not exists avatar_url text;

alter table public.users drop constraint if exists users_avatar_url_shape;
alter table public.users add constraint users_avatar_url_shape check (
  avatar_url is null
  or avatar_url = ''
  or avatar_url ~* '^https://[^\s"''<>]+$'
  or avatar_url ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[A-Za-z0-9._-]{1,120}$'
);

comment on column public.users.avatar_url is '头像：Storage 相对路径 {uid}/xxx 或 https URL；空表示用昵称首字';

-- 列级写权限（此前已收紧为白名单，这里补 avatar_url）
grant update (avatar_url) on public.users to authenticated;

-- 路径归属校验：Storage 相对路径的第一段必须是自己的 uid，
-- 否则用户可以把自己的头像指向别人的文件（借用他人头像）。
create or replace function public.users_avatar_guard()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if new.avatar_url is not null and new.avatar_url <> ''
     and new.avatar_url ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/' then
    if split_part(new.avatar_url, '/', 1) <> new.id::text then
      raise exception 'avatar path must live in your own folder' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_users_avatar_guard on public.users;
create trigger trg_users_avatar_guard
  before insert or update of avatar_url on public.users
  for each row execute function public.users_avatar_guard();

-- ---------------------------------------------------------------------------
-- 2. 公开视图补列
-- ---------------------------------------------------------------------------
create or replace view public.profiles_public as
  select id, nick, is_admin, created_at, avatar_url
  from public.users;

revoke all on public.profiles_public from public, anon, authenticated;
grant select on public.profiles_public to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Storage 桶
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('avatars', 'avatars', true, 2097152,
        array['image/jpeg', 'image/png', 'image/webp', 'image/gif'])
on conflict (id) do update
  set public = true,
      file_size_limit = 2097152,
      allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

drop policy if exists avatars_read_all on storage.objects;
drop policy if exists avatars_insert_own on storage.objects;
drop policy if exists avatars_update_own on storage.objects;
drop policy if exists avatars_delete_own on storage.objects;

create policy avatars_read_all on storage.objects
  for select to anon, authenticated
  using (bucket_id = 'avatars');

create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text)
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------------------------------------------------------------------------
-- 4. 头像批量查询（列表页一次拿多人的头像与昵称，避免 N+1）
--    只返回公开字段，且不在 users 上开放读取。
-- ---------------------------------------------------------------------------
create or replace function public.get_avatars(p_ids uuid[])
returns table (id uuid, nick text, avatar_url text, is_admin boolean)
language sql
stable
security definer
set search_path = ''
as $$
  select u.id, u.nick, u.avatar_url, u.is_admin
  from public.users u
  where u.id = any (p_ids)
  limit 200;
$$;

revoke all on function public.get_avatars(uuid[]) from public, anon;
grant execute on function public.get_avatars(uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- 5. 清空头像（把路径写空，前端回落到昵称首字）
-- ---------------------------------------------------------------------------
create or replace function public.clear_my_avatar()
returns void
language sql
security definer
set search_path = ''
as $$
  update public.users set avatar_url = null where id = auth.uid();
$$;

revoke all on function public.clear_my_avatar() from public, anon;
grant execute on function public.clear_my_avatar() to authenticated;
