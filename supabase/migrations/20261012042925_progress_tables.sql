-- 11 progress_events (append-only) and unit_progress (derived), plus the idempotent derivation.
--
--   progress_events : one row per learner event, written ONLY by private.ingest_progress_events (no client
--                     INSERT/UPDATE/DELETE privilege or policy). household_id is looked up from the child on
--                     the server and is never trusted from the client. UPDATE / DELETE / TRUNCATE are revoked
--                     from every API role, service_role included.
--   unit_progress   : server-derived state per (child, unit), recomputed from the events by
--                     private.derive_unit_progress (idempotent, commutative; see UnitProgressRow in
--                     packages/learner-core/src/wire.ts). Syncable: sync_seq + deleted_at.

create table public.progress_events (
  household_id uuid not null,
  child_id uuid not null,
  client_event_id uuid not null,
  device_id text not null check (char_length(device_id) between 1 and 128),
  device_seq bigint not null check (device_seq >= 1),
  unit_id uuid not null references public.units (id),
  event_type text not null check (
    event_type in ('unit_started', 'section_completed', 'question_answered',
                   'mastery_check_completed', 'unit_completed')
  ),
  payload jsonb not null default '{}'::jsonb check (jsonb_typeof(payload) = 'object'),
  -- device time of the action: untrusted, never used as a cursor
  occurred_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (child_id, client_event_id),
  -- household_id is denormalised; the composite FK makes it impossible to disagree with the child
  constraint progress_events_child_household_fk foreign key (child_id, household_id)
    references public.children (id, household_id) on delete cascade
);
create index progress_events_child_unit_idx on public.progress_events (child_id, unit_id, occurred_at);
create index progress_events_child_household_received_idx
  on public.progress_events (child_id, household_id, received_at);
create index progress_events_unit_id_idx on public.progress_events (unit_id);

comment on table public.progress_events is
  'Append-only learner events. Written only by ingest_progress_events (idempotent on (child_id, client_event_id)). household_id is stamped from the child server-side.';

create table public.unit_progress (
  child_id uuid not null,
  unit_id uuid not null references public.units (id),
  household_id uuid not null,
  -- the server stores only these two; locked/available are computed on the device
  status text not null check (status in ('in_progress', 'mastered')),
  mastery_score numeric(5, 4) check (mastery_score is null or mastery_score between 0 and 1),
  attempts int not null default 0 check (attempts >= 0),
  last_section text,
  updated_at timestamptz not null,
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  primary key (child_id, unit_id),
  constraint unit_progress_child_household_fk foreign key (child_id, household_id)
    references public.children (id, household_id) on delete cascade
);
create index unit_progress_household_sync_idx on public.unit_progress (household_id, sync_seq);
create index unit_progress_child_household_idx on public.unit_progress (child_id, household_id);
create index unit_progress_unit_id_idx on public.unit_progress (unit_id);

comment on table public.unit_progress is
  'Derived by private.derive_unit_progress from progress_events. No client writes. Mastery never moves backwards.';

create trigger unit_progress_set_sync_seq before insert or update on public.unit_progress
  for each row execute function private.set_sync_seq();

-- RLS: reads through can_access_child (guardian of the household, or tutor with an active grant). There is
-- NO client write policy and no write privilege: rows change only through the ingest RPC.
alter table public.progress_events enable row level security;
alter table public.unit_progress enable row level security;

revoke all on table public.progress_events, public.unit_progress
  from public, anon, authenticated, service_role;
grant select on table public.progress_events, public.unit_progress to authenticated, service_role;

create policy progress_events_select on public.progress_events
  for select to authenticated
  using (private.can_access_child(child_id));
create policy unit_progress_select on public.unit_progress
  for select to authenticated
  using (private.can_access_child(child_id));

-- Recomputes one child's progress on one unit from the unit's events, exactly as documented in
-- UnitProgressRow (wire.ts) and as mirrored by deriveUnitProgress (learner-core/mastery.ts):
--   * mastered  iff any mastery_check_completed has passed = true, otherwise in_progress (when any event);
--   * mastery_score = best score over mastery_check_completed (rounded to 4 decimals), null if none;
--   * attempts  = number of mastery_check_completed rows (client_event_id is unique, so duplicates cannot count twice);
--   * last_section = section_id of the section_completed with the greatest (occurred_at, client_event_id);
--   * updated_at = greatest occurred_at over the unit's events.
-- Idempotent and commutative (it reads the whole event set, not a delta) and it only writes when a value
-- actually changes, so re-deriving never churns sync_seq. 'mastered' is never downgraded.
--
-- Concurrency: the global sync lock is taken FIRST (it is needed to stamp sync_seq anyway). It serialises
-- derivations, and in READ COMMITTED the aggregate below, a new statement, then sees every event committed by
-- the transactions that held the lock before us; each ingest derives after inserting its own events, so the
-- last deriver always sees all events.
create or replace function private.derive_unit_progress(p_child_id uuid, p_unit_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hid uuid;
  v_n bigint;
  v_updated timestamptz;
  v_mastered boolean;
  v_best numeric;
  v_attempts int;
  v_last_section text;
  v_old_status text;
  v_status text;
  v_score numeric(5, 4);
begin
  perform private.sync_lock();

  select c.household_id into v_hid from public.children c where c.id = p_child_id;
  if not found then
    return;
  end if;

  select
    count(*),
    max(e.occurred_at),
    coalesce(bool_or((e.payload ->> 'passed')::boolean)
             filter (where e.event_type = 'mastery_check_completed'), false),
    max((e.payload ->> 'score')::numeric) filter (where e.event_type = 'mastery_check_completed'),
    (count(*) filter (where e.event_type = 'mastery_check_completed'))::int,
    (array_agg(e.payload ->> 'section_id' order by e.occurred_at desc, e.client_event_id desc)
       filter (where e.event_type = 'section_completed'))[1]
  into v_n, v_updated, v_mastered, v_best, v_attempts, v_last_section
  from public.progress_events e
  where e.child_id = p_child_id and e.unit_id = p_unit_id;

  if v_n = 0 then
    return; -- no events, no progress row
  end if;

  select up.status into v_old_status
    from public.unit_progress up
   where up.child_id = p_child_id and up.unit_id = p_unit_id;

  v_status := case when v_mastered or v_old_status = 'mastered' then 'mastered' else 'in_progress' end;
  v_score := round(v_best, 4);

  update public.unit_progress up
     set status = v_status,
         mastery_score = v_score,
         attempts = v_attempts,
         last_section = v_last_section,
         updated_at = v_updated
   where up.child_id = p_child_id
     and up.unit_id = p_unit_id
     and (up.status, up.mastery_score, up.attempts, up.last_section, up.updated_at)
         is distinct from (v_status, v_score, v_attempts, v_last_section, v_updated);

  if not found and v_old_status is null then
    insert into public.unit_progress
      (child_id, unit_id, household_id, status, mastery_score, attempts, last_section, updated_at)
    values
      (p_child_id, p_unit_id, v_hid, v_status, v_score, v_attempts, v_last_section, v_updated);
  end if;
end;
$$;

revoke all on function private.derive_unit_progress(uuid, uuid) from public, anon, authenticated;
