-- 10 sync cursor ordering, membership epoch and re-stamping of the flattened units (M1.3).
--
-- 1. THE CURSOR GOTCHA. sync_seq comes from one global sequence, but a sequence number is drawn when
--    the row is WRITTEN and becomes visible when the transaction COMMITS. Transaction A can draw 41,
--    transaction B can draw 42 and commit first; a reader that sees 42 and stores it as its cursor
--    would never see 41 once A commits. Fix: every statement that stamps a sync_seq first takes ONE
--    global transaction-level advisory lock (held until commit/rollback) and only then calls
--    nextval(). Writers that stamp therefore run strictly one after the other, so
--
--      draw order == commit order == visibility order.
--
--    Locks are released only after the commit is visible to new snapshots (ProcArrayEndTransaction
--    runs before the lock release in CommitTransaction), so a transaction that later draws N+1 can
--    only start after N is visible to every snapshot taken from then on. A reader that runs in ONE
--    snapshot (sync_pull is STABLE: all its statements share the calling statement's snapshot) can
--    therefore never observe N+1 without N. Aborted transactions merely leave gaps, which a
--    "greater than the cursor" scan does not care about.
--
--    Cost: stamping writers are serialised until commit. The write volume of this product is tiny
--    (a few progress events per child per day) and every stamping transaction is short. Known
--    limit: two transactions that stamp rows in opposite orders AND hold row locks on the other's
--    rows can deadlock; Postgres aborts one with 40P01 and the caller retries. RPCs avoid this by
--    doing all their non-stamping work first (see private.ingest_progress_events).
--
-- 2. MEMBERSHIP EPOCH. households.membership_epoch changes whenever access to the household's data
--    changes; the client wipes its household data and re-pulls from cursor 0 when it differs from
--    the stored value. The value comes from one global sequence (not "+1"), so two households can
--    never report the same epoch: a user whose primary household changes always sees a new value.
--
-- 3. UNIT RE-STAMPING. sync_pull sends a FLATTENED unit (unit + chapter + scheme fields) and only
--    for units with a live published pack. Its sync_seq must advance whenever any of those inputs
--    change, so triggers on chapters, schemes and published_units touch the unit rows.

-- 1. cursor ordering ---------------------------------------------------------------------------------
-- The key is hashtextextended('custar.sync_seq', 0). Not callable by any API role.
create or replace function private.sync_lock()
returns void
language sql
set search_path = ''
as $$
  select pg_advisory_xact_lock(1543551832891593539::bigint);
$$;

revoke all on function private.sync_lock() from public, anon, authenticated;

create or replace function private.set_sync_seq()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- Lock FIRST, then draw: sequence order must equal commit order (see the header of
  -- 20261012050000_sync_cursor_and_epoch.sql). Re-entrant for the same transaction.
  perform private.sync_lock();
  -- SECURITY DEFINER so that callers never need privileges on the sequence.
  new.sync_seq := nextval('public.sync_seq_global');
  return new;
end;
$$;

revoke all on function private.set_sync_seq() from public, anon, authenticated;

-- 2. membership epoch ---------------------------------------------------------------------------------
create sequence if not exists public.membership_epoch_seq as integer;
revoke all on sequence public.membership_epoch_seq from public, anon, authenticated;

alter table public.households
  add column membership_epoch int not null default nextval('public.membership_epoch_seq')
    check (membership_epoch >= 1);

comment on column public.households.membership_epoch is
  'Changes (new value from membership_epoch_seq) whenever access to the household data changes: member added/removed/role change, tutor grant given/revoked, child deleted/restored. Epoch 0 is reserved for "no household".';

create or replace function private.bump_membership_epoch(p_household_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.households h
     set membership_epoch = nextval('public.membership_epoch_seq')
   where h.id = p_household_id;
$$;

revoke all on function private.bump_membership_epoch(uuid) from public, anon, authenticated;

create or replace function private.epoch_after_household_member_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.bump_membership_epoch(old.household_id);
  elsif tg_op = 'INSERT' then
    perform private.bump_membership_epoch(new.household_id);
  elsif (old.status, old.role, old.deleted_at) is distinct from (new.status, new.role, new.deleted_at) then
    perform private.bump_membership_epoch(new.household_id);
  end if;
  return null;
end;
$$;

create or replace function private.epoch_after_child_access_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    perform private.bump_membership_epoch(old.household_id);
  elsif tg_op = 'INSERT' then
    perform private.bump_membership_epoch(new.household_id);
  elsif (old.revoked_at, old.deleted_at) is distinct from (new.revoked_at, new.deleted_at) then
    perform private.bump_membership_epoch(new.household_id);
  end if;
  return null;
end;
$$;

create or replace function private.epoch_after_child_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- soft delete and restore (the only changes that alter which children a device may hold)
  if new.deleted_at is distinct from old.deleted_at then
    perform private.bump_membership_epoch(new.household_id);
  end if;
  return null;
end;
$$;

revoke all on function
  private.epoch_after_household_member_change(),
  private.epoch_after_child_access_change(),
  private.epoch_after_child_change()
  from public, anon, authenticated;

create trigger household_members_epoch after insert or update or delete on public.household_members
  for each row execute function private.epoch_after_household_member_change();
create trigger child_access_epoch after insert or update or delete on public.child_access
  for each row execute function private.epoch_after_child_access_change();
create trigger children_epoch after update on public.children
  for each row execute function private.epoch_after_child_change();

-- 3. re-stamping the flattened units -------------------------------------------------------------------
-- A no-op UPDATE still runs the BEFORE UPDATE trigger, which draws a fresh sync_seq. SECURITY DEFINER so
-- the units guard trigger sees the owner (it lets the owner through) and clients need no privilege.
create or replace function private.touch_units(p_unit_id uuid, p_chapter_id uuid, p_scheme_id uuid)
returns void
language sql
security definer
set search_path = ''
as $$
  update public.units u
     set unit_no = u.unit_no
   where (p_unit_id is not null and u.id = p_unit_id)
      or (p_chapter_id is not null and u.chapter_id = p_chapter_id)
      or (p_scheme_id is not null
          and u.chapter_id in (select c.id from public.chapters c where c.scheme_id = p_scheme_id));
$$;

create or replace function private.touch_units_after_chapter_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.touch_units(null, new.id, null);
  return null;
end;
$$;

create or replace function private.touch_units_after_scheme_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.touch_units(null, null, new.id);
  return null;
end;
$$;

create or replace function private.touch_unit_after_publish_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.touch_units(new.unit_id, null, null);
  return null;
end;
$$;

revoke all on function
  private.touch_units(uuid, uuid, uuid),
  private.touch_units_after_chapter_change(),
  private.touch_units_after_scheme_change(),
  private.touch_unit_after_publish_change()
  from public, anon, authenticated;

create trigger chapters_touch_units after update on public.chapters
  for each row
  when (old.number is distinct from new.number
        or old.title is distinct from new.title
        or old.scheme_id is distinct from new.scheme_id
        or old.deleted_at is distinct from new.deleted_at)
  execute function private.touch_units_after_chapter_change();

create trigger schemes_touch_units after update on public.schemes
  for each row
  when (old.subject_id is distinct from new.subject_id
        or old.level_code is distinct from new.level_code
        or old.term is distinct from new.term)
  execute function private.touch_units_after_scheme_change();

create trigger published_units_touch_unit after insert or update on public.published_units
  for each row execute function private.touch_unit_after_publish_change();
