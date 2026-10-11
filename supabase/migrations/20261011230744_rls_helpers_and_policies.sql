-- 05 RLS helpers, guard triggers, policies, grants and the member_display view.
--
-- Helper functions live in `private` (not exposed to PostgREST), are SECURITY DEFINER with an empty
-- search_path, and are granted to `authenticated` only because policies/views evaluate them as the
-- caller. Policies use the `(select auth.uid())` form so Postgres evaluates it once per statement.
--
-- Policy shape rule: ONE permissive policy per (table, command) so that the "multiple permissive
-- policies" advisor stays quiet and the access rule for each command reads in one place.

-- helper functions --------------------------------------------------------------------------------

-- Active membership of the caller in a household with one of the given roles.
create or replace function private.is_household_member(hid uuid, roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.household_members m
    where m.household_id = hid
      and m.user_id = (select auth.uid())
      and m.status = 'active'
      and m.deleted_at is null
      and m.role = any (roles)
  );
$$;

-- Caller is an active tutor with an active (non-revoked) grant for this child.
-- Takes only the child id so it can be used in the children policy itself.
create or replace function private.is_granted_tutor(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.child_access a
    join public.household_members m
      on m.household_id = a.household_id
     and m.user_id = a.tutor_user_id
    where a.child_id = cid
      and a.tutor_user_id = (select auth.uid())
      and a.revoked_at is null
      and a.deleted_at is null
      and m.role = 'tutor'
      and m.status = 'active'
      and m.deleted_at is null
  );
$$;

-- Guardian of the child's household, OR tutor with an active grant for the child.
-- Use this on every child-data table (progress, sessions, ...) that carries child_id.
create or replace function private.can_access_child(cid uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.children c
    where c.id = cid
      and private.is_household_member(c.household_id, array['guardian'])
  )
  or private.is_granted_tutor(cid);
$$;

-- Admin role check. ALWAYS requires aal2 (TOTP-verified session): an aal1 session of an admin sees
-- nothing through admin policies/RPCs.
create or replace function private.has_admin_role(roles text[])
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((select auth.jwt() ->> 'aal'), '') = 'aal2'
    and exists (
      select 1
      from public.admin_users au
      where au.user_id = (select auth.uid())
        and au.role = any (roles)
    );
$$;

-- Caller holds an unexpired grown-up elevation (PIN verified server-side by elevate_grownup).
-- TODO(device binding): any device is accepted in M0. Bind the elevation to the auth session by
-- storing the JWT `session_id` claim next to device_id and comparing it here.
create or replace function private.has_grownup_elevation()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.grownup_elevations e
    where e.user_id = (select auth.uid())
      and e.expires_at > now()
  );
$$;

-- Display name of a household member, visible only to members of that same household.
-- Backs public.member_display; profiles themselves stay unreadable across members.
create or replace function private.member_display_name(hid uuid, uid uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.display_name
  from public.profiles p
  where p.id = uid
    and private.is_household_member(hid, array['guardian', 'tutor'])
    and exists (
      select 1
      from public.household_members t
      where t.household_id = hid
        and t.user_id = uid
        and t.status = 'active'
    );
$$;

-- A chapter may be published only with 3 to 5 live units (checked by publish_unit_version,
-- deliberately NOT a hard constraint so chapters can be drafted incrementally).
create or replace function private.chapter_unit_count_ok(p_chapter_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select count(*) between 3 and 5
  from public.units u
  where u.chapter_id = p_chapter_id
    and u.deleted_at is null
    and u.status <> 'archived';
$$;

revoke all on function
  private.is_household_member(uuid, text[]),
  private.is_granted_tutor(uuid),
  private.can_access_child(uuid),
  private.has_admin_role(text[]),
  private.has_grownup_elevation(),
  private.member_display_name(uuid, uuid),
  private.chapter_unit_count_ok(uuid)
  from public, anon, authenticated;

grant execute on function
  private.is_household_member(uuid, text[]),
  private.is_granted_tutor(uuid),
  private.can_access_child(uuid),
  private.has_admin_role(text[]),
  private.has_grownup_elevation(),
  private.member_display_name(uuid, uuid)
  to authenticated;
-- chapter_unit_count_ok is only called from SECURITY DEFINER code: no grant.

-- guard triggers ----------------------------------------------------------------------------------
-- SECURITY INVOKER on purpose: current_user is the calling API role, so privileged code paths
-- (SECURITY DEFINER RPCs run as the owner, service_role) pass through while direct client writes
-- through PostgREST are checked.

-- children: ids are immutable; deleting/restoring a child and changing the daily limit are
-- parental-control actions, so they need a live grown-up elevation (a child holding the
-- guardian's phone must not be able to lift their own limit or delete a sibling).
create or replace function private.guard_children_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'UPDATE' then
    if new.id is distinct from old.id or new.household_id is distinct from old.household_id then
      raise exception 'children_identity_immutable' using errcode = '42501';
    end if;
    if new.deleted_at is distinct from old.deleted_at
       or new.daily_limit_min is distinct from old.daily_limit_min then
      if not private.has_grownup_elevation() then
        raise exception 'elevation_required' using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create trigger children_guard_write before insert or update on public.children
  for each row execute function private.guard_children_write();

-- unit_versions: enforce the review workflow below the RLS layer.
--   * new drafts start as 'draft'
--   * 'published' / 'superseded' are set only by publish_unit_version (owner context)
--   * only reviewer / super_admin may move a version to 'approved'
--   * an approved version's content is frozen; published/superseded rows are immutable
--   * provenance columns never change
create or replace function private.guard_unit_versions_write()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status <> 'draft' then
      raise exception 'unit_version_must_start_as_draft' using errcode = '42501';
    end if;
    return new;
  end if;

  if old.status in ('published', 'superseded') then
    raise exception 'unit_version_immutable' using errcode = '42501';
  end if;
  if new.status in ('published', 'superseded') then
    raise exception 'use_publish_unit_version' using errcode = '42501';
  end if;
  if (new.id, new.unit_id, new.version, new.generated_by, new.model, new.prompt_version,
      new.base_version_id, new.created_by, new.created_at)
     is distinct from
     (old.id, old.unit_id, old.version, old.generated_by, old.model, old.prompt_version,
      old.base_version_id, old.created_by, old.created_at) then
    raise exception 'unit_version_provenance_immutable' using errcode = '42501';
  end if;
  if old.status = 'approved' and new.status = 'approved'
     and (new.content is distinct from old.content
          or new.schema_version is distinct from old.schema_version) then
    raise exception 'approved_version_is_frozen' using errcode = '42501';
  end if;
  if new.status = 'approved' and old.status <> 'approved' then
    if not (select private.has_admin_role(array['super_admin', 'reviewer'])) then
      raise exception 'reviewer_required' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create trigger unit_versions_guard_write before insert or update on public.unit_versions
  for each row execute function private.guard_unit_versions_write();

-- chapters / units: 'published' is reached only through publish_unit_version.
-- (Unpublishing / archiving a published row needs its own RPC; blocked for clients until then.)
create or replace function private.guard_publish_status()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.status = 'published' then
      raise exception 'use_publish_unit_version' using errcode = '42501';
    end if;
  elsif new.status is distinct from old.status and 'published' in (new.status, old.status) then
    raise exception 'use_publish_unit_version' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger chapters_guard_publish_status before insert or update on public.chapters
  for each row execute function private.guard_publish_status();
create trigger units_guard_publish_status before insert or update on public.units
  for each row execute function private.guard_publish_status();

-- published_units: immutable snapshots for EVERY role (including the owner and service_role).
-- Only the pointer/tombstone columns (is_current, deleted_at, sync_seq) may change; DELETE is
-- refused. published_by may only be nulled (FK action when an admin account is deleted).
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
      new.published_at)
     is distinct from
     (old.id, old.unit_id, old.unit_version_id, old.version_no, old.schema_version, old.content,
      old.published_at)
     or (new.published_by is distinct from old.published_by and new.published_by is not null) then
    raise exception 'published_units_are_immutable' using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger published_units_protect before update or delete on public.published_units
  for each row execute function private.protect_published_units();

revoke all on function
  private.guard_children_write(),
  private.guard_unit_versions_write(),
  private.guard_publish_status(),
  private.protect_published_units()
  from public, anon, authenticated;

-- policies and grants: identity ------------------------------------------------------------------

-- profiles: own row only; display_name is the only editable column
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));
grant select on public.profiles to authenticated;
grant update (display_name) on public.profiles to authenticated;

-- admin_users: own row (so the admin app can learn its role), or super_admin at aal2
create policy admin_users_select on public.admin_users
  for select to authenticated
  using (user_id = (select auth.uid()) or (select private.has_admin_role(array['super_admin'])));
create policy admin_users_insert on public.admin_users
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin'])));
create policy admin_users_update on public.admin_users
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin'])))
  with check ((select private.has_admin_role(array['super_admin'])));
create policy admin_users_delete on public.admin_users
  for delete to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update, delete on public.admin_users to authenticated;

-- households: members read; guardians rename; creation only via create_household
create policy households_select on public.households
  for select to authenticated
  using (private.is_household_member(id, array['guardian', 'tutor']));
create policy households_update on public.households
  for update to authenticated
  using (private.is_household_member(id, array['guardian']))
  with check (private.is_household_member(id, array['guardian']));
grant select on public.households to authenticated;
grant update (name) on public.households to authenticated;

-- household_members: READ ONLY for clients. Guardians see the whole household; a tutor sees only
-- their own row and the guardians (not other tutors, who may serve other children).
create policy household_members_select on public.household_members
  for select to authenticated
  using (
    user_id = (select auth.uid())
    or private.is_household_member(household_id, array['guardian'])
    or (role = 'guardian' and private.is_household_member(household_id, array['tutor']))
  );
grant select on public.household_members to authenticated;

-- children: guardians insert/update (soft delete = set deleted_at, needs elevation); tutors read
-- only granted children. No DELETE privilege: removal is a tombstone.
create policy children_select on public.children
  for select to authenticated
  using (
    private.is_household_member(household_id, array['guardian'])
    or private.is_granted_tutor(id)
  );
create policy children_insert on public.children
  for insert to authenticated
  with check (private.is_household_member(household_id, array['guardian']));
create policy children_update on public.children
  for update to authenticated
  using (private.is_household_member(household_id, array['guardian']))
  with check (private.is_household_member(household_id, array['guardian']));
grant select on public.children to authenticated;
grant insert (id, household_id, display_alias, avatar, level_code, reading_mode, daily_limit_min)
  on public.children to authenticated;
grant update (display_alias, avatar, level_code, reading_mode, daily_limit_min, deleted_at)
  on public.children to authenticated;

-- child_secrets, invites, grownup_pins, grownup_elevations: RLS on, NO policies, NO grants.

-- child_access: guardians read the household's grants, a tutor reads their own. Writes only via
-- accept_invite / grant_child_access / revoke_child_access / remove_member.
create policy child_access_select on public.child_access
  for select to authenticated
  using (
    tutor_user_id = (select auth.uid())
    or private.is_household_member(household_id, array['guardian'])
  );
grant select on public.child_access to authenticated;

-- consents: append-only. A guardian inserts rows for their own household as themselves; granting
-- needs a live elevation (a child must not consent on the parent's behalf), withdrawing does not.
create policy consents_select_own on public.consents
  for select to authenticated
  using (user_id = (select auth.uid()));
create policy consents_insert_own on public.consents
  for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and private.is_household_member(household_id, array['guardian'])
    and (action = 'withdraw' or (select private.has_grownup_elevation()))
  );
grant select, insert on public.consents to authenticated;

-- audit_log: super_admin at aal2 only; nobody writes through the API
create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select on public.audit_log to authenticated;

-- policies and grants: curriculum ------------------------------------------------------------------
-- Role subsets: read = super_admin, content_editor, reviewer; write = super_admin, content_editor.
-- support and analyst get NO access to any curriculum draft or household data.

-- levels / subjects: reference data readable by every signed-in user
create policy levels_select on public.levels
  for select to authenticated using (true);
create policy levels_insert on public.levels
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin'])));
create policy levels_update on public.levels
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin'])))
  with check ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update on public.levels to authenticated;

create policy subjects_select on public.subjects
  for select to authenticated using (true);
create policy subjects_insert on public.subjects
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy subjects_update on public.subjects
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
grant select, insert, update on public.subjects to authenticated;

-- characters: active cast readable by everyone (the tutor edge function reads them with the
-- caller's JWT); inactive ones only by content staff
create policy characters_select on public.characters
  for select to authenticated
  using (active or (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy characters_insert on public.characters
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy characters_update on public.characters
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
grant select, insert, update on public.characters to authenticated;

-- planning tables: admin only
create policy schemes_select on public.schemes
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy schemes_insert on public.schemes
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy schemes_update on public.schemes
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy schemes_delete on public.schemes
  for delete to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update, delete on public.schemes to authenticated;

create policy scheme_weeks_select on public.scheme_weeks
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy scheme_weeks_insert on public.scheme_weeks
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy scheme_weeks_update on public.scheme_weeks
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy scheme_weeks_delete on public.scheme_weeks
  for delete to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update, delete on public.scheme_weeks to authenticated;

create policy themes_select on public.themes
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy themes_insert on public.themes
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy themes_update on public.themes
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy themes_delete on public.themes
  for delete to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update, delete on public.themes to authenticated;

create policy theme_units_select on public.theme_units
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy theme_units_insert on public.theme_units
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy theme_units_update on public.theme_units
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy theme_units_delete on public.theme_units
  for delete to authenticated
  using ((select private.has_admin_role(array['super_admin'])));
grant select, insert, update, delete on public.theme_units to authenticated;

-- chapters / units: learners see only published rows; content staff see everything. Soft delete only.
create policy chapters_select on public.chapters
  for select to authenticated
  using (
    status = 'published'
    or (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']))
  );
create policy chapters_insert on public.chapters
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy chapters_update on public.chapters
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
grant select, insert, update on public.chapters to authenticated;

create policy units_select on public.units
  for select to authenticated
  using (
    status = 'published'
    or (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']))
  );
create policy units_insert on public.units
  for insert to authenticated
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
create policy units_update on public.units
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor'])));
grant select, insert, update on public.units to authenticated;

-- unit_versions: ADMIN ONLY (drafts and lint reports are never readable by non-admins, nor by an
-- admin at aal1). Reviewers may update (approve / send back); editors create and edit drafts.
-- No DELETE privilege: version history is kept.
create policy unit_versions_select on public.unit_versions
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
create policy unit_versions_insert on public.unit_versions
  for insert to authenticated
  with check (
    (select private.has_admin_role(array['super_admin', 'content_editor']))
    and created_by = (select auth.uid())
  );
create policy unit_versions_update on public.unit_versions
  for update to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])))
  with check ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
grant select, insert, update on public.unit_versions to authenticated;

-- published_units: current, non-tombstoned snapshots for every signed-in user; content staff also
-- see history. NO write privilege for clients: rows are created and flipped by publish_unit_version.
create policy published_units_select on public.published_units
  for select to authenticated
  using (
    (is_current and deleted_at is null)
    or (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']))
  );
grant select on public.published_units to authenticated;
revoke insert, update, delete, truncate on public.published_units from service_role;

-- member_display: names of the people the caller can see in their households, nothing else.
-- security_invoker => rows are filtered by household_members RLS as the caller; the name lookup goes
-- through a definer function that re-checks shared membership.
create view public.member_display
  with (security_invoker = true)
  as
  select
    m.household_id,
    m.user_id,
    private.member_display_name(m.household_id, m.user_id) as display_name,
    m.role
  from public.household_members m
  where m.status = 'active'
    and m.deleted_at is null;

revoke all on public.member_display from public, anon, authenticated;
grant select on public.member_display to authenticated;
