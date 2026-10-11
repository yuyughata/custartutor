-- 09 hardening follow-ups found while red-teaming the first migrations.
--
--   * create_invite: a guardian invite hands over EVERY child of the household to whoever holds the
--     bearer token, so its TTL is capped at 72 hours (tutor invites keep the 7 day cap).
--   * elevate_grownup: the lockout cap drops from 6 hours to 1 hour. A child mashing the keypad on a
--     guardian's phone must not be able to lock the grown-up out for half a day; 1 guess per hour is
--     still ~400 days to exhaust a 4-digit PIN. Everything else is unchanged.
--   * documentation: COMMENT ON the public RPCs (they surface in the PostgREST OpenAPI document).

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
  -- guardian invites expose the whole household: shorter fuse than tutor invites
  if p_ttl_hours is null
     or p_ttl_hours not between 1 and (case p_role when 'guardian' then 72 else 168 end) then
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
    -- 30s, 60s, 120s, ... capped at 1 hour
    v_lock_secs := least((30 * power(2, least(v_attempts - 5, 12)))::int, 3600);
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

comment on function public.create_household(text) is
  'Creates a household and makes the caller its guardian (max 5 per user). Any signed-in user.';
comment on function public.create_invite(uuid, text, uuid[], int) is
  'Guardian of the household + live grown-up elevation. Returns the raw invite token ONCE (only its sha256 is stored). Guardian invites: max 72h, no children; tutor invites: max 168h, 1-20 children.';
comment on function public.accept_invite(text) is
  'Any signed-in user holding a valid token. Single-use, expiring. The only way (with create_household) to become a household member.';
comment on function public.remove_member(uuid, uuid) is
  'Guardian of the household + live grown-up elevation. Tombstones the membership and the member''s child grants. The last guardian cannot be removed.';
comment on function public.grant_child_access(uuid, uuid) is
  'Guardian of the child''s household + live grown-up elevation. Grants an existing tutor of the household access to the child. Returns the grant id, or NULL if already granted.';
comment on function public.revoke_child_access(uuid, uuid) is
  'Guardian of the child''s household + live grown-up elevation. Revokes and tombstones the tutor''s active grant. Returns the number of grants revoked.';
comment on function public.set_grownup_pin(text) is
  'Sets or changes the caller''s 4-6 digit grown-up PIN (bcrypt). The first PIN needs no elevation; changing it does.';
comment on function public.elevate_grownup(text, text) is
  'Verifies the PIN server-side. Returns the elevation expiry (10 minutes) on success, NULL on a wrong PIN or while locked (5 failures lock for 30s, doubling, capped at 1h). Deliberately does not raise on a wrong PIN so the attempt counter persists.';
comment on function public.end_grownup_elevation() is
  'Ends the caller''s grown-up elevation immediately (return to child mode).';
comment on function public.get_grownup_pin_status() is
  'The caller''s own PIN state: has_pin, active lock (locked_until) and failed_attempts.';
comment on function public.publish_unit_version(uuid) is
  'Admin (super_admin, content_editor, reviewer) at aal2. Publishes an approved unit_version as an immutable snapshot, flips is_current, supersedes the previous version. Idempotent. Requires the chapter to have 3-5 units.';
comment on view public.member_display is
  'Display names of the household members the caller may see (security_invoker; profiles stay private).';
