-- 04 consent and audit tables. Both are APPEND-ONLY.
--
--   consents  : clients INSERT their own rows (guardian of the household) and SELECT their own rows.
--               Withdrawing consent is a new row with action = 'withdraw', never an UPDATE.
--   audit_log : written only by SECURITY DEFINER triggers/functions; readable only by super_admin at aal2.
--
-- UPDATE / DELETE / TRUNCATE are revoked from every API role, including service_role, which would
-- otherwise bypass RLS and could rewrite history.

create table public.consents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  household_id uuid not null references public.households (id) on delete cascade,
  child_id uuid,
  scope text not null check (char_length(scope) between 1 and 64),
  version text not null check (char_length(version) between 1 and 32),
  action text not null check (action in ('grant', 'withdraw')),
  created_at timestamptz not null default now(),
  -- when a child is named it must belong to that household (MATCH SIMPLE: skipped when child_id is null)
  constraint consents_child_household_fk foreign key (child_id, household_id)
    references public.children (id, household_id) on delete cascade
);
create index consents_user_id_idx on public.consents (user_id);
create index consents_household_id_idx on public.consents (household_id);
create index consents_child_household_idx on public.consents (child_id, household_id);

comment on table public.consents is
  'Append-only consent ledger. The effective state of a scope is its latest row (grant or withdraw).';

create table public.audit_log (
  id bigint generated always as identity primary key,
  actor uuid,
  action text not null,
  entity text not null,
  entity_id text,
  detail jsonb,
  created_at timestamptz not null default now()
);
create index audit_log_actor_idx on public.audit_log (actor);
create index audit_log_entity_idx on public.audit_log (entity, entity_id);
create index audit_log_created_at_idx on public.audit_log (created_at desc);

comment on table public.audit_log is
  'Append-only. Written by SECURITY DEFINER triggers/functions only. actor has no FK so history survives user deletion.';

alter table public.consents enable row level security;
alter table public.audit_log enable row level security;

revoke all on table public.consents, public.audit_log from public, anon, authenticated, service_role;
-- service_role may read and append (edge functions), never rewrite history
grant select, insert on table public.consents, public.audit_log to service_role;
