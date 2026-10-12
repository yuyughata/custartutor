-- 13 pack publishing: pack columns on published_units, write-once pack info, the private `packs` bucket and
-- the RPCs the pack edge functions use (ADR 0004; wire.ts PackDownload / PublishedRow).
--
-- Publishing is two steps by design: (1) publish_unit_version freezes the snapshot (as before); (2) the
-- `publish-pack` edge function builds the pack files, uploads them to the private `packs` bucket with the
-- service role and finally calls set_pack_info, which flips the pack "on". Until then the row is INVISIBLE to
-- sync_pull and to authorize_pack_download (a half-built pack is never offered).
--
-- Storage layout (bucket `packs`, private, NO client policy on storage.objects: only the service role used by
-- the edge functions reads/writes; learners get short-lived signed URLs from `get-pack-download`):
--   units/<unit_id>/<version_no>/manifest.json
--   units/<unit_id>/<version_no>/learner.json
--   units/<unit_id>/<version_no>/grownup.json
--   blobs/<sha256>                              content-addressed media/audio, shared by every pack

-- pack columns ----------------------------------------------------------------------------------------------
alter table public.published_units
  add column pack_manifest_path text,
  add column content_hash text,
  add column min_app_version text not null default '1.0.0',
  add column pack_built_at timestamptz;

alter table public.published_units
  add constraint published_units_min_app_version_chk check (min_app_version ~ '^\d+(\.\d+){0,2}$'),
  add constraint published_units_pack_info_chk check (
    (pack_manifest_path is null and content_hash is null and pack_built_at is null)
    or (pack_manifest_path is not null and content_hash is not null and pack_built_at is not null)
  ),
  add constraint published_units_pack_hash_chk check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),
  -- the manifest of a version can only live at its own canonical path: a bad actor with set_pack_info
  -- cannot point a row at another unit's files
  add constraint published_units_pack_path_chk check (
    pack_manifest_path is null
    or pack_manifest_path = 'units/' || unit_id::text || '/' || version_no::text || '/manifest.json'
  );

comment on column public.published_units.pack_manifest_path is
  'Storage path (bucket packs) of the immutable manifest. NULL until the pack is built; set once by private.set_pack_info.';
comment on column public.published_units.content_hash is
  'sha256 (hex) of the canonical JSON of `content`; equals PackManifest.content_hash. Set once with the manifest path.';
comment on column public.published_units.min_app_version is
  'Oldest app build that can read this pack (also written into the manifest).';

-- the snapshot guard learns the new columns: min_app_version is part of the immutable snapshot; the pack info
-- may change exactly once, from NULL to a value (set_pack_info). Same protection for EVERY role, owner included.
create or replace function private.protect_published_units()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'published_units_are_immutable' using errcode = '42501';
  end if;
  if (new.id, new.unit_id, new.unit_version_id, new.version_no, new.schema_version, new.content,
      new.published_at, new.min_app_version)
     is distinct from
     (old.id, old.unit_id, old.unit_version_id, old.version_no, old.schema_version, old.content,
      old.published_at, old.min_app_version)
     or (new.published_by is distinct from old.published_by and new.published_by is not null) then
    raise exception 'published_units_are_immutable' using errcode = '42501';
  end if;
  if old.pack_manifest_path is not null
     and (new.pack_manifest_path, new.content_hash, new.pack_built_at)
         is distinct from (old.pack_manifest_path, old.content_hash, old.pack_built_at) then
    raise exception 'published_units_are_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function private.protect_published_units() from public, anon, authenticated;

-- which published row serves a unit ----------------------------------------------------------------------------
-- A row SERVES when it has pack info, is not tombstoned, is the highest such version of its unit, and the unit is
-- still published (some row is_current and not tombstoned). The newest version keeps serving only once ITS pack
-- exists: between publish_unit_version and the pack build the previous (built) version stays the one learners
-- are offered, so there is never a window without a downloadable pack. Everything else with pack info is a
-- tombstone for sync_pull. One definition for sync_pull and authorize_pack_download.
create or replace function private.pack_is_serving(p_unit_id uuid, p_version_no int)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
           select 1 from public.published_units pu
            where pu.unit_id = p_unit_id and pu.version_no = p_version_no
              and pu.pack_manifest_path is not null and pu.deleted_at is null)
     and p_version_no = (
           select max(q.version_no) from public.published_units q
            where q.unit_id = p_unit_id and q.pack_manifest_path is not null and q.deleted_at is null)
     and exists (
           select 1 from public.published_units q
            where q.unit_id = p_unit_id and q.is_current and q.deleted_at is null);
$$;

revoke all on function private.pack_is_serving(uuid, int) from public, anon, authenticated;

-- admin: the source of a pack build ---------------------------------------------------------------------------
-- Admin (super_admin, content_editor, reviewer) at aal2. Returns what publish-pack needs to build the pack.
create or replace function private.get_pack_source(p_published_unit_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_row public.published_units%rowtype;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  select * into v_row from public.published_units pu where pu.id = p_published_unit_id;
  if not found then
    raise exception 'published_unit_not_found' using errcode = 'P0002';
  end if;
  return jsonb_build_object(
    'published_unit_id', v_row.id,
    'unit_id', v_row.unit_id,
    'version_no', v_row.version_no,
    'schema_version', v_row.schema_version,
    'min_app_version', v_row.min_app_version,
    'is_current', v_row.is_current,
    'deleted', v_row.deleted_at is not null,
    'content', v_row.content,
    'pack_manifest_path', v_row.pack_manifest_path,
    'content_hash', v_row.content_hash
  );
end;
$$;

-- admin / service role: switch a built pack on ------------------------------------------------------------------
-- Callable by an admin (super_admin, content_editor, reviewer) at aal2, or by the service role (a CI pack job).
-- Write-once: repeating the call with the SAME values is a no-op; different values raise pack_info_already_set.
-- Re-stamps older built versions of the unit so their superseded tombstones reach the devices.
create or replace function private.set_pack_info(
  p_published_unit_id uuid,
  p_manifest_path text,
  p_content_hash text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.published_units%rowtype;
begin
  if coalesce((select auth.role()), '') <> 'service_role' then
    if (select auth.uid()) is null then
      raise exception 'not_authenticated' using errcode = '42501';
    end if;
    if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
      raise exception 'admin_role_required' using errcode = '42501';
    end if;
  end if;
  if p_content_hash is null or p_content_hash !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid_content_hash' using errcode = '22023';
  end if;
  if p_manifest_path is null then
    raise exception 'invalid_pack_path' using errcode = '22023';
  end if;

  select * into v_row from public.published_units pu where pu.id = p_published_unit_id for update;
  if not found then
    raise exception 'published_unit_not_found' using errcode = 'P0002';
  end if;
  if p_manifest_path <> 'units/' || v_row.unit_id::text || '/' || v_row.version_no::text || '/manifest.json' then
    raise exception 'invalid_pack_path' using errcode = '22023';
  end if;

  if v_row.pack_manifest_path is not null then
    if v_row.content_hash = p_content_hash then
      return jsonb_build_object(
        'published_unit_id', v_row.id, 'unit_id', v_row.unit_id, 'version_no', v_row.version_no,
        'manifest_path', v_row.pack_manifest_path, 'content_hash', v_row.content_hash,
        'pack_built_at', v_row.pack_built_at, 'already_set', true
      );
    end if;
    raise exception 'pack_info_already_set' using errcode = '22023';
  end if;

  update public.published_units pu
     set pack_manifest_path = p_manifest_path,
         content_hash = p_content_hash,
         pack_built_at = now()
   where pu.id = v_row.id
  returning * into v_row;

  -- touch the older built versions: they are tombstones from now on
  update public.published_units o
     set is_current = o.is_current
   where o.unit_id = v_row.unit_id
     and o.version_no < v_row.version_no
     and o.pack_manifest_path is not null;

  return jsonb_build_object(
    'published_unit_id', v_row.id, 'unit_id', v_row.unit_id, 'version_no', v_row.version_no,
    'manifest_path', v_row.pack_manifest_path, 'content_hash', v_row.content_hash,
    'pack_built_at', v_row.pack_built_at, 'already_set', false
  );
end;
$$;

-- learner: may I download this pack? ------------------------------------------------------------------------------
-- Authorisation choice: ANY signed-in user who is an active member (guardian or tutor) of at least one household.
-- The published curriculum is already readable by every signed-in user through published_units, so this gate is
-- an abuse / entitlement control for the storage egress, not a secrecy control; entitlements (plan section 3)
-- will tighten it later. The row must SERVE (see pack_is_serving): non-tombstoned, pack info set, newest built
-- version of a still-published unit. Returns {manifest_path, content_hash}; the edge function signs the files.
create or replace function private.authorize_pack_download(p_unit_id uuid, p_version_no int)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_row public.published_units%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_unit_id is null or p_version_no is null or p_version_no < 1 then
    raise exception 'invalid_pack_request' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.household_members m
     where m.user_id = v_uid and m.status = 'active' and m.deleted_at is null
  ) then
    raise exception 'not_a_household_member' using errcode = '42501';
  end if;
  if not private.pack_is_serving(p_unit_id, p_version_no) then
    raise exception 'pack_not_found' using errcode = 'P0002';
  end if;
  select * into v_row
    from public.published_units pu
   where pu.unit_id = p_unit_id and pu.version_no = p_version_no;
  return jsonb_build_object('manifest_path', v_row.pack_manifest_path, 'content_hash', v_row.content_hash);
end;
$$;

revoke all on function
  private.get_pack_source(uuid),
  private.set_pack_info(uuid, text, text),
  private.authorize_pack_download(uuid, int)
  from public, anon, authenticated;
grant execute on function
  private.get_pack_source(uuid),
  private.set_pack_info(uuid, text, text),
  private.authorize_pack_download(uuid, int)
  to authenticated;

-- a CI pack job may use the service role: let it resolve the one private function it needs
grant usage on schema private to service_role;
grant execute on function private.set_pack_info(uuid, text, text) to service_role;

-- public wrappers (SECURITY INVOKER) ---------------------------------------------------------------------------------
create or replace function public.get_pack_source(p_published_unit_id uuid)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.get_pack_source(p_published_unit_id); $$;

create or replace function public.set_pack_info(
  p_published_unit_id uuid,
  p_manifest_path text,
  p_content_hash text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.set_pack_info(p_published_unit_id, p_manifest_path, p_content_hash); $$;

create or replace function public.authorize_pack_download(p_unit_id uuid, p_version_no int)
returns jsonb
language sql
stable
security invoker
set search_path = ''
as $$ select private.authorize_pack_download(p_unit_id, p_version_no); $$;

revoke all on function
  public.get_pack_source(uuid),
  public.set_pack_info(uuid, text, text),
  public.authorize_pack_download(uuid, int)
  from public, anon, authenticated;
grant execute on function
  public.get_pack_source(uuid),
  public.authorize_pack_download(uuid, int)
  to authenticated;
grant execute on function public.set_pack_info(uuid, text, text) to authenticated, service_role;

comment on function public.get_pack_source(uuid) is
  'Admin (super_admin, content_editor, reviewer) at aal2. Returns the published snapshot (content, version, min_app_version, pack info) that the publish-pack edge function builds a pack from.';
comment on function public.set_pack_info(uuid, text, text) is
  'Admin (super_admin, content_editor, reviewer) at aal2, or the service role. Switches a built pack on: sets manifest path and content hash ONCE (repeat with the same values is a no-op). Until then the version is invisible to sync_pull.';
comment on function public.authorize_pack_download(uuid, int) is
  'Any signed-in active household member (guardian or tutor). Returns {manifest_path, content_hash} for a serving (non-tombstoned, built, newest) pack version, else raises pack_not_found. The get-pack-download edge function signs the files.';

-- the private bucket ---------------------------------------------------------------------------------------------------
-- Guarded: on a fresh local stack (`supabase start`) the storage schema is created by the storage service AFTER
-- the project migrations run; there the bucket comes from [storage.buckets.packs] in supabase/config.toml.
-- NO policy is created on storage.objects: with RLS on and no policy, anon and authenticated can neither list,
-- read nor write the bucket; the service role (edge functions) bypasses RLS.
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values (
      'packs', 'packs', false, 52428800,
      array['application/json', 'image/webp', 'image/png', 'image/jpeg',
            'audio/mpeg', 'audio/mp4', 'audio/aac', 'audio/ogg', 'audio/webm', 'audio/wav']
    )
    on conflict (id) do update
      set public = false,
          file_size_limit = excluded.file_size_limit,
          allowed_mime_types = excluded.allowed_mime_types;
  end if;
end
$$;
