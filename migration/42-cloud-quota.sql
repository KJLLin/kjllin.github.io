-- ============================================================================
-- 42-cloud-quota.sql
--
-- 私有云盘每人 50MB 配额（服务端强制，前端只做提示）。
--
-- 做法：storage.objects 上的 BEFORE INSERT/UPDATE 触发器按 owner 汇总，
-- 超额直接报错，storage API 会把错误信息回传给前端。
--
-- 注意：storage.objects 的属主是 supabase_storage_admin，当前部署账号
-- （postgres）只有 TRIGGER 权限，没有 owner 权限。因此本文件只包含
-- 「函数 + 触发器 + 桶级单文件上限」；给 storage.objects 建索引 / 补
-- RLS with check 需要存储属主权限，不在本迁移内执行（量级很小，不影响）。
-- ============================================================================

-- ---------------------------------------------------------------- 1. 用量
create or replace function public.cloud_private_used(p_uid uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
  from storage.objects o
  where o.bucket_id = 'cloud-drive-private'
    and (
      o.owner = p_uid
      or (o.owner is null and o.owner_id = p_uid::text)
    );
$$;

revoke all on function public.cloud_private_used(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------- 2. 前端查询
create or replace function public.cloud_quota()
returns table (used_bytes bigint, quota_bytes bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    coalesce(public.cloud_private_used(auth.uid()), 0)::bigint,
    52428800::bigint
  where auth.uid() is not null;
$$;

revoke all on function public.cloud_quota() from public, anon;
grant execute on function public.cloud_quota() to authenticated;

comment on function public.cloud_quota() is
  '当前用户私有云盘已用字节数与配额（50MB）';

-- ---------------------------------------------------------------- 3. 配额触发器
create or replace function public.enforce_cloud_private_quota()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid   uuid;
  v_new   bigint := 0;
  v_old   bigint := 0;
  v_used  bigint := 0;
  v_limit constant bigint := 52428800;
begin
  if new.bucket_id is distinct from 'cloud-drive-private' then
    return new;
  end if;

  v_uid := new.owner;
  if v_uid is null and new.owner_id ~ '^[0-9a-fA-F-]{36}$' then
    v_uid := new.owner_id::uuid;
  end if;
  if v_uid is null then
    return new;
  end if;

  v_new := coalesce((new.metadata->>'size')::bigint, 0);

  if tg_op = 'UPDATE' then
    -- 只有大小变化才重新核算（下载会更新 last_accessed_at，不应触发）
    if coalesce(old.metadata->>'size', '') = coalesce(new.metadata->>'size', '') then
      return new;
    end if;
    if old.bucket_id = new.bucket_id and old.owner is not distinct from new.owner then
      v_old := coalesce((old.metadata->>'size')::bigint, 0);
    end if;
  end if;

  select coalesce(sum(coalesce((o.metadata->>'size')::bigint, 0)), 0)
    into v_used
  from storage.objects o
  where o.bucket_id = 'cloud-drive-private'
    and (
      o.owner = v_uid
      or (o.owner is null and o.owner_id = v_uid::text)
    );

  if v_used - v_old + v_new > v_limit then
    raise exception '私有空间已满（每人 50MB），请先删除部分文件'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

revoke all on function public.enforce_cloud_private_quota() from public, anon, authenticated;

drop trigger if exists trg_cloud_private_quota on storage.objects;
create trigger trg_cloud_private_quota
  before insert or update on storage.objects
  for each row
  execute function public.enforce_cloud_private_quota();

-- ---------------------------------------------------------------- 4. 单文件上限
-- 与前端提示保持一致；桶级上限是服务端兜底，客户端改不了。
update storage.buckets
   set file_size_limit = 10485760
 where id in ('cloud-drive', 'cloud-drive-private')
   and (file_size_limit is null or file_size_limit > 10485760);
