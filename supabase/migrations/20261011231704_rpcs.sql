-- 06 RPCs.
--
-- Pattern: the logic lives in `private.<name>` (SECURITY DEFINER, search_path = '', not exposed to
-- PostgREST). Each RPC is exposed as a thin SECURITY INVOKER wrapper `public.<name>` so that the
-- exposed schema contains no SECURITY DEFINER functions. Wrappers are callable by `authenticated`
-- only; `anon` can call nothing. Every RPC rejects a missing auth.uid().
--
-- Parameters are prefixed `p_` so they never collide with column names.
-- Errors are raised as stable machine-readable messages (e.g. 'elevation_required'); authorization
-- failures use SQLSTATE 42501 so PostgREST answers 403.

-- audit helper (not callable by any API role) -----------------------------------------------------
create or replace function private.write_audit(
  p_action text,
  p_entity text,
  p_entity_id text,
  p_detail jsonb default null
)
returns void
language sql
security definer
set search_path = ''
as $$
  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values ((select auth.uid()), p_action, p_entity, p_entity_id, p_detail);
$$;

revoke all on function private.write_audit(text, text, text, jsonb) from public, anon, authenticated;

-- households ---------------------------------------------------------------------------------------

-- Creates a household and makes the caller its guardian. The only way to create a household.
create or replace function private.create_household(p_name text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_name text := btrim(coalesce(p_name, ''));
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if char_length(v_name) not between 1 and 80 then
    raise exception 'invalid_household_name' using errcode = '22023';
  end if;
  -- bound abuse: a user may be an active guardian of at most 5 households
  if (select count(*) from public.household_members m
      where m.user_id = v_uid and m.role = 'guardian' and m.status = 'active') >= 5 then
    raise exception 'household_limit_reached' using errcode = '53400';
  end if;

  insert into public.households (name, created_by)
  values (v_name, v_uid)
  returning id into v_id;

  insert into public.household_members (household_id, user_id, role, status)
  values (v_id, v_uid, 'guardian', 'active');

  return v_id;
end;
$$;

-- Guardian + live grown-up elevation. Returns the raw token ONCE; only its sha256 hash is stored.
create or replace function private.create_invite(
  p_household_id uuid,
  p_role text,
  p_child_ids uuid[],
  p_ttl_hours int default 72
)
returns table (invite_id uuid, token text, expires_at timestamptz)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_children uuid[];
  v_token text;
  v_hash text;
  v_exp timestamptz;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_household_member(p_household_id, array['guardian']) then
    raise exception 'not_a_guardian' using errcode = '42501';
  end if;
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;
  if p_role is null or p_role not in ('guardian', 'tutor') then
    raise exception 'invalid_role' using errcode = '22023';
  end if;
  if p_ttl_hours is null or p_ttl_hours not between 1 and 168 then
    raise exception 'invalid_ttl' using errcode = '22023';
  end if;

  select coalesce(array_agg(distinct t.cid), '{}')
    into v_children
    from unnest(coalesce(p_child_ids, '{}')) as t(cid);

  if p_role = 'guardian' and cardinality(v_children) > 0 then
    raise exception 'guardian_invite_takes_no_children' using errcode = '22023';
  end if;
  if p_role = 'tutor' then
    if cardinality(v_children) = 0 then
      raise exception 'tutor_invite_needs_children' using errcode = '22023';
    end if;
    if (select count(*) from public.children c
        where c.household_id = p_household_id
          and c.deleted_at is null
          and c.id = any (v_children)) <> cardinality(v_children) then
      raise exception 'unknown_child' using errcode = '22023';
    end if;
  end if;

  -- bound abuse: at most 20 pending invites per household
  if (select count(*) from public.invites i
      where i.household_id = p_household_id
        and i.accepted_at is null
        and i.expires_at > now()) >= 20 then
    raise exception 'too_many_pending_invites' using errcode = '53400';
  end if;

  v_token := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash := encode(extensions.digest(v_token, 'sha256'), 'hex');
  v_exp := now() + make_interval(hours => p_ttl_hours);

  insert into public.invites (household_id, role, child_ids, token_hash, expires_at, created_by)
  values (p_household_id, p_role, v_children, v_hash, v_exp, v_uid)
  returning id into v_id;

  perform private.write_audit(
    'invite_created', 'invites', v_id::text,
    jsonb_build_object('household_id', p_household_id, 'role', p_role,
                       'child_ids', v_children, 'expires_at', v_exp)
  );

  return query select v_id, v_token, v_exp;
end;
$$;

-- Redeems an invite token: single-use (row lock + accepted_at), expiring, hash lookup only.
-- This and create_household are the only ways to become a household member.
create or replace function private.accept_invite(p_token text)
returns table (household_id uuid, role text)
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_hash text;
  v_inv public.invites%rowtype;
  v_member public.household_members%rowtype;
  v_member_found boolean;
  v_child_id uuid;
  v_granted int := 0;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_token is null or char_length(p_token) not between 16 and 256 then
    raise exception 'invite_invalid' using errcode = '22023';
  end if;

  v_hash := encode(extensions.digest(p_token, 'sha256'), 'hex');

  select * into v_inv
    from public.invites i
    where i.token_hash = v_hash
    for update;
  if not found then
    raise exception 'invite_invalid' using errcode = '22023';
  end if;
  if v_inv.accepted_at is not null then
    raise exception 'invite_used' using errcode = '22023';
  end if;
  if v_inv.expires_at <= now() then
    raise exception 'invite_expired' using errcode = '22023';
  end if;
  -- the inviter must still be an active guardian, otherwise the invite dies with their access
  if not exists (
    select 1 from public.household_members g
    where g.household_id = v_inv.household_id
      and g.user_id = v_inv.created_by
      and g.role = 'guardian'
      and g.status = 'active'
  ) then
    raise exception 'invite_invalid' using errcode = '22023';
  end if;

  select * into v_member
    from public.household_members m
    where m.household_id = v_inv.household_id and m.user_id = v_uid
    for update;
  v_member_found := found;

  if v_member_found and v_member.status = 'active' then
    if v_member.role = 'guardian' and v_inv.role = 'tutor' then
      raise exception 'already_guardian' using errcode = '22023';
    end if;
    if v_member.role = 'tutor' and v_inv.role = 'guardian' then
      update public.household_members m
        set role = 'guardian'
        where m.household_id = v_inv.household_id and m.user_id = v_uid;
    end if;
  elsif v_member_found then
    -- previously removed: reactivate with the invited role
    update public.household_members m
      set role = v_inv.role, status = 'active', deleted_at = null
      where m.household_id = v_inv.household_id and m.user_id = v_uid;
  else
    insert into public.household_members (household_id, user_id, role, status)
    values (v_inv.household_id, v_uid, v_inv.role, 'active');
  end if;

  if v_inv.role = 'tutor' then
    for v_child_id in
      select c.id from public.children c
      where c.household_id = v_inv.household_id
        and c.deleted_at is null
        and c.id = any (v_inv.child_ids)
    loop
      insert into public.child_access (child_id, household_id, tutor_user_id, granted_by)
      values (v_child_id, v_inv.household_id, v_uid, v_inv.created_by)
      on conflict (child_id, tutor_user_id) where revoked_at is null do nothing;
      v_granted := v_granted + 1;
    end loop;
    if v_granted = 0 then
      raise exception 'invite_children_unavailable' using errcode = '22023';
    end if;
  end if;

  update public.invites i
    set accepted_by = v_uid, accepted_at = now()
    where i.id = v_inv.id;

  perform private.write_audit(
    'invite_accepted', 'invites', v_inv.id::text,
    jsonb_build_object('household_id', v_inv.household_id, 'role', v_inv.role)
  );

  return query select v_inv.household_id, v_inv.role;
end;
$$;

-- Guardian + elevation. Tombstones the membership and revokes the member's child grants.
create or replace function private.remove_member(p_household_id uuid, p_user_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_target public.household_members%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.is_household_member(p_household_id, array['guardian']) then
    raise exception 'not_a_guardian' using errcode = '42501';
  end if;
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;

  -- serialise guardian removals so two guardians cannot remove each other concurrently
  perform 1 from public.household_members g
    where g.household_id = p_household_id and g.role = 'guardian' and g.status = 'active'
    for update;

  select * into v_target
    from public.household_members m
    where m.household_id = p_household_id and m.user_id = p_user_id and m.status = 'active'
    for update;
  if not found then
    raise exception 'member_not_found' using errcode = 'P0002';
  end if;
  if v_target.role = 'guardian' and (
    select count(*) from public.household_members g
    where g.household_id = p_household_id and g.role = 'guardian' and g.status = 'active'
  ) <= 1 then
    raise exception 'last_guardian' using errcode = '22023';
  end if;

  update public.household_members m
    set status = 'removed', deleted_at = now()
    where m.household_id = p_household_id and m.user_id = p_user_id;

  update public.child_access a
    set revoked_at = coalesce(a.revoked_at, now()), deleted_at = coalesce(a.deleted_at, now())
    where a.household_id = p_household_id
      and a.tutor_user_id = p_user_id
      and (a.revoked_at is null or a.deleted_at is null);
end;
$$;

-- Guardian + elevation. Grants an existing tutor of the household access to one more child.
-- Returns the new grant id, or null when an active grant already exists.
create or replace function private.grant_child_access(p_child_id uuid, p_tutor_user_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_hid uuid;
  v_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select c.household_id into v_hid
    from public.children c
    where c.id = p_child_id and c.deleted_at is null;
  if not found then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;
  if not private.is_household_member(v_hid, array['guardian']) then
    raise exception 'not_a_guardian' using errcode = '42501';
  end if;
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.household_members m
    where m.household_id = v_hid
      and m.user_id = p_tutor_user_id
      and m.role = 'tutor'
      and m.status = 'active'
  ) then
    raise exception 'tutor_not_in_household' using errcode = '22023';
  end if;

  insert into public.child_access (child_id, household_id, tutor_user_id, granted_by)
  values (p_child_id, v_hid, p_tutor_user_id, v_uid)
  on conflict (child_id, tutor_user_id) where revoked_at is null do nothing
  returning id into v_id;

  return v_id;
end;
$$;

-- Guardian + elevation. Revokes (and tombstones) the tutor's active grant for the child.
-- Returns the number of grants revoked (0 when there was none).
create or replace function private.revoke_child_access(p_child_id uuid, p_tutor_user_id uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_hid uuid;
  v_n int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select c.household_id into v_hid from public.children c where c.id = p_child_id;
  if not found then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;
  if not private.is_household_member(v_hid, array['guardian']) then
    raise exception 'not_a_guardian' using errcode = '42501';
  end if;
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;

  update public.child_access a
    set revoked_at = now(), deleted_at = now()
    where a.child_id = p_child_id
      and a.tutor_user_id = p_tutor_user_id
      and a.revoked_at is null;
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- grown-up PIN and elevation ----------------------------------------------------------------------

-- one elevation row per user + device (re-armed on each success)
create unique index if not exists grownup_elevations_user_device_uidx
  on public.grownup_elevations (user_id, device_id);

-- Sets or changes the caller's PIN (4-6 digits, bcrypt). The first PIN needs no elevation (there is
-- nothing to protect yet); changing an existing PIN needs a live elevation.
-- Open concern: until a PIN exists, whoever holds the session can set it. Onboarding must set the
-- PIN before handing the phone over; a recovery flow (recent email OTP) is a later milestone.
create or replace function private.set_grownup_pin(p_pin text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_pin is null or p_pin !~ '^[0-9]{4,6}$' then
    raise exception 'invalid_pin_format' using errcode = '22023';
  end if;
  if p_pin ~ '^(.)\1+$' or p_pin in ('0123', '1234', '4321', '12345', '54321', '123456', '654321') then
    raise exception 'weak_pin' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('grownup_pin:' || v_uid::text, 0));

  if exists (select 1 from public.grownup_pins p where p.user_id = v_uid)
     and not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;

  insert into public.grownup_pins (user_id, pin_hash, failed_attempts, locked_until, updated_at)
  values (v_uid, extensions.crypt(p_pin, extensions.gen_salt('bf', 10)), 0, null, now())
  on conflict (user_id) do update
    set pin_hash = excluded.pin_hash,
        failed_attempts = 0,
        locked_until = null,
        updated_at = now();

  perform private.write_audit('pin_set', 'grownup_pins', v_uid::text, null);
end;
$$;

-- Verifies the PIN server-side and opens a 10 minute elevation. Returns expires_at on success and
-- NULL on a wrong PIN or while locked. It deliberately returns instead of raising on a wrong PIN:
-- raising would roll back the failed-attempt counter and defeat the rate limit.
-- Lockout: from the 5th consecutive failure the account locks for 30s * 2^(failures-5), capped at
-- 6 hours; while locked the PIN is not even checked. Success resets the counters.
create or replace function private.elevate_grownup(p_device_id text, p_pin text)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_row public.grownup_pins%rowtype;
  v_exp timestamptz;
  v_attempts int;
  v_lock_secs int;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_device_id is null or char_length(p_device_id) not between 1 and 128 then
    raise exception 'invalid_device_id' using errcode = '22023';
  end if;

  select * into v_row from public.grownup_pins p where p.user_id = v_uid for update;
  if not found then
    raise exception 'pin_not_set' using errcode = 'P0002';
  end if;

  if v_row.locked_until is not null and v_row.locked_until > now() then
    return null;
  end if;

  if p_pin is not null and p_pin ~ '^[0-9]{4,6}$'
     and v_row.pin_hash = extensions.crypt(p_pin, v_row.pin_hash) then
    v_exp := now() + interval '10 minutes';
    update public.grownup_pins p
      set failed_attempts = 0, locked_until = null
      where p.user_id = v_uid;
    -- One row per user + device, re-armed on every successful elevation: table growth is bounded
    -- by the number of devices, no purge job needed.
    -- TODO(device binding): see private.has_grownup_elevation().
    insert into public.grownup_elevations (user_id, device_id, expires_at)
    values (v_uid, p_device_id, v_exp)
    on conflict (user_id, device_id) do update
      set expires_at = excluded.expires_at, created_at = now();
    perform private.write_audit('elevation_granted', 'grownup_elevations', v_uid::text,
                                jsonb_build_object('device_id', p_device_id, 'expires_at', v_exp));
    return v_exp;
  end if;

  v_attempts := v_row.failed_attempts + 1;
  if v_attempts >= 5 then
    v_lock_secs := least((30 * power(2, least(v_attempts - 5, 12)))::int, 21600);
    update public.grownup_pins p
      set failed_attempts = v_attempts,
          locked_until = now() + make_interval(secs => v_lock_secs)
      where p.user_id = v_uid;
    perform private.write_audit('pin_locked', 'grownup_pins', v_uid::text,
                                jsonb_build_object('failed_attempts', v_attempts,
                                                   'lock_seconds', v_lock_secs));
  else
    update public.grownup_pins p
      set failed_attempts = v_attempts
      where p.user_id = v_uid;
  end if;
  return null;
end;
$$;

-- Ends the caller's elevation(s) immediately (return to child mode).
create or replace function private.end_grownup_elevation()
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  update public.grownup_elevations e
    set expires_at = now()
    where e.user_id = v_uid and e.expires_at > now();
end;
$$;

-- Caller's own PIN state, for UI: whether a PIN exists and any active lockout.
create or replace function private.get_grownup_pin_status()
returns table (has_pin boolean, locked_until timestamptz, failed_attempts int)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (p.user_id is not null),
    case when p.locked_until > now() then p.locked_until end,
    coalesce(p.failed_attempts, 0)
  from (select 1) as one
  left join public.grownup_pins p on p.user_id = (select auth.uid());
$$;

-- publishing ---------------------------------------------------------------------------------------

-- Admin (super_admin / content_editor / reviewer) at aal2. Requires an 'approved' version, a chapter
-- with 3-5 units and a version newer than the current snapshot. Inserts the immutable snapshot,
-- flips is_current, supersedes the previously published version and marks the unit/chapter
-- published. Idempotent for an already-published version (returns the existing snapshot id).
-- The review gate (lint errors, human approval) is enforced before this: only reviewer/super_admin
-- can set 'approved' (guard_unit_versions_write).
create or replace function private.publish_unit_version(p_unit_version_id uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  v_uid uuid := (select auth.uid());
  v_ver public.unit_versions%rowtype;
  v_unit public.units%rowtype;
  v_cur public.published_units%rowtype;
  v_cur_found boolean;
  v_pub_id uuid;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;

  select * into v_ver from public.unit_versions v where v.id = p_unit_version_id for update;
  if not found then
    raise exception 'unit_version_not_found' using errcode = 'P0002';
  end if;

  if v_ver.status = 'published' then
    select pu.id into v_pub_id from public.published_units pu where pu.unit_version_id = v_ver.id;
    return v_pub_id;
  end if;
  if v_ver.status = 'superseded' then
    raise exception 'unit_version_superseded' using errcode = '22023';
  end if;
  if v_ver.status <> 'approved' then
    raise exception 'unit_version_not_approved' using errcode = '22023';
  end if;
  if jsonb_typeof(v_ver.content) <> 'object' or v_ver.content = '{}'::jsonb then
    raise exception 'unit_version_content_empty' using errcode = '22023';
  end if;

  select * into v_unit from public.units u where u.id = v_ver.unit_id for update;
  if v_unit.deleted_at is not null or v_unit.status = 'archived' then
    raise exception 'unit_not_publishable' using errcode = '22023';
  end if;
  if not private.chapter_unit_count_ok(v_unit.chapter_id) then
    raise exception 'chapter_unit_count_invalid' using errcode = '22023';
  end if;

  select * into v_cur from public.published_units pu where pu.unit_id = v_ver.unit_id and pu.is_current;
  v_cur_found := found;
  if v_cur_found and v_cur.version_no >= v_ver.version then
    raise exception 'unit_version_older_than_current' using errcode = '22023';
  end if;

  update public.published_units pu set is_current = false
    where pu.unit_id = v_ver.unit_id and pu.is_current;
  update public.unit_versions v set status = 'superseded'
    where v.unit_id = v_ver.unit_id and v.status = 'published';

  insert into public.published_units
    (unit_id, unit_version_id, version_no, schema_version, content, published_by, is_current)
  values
    (v_ver.unit_id, v_ver.id, v_ver.version, v_ver.schema_version, v_ver.content, v_uid, true)
  returning id into v_pub_id;

  update public.unit_versions v set status = 'published' where v.id = v_ver.id;
  update public.units u set status = 'published' where u.id = v_unit.id and u.status = 'draft';
  update public.chapters ch set status = 'published'
    where ch.id = v_unit.chapter_id and ch.status = 'draft';

  return v_pub_id;
end;
$$;

-- grants: private implementations (callable by wrappers running as the caller) ---------------------
revoke all on function
  private.create_household(text),
  private.create_invite(uuid, text, uuid[], int),
  private.accept_invite(text),
  private.remove_member(uuid, uuid),
  private.grant_child_access(uuid, uuid),
  private.revoke_child_access(uuid, uuid),
  private.set_grownup_pin(text),
  private.elevate_grownup(text, text),
  private.end_grownup_elevation(),
  private.get_grownup_pin_status(),
  private.publish_unit_version(uuid)
  from public, anon, authenticated;

grant execute on function
  private.create_household(text),
  private.create_invite(uuid, text, uuid[], int),
  private.accept_invite(text),
  private.remove_member(uuid, uuid),
  private.grant_child_access(uuid, uuid),
  private.revoke_child_access(uuid, uuid),
  private.set_grownup_pin(text),
  private.elevate_grownup(text, text),
  private.end_grownup_elevation(),
  private.get_grownup_pin_status(),
  private.publish_unit_version(uuid)
  to authenticated;

-- public wrappers (SECURITY INVOKER) ------------------------------------------------------------------
create or replace function public.create_household(p_name text)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.create_household(p_name); $$;

create or replace function public.create_invite(
  p_household_id uuid,
  p_role text,
  p_child_ids uuid[],
  p_ttl_hours int default 72
)
returns table (invite_id uuid, token text, expires_at timestamptz)
language sql
security invoker
set search_path = ''
as $$ select * from private.create_invite(p_household_id, p_role, p_child_ids, p_ttl_hours); $$;

create or replace function public.accept_invite(p_token text)
returns table (household_id uuid, role text)
language sql
security invoker
set search_path = ''
as $$ select * from private.accept_invite(p_token); $$;

create or replace function public.remove_member(p_household_id uuid, p_user_id uuid)
returns void
language sql
security invoker
set search_path = ''
as $$ select private.remove_member(p_household_id, p_user_id); $$;

create or replace function public.grant_child_access(p_child_id uuid, p_tutor_user_id uuid)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.grant_child_access(p_child_id, p_tutor_user_id); $$;

create or replace function public.revoke_child_access(p_child_id uuid, p_tutor_user_id uuid)
returns int
language sql
security invoker
set search_path = ''
as $$ select private.revoke_child_access(p_child_id, p_tutor_user_id); $$;

create or replace function public.set_grownup_pin(p_pin text)
returns void
language sql
security invoker
set search_path = ''
as $$ select private.set_grownup_pin(p_pin); $$;

create or replace function public.elevate_grownup(p_device_id text, p_pin text)
returns timestamptz
language sql
security invoker
set search_path = ''
as $$ select private.elevate_grownup(p_device_id, p_pin); $$;

create or replace function public.end_grownup_elevation()
returns void
language sql
security invoker
set search_path = ''
as $$ select private.end_grownup_elevation(); $$;

create or replace function public.get_grownup_pin_status()
returns table (has_pin boolean, locked_until timestamptz, failed_attempts int)
language sql
security invoker
set search_path = ''
as $$ select * from private.get_grownup_pin_status(); $$;

create or replace function public.publish_unit_version(p_unit_version_id uuid)
returns uuid
language sql
security invoker
set search_path = ''
as $$ select private.publish_unit_version(p_unit_version_id); $$;

revoke all on function
  public.create_household(text),
  public.create_invite(uuid, text, uuid[], int),
  public.accept_invite(text),
  public.remove_member(uuid, uuid),
  public.grant_child_access(uuid, uuid),
  public.revoke_child_access(uuid, uuid),
  public.set_grownup_pin(text),
  public.elevate_grownup(text, text),
  public.end_grownup_elevation(),
  public.get_grownup_pin_status(),
  public.publish_unit_version(uuid)
  from public, anon, authenticated;

grant execute on function
  public.create_household(text),
  public.create_invite(uuid, text, uuid[], int),
  public.accept_invite(text),
  public.remove_member(uuid, uuid),
  public.grant_child_access(uuid, uuid),
  public.revoke_child_access(uuid, uuid),
  public.set_grownup_pin(text),
  public.elevate_grownup(text, text),
  public.end_grownup_elevation(),
  public.get_grownup_pin_status(),
  public.publish_unit_version(uuid)
  to authenticated;
