-- 03 identity tables: profiles, admin users, households, members, children, tutor grants, invites,
-- grown-up PIN and elevation. Tables only; RLS enabled here (deny-by-default). Policies, grants and
-- RPCs come in later migrations.
--
-- Children have NO auth accounts: a child is a row owned by a household.
-- Secrets (PIN hash, picture passcode hash, invite token hashes) live in tables that clients can
-- never read: RLS enabled, no policies, all privileges revoked.

-- profiles ----------------------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now()
);

comment on table public.profiles is
  'One row per auth user. NOT readable across household members; members see names via public.member_display.';

create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, display_name)
  values (
    new.id,
    nullif(left(btrim(coalesce(new.raw_user_meta_data ->> 'display_name', '')), 80), '')
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

revoke all on function private.handle_new_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- admin users -------------------------------------------------------------------------------------
create table public.admin_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null check (role in ('super_admin', 'content_editor', 'reviewer', 'support', 'analyst')),
  created_at timestamptz not null default now()
);

comment on table public.admin_users is
  'CUSTAR staff. Every admin policy/RPC goes through private.has_admin_role(), which also requires aal2.';

-- households and membership -----------------------------------------------------------------------
create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 80),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index households_created_by_idx on public.households (created_by);

create table public.household_members (
  household_id uuid not null references public.households (id) on delete cascade,
  user_id uuid not null references auth.users (id) on delete cascade,
  role text not null check (role in ('guardian', 'tutor')),
  status text not null default 'active' check (status in ('active', 'removed')),
  created_at timestamptz not null default now(),
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  primary key (household_id, user_id)
);
create index household_members_user_id_idx on public.household_members (user_id);

comment on table public.household_members is
  'No client INSERT/UPDATE/DELETE. Changes only via create_household, accept_invite and remove_member. Removal is a tombstone.';

-- children (no auth accounts) ---------------------------------------------------------------------
create table public.children (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  display_alias text not null check (char_length(display_alias) between 1 and 40),
  avatar text check (avatar is null or char_length(avatar) <= 64),
  level_code text not null references public.levels (code),
  reading_mode text not null default 'reader' check (reading_mode in ('reader', 'pre_reader')),
  daily_limit_min int check (daily_limit_min is null or daily_limit_min between 0 and 720),
  created_at timestamptz not null default now(),
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  -- target of the composite FK that keeps child_access.household_id consistent with the child
  unique (id, household_id)
);
create index children_household_id_idx on public.children (household_id);
create index children_level_code_idx on public.children (level_code);

comment on table public.children is
  'Alias only: the real name/photo of a child never enters the database. Soft delete via deleted_at (tombstone).';

create table public.child_secrets (
  child_id uuid primary key references public.children (id) on delete cascade,
  picture_passcode_hash text,
  updated_at timestamptz not null default now()
);

comment on table public.child_secrets is
  'RLS on, no policies, no client privileges: only SECURITY DEFINER code touches this table.';

-- tutor grants (per CHILD) ------------------------------------------------------------------------
create table public.child_access (
  id uuid primary key default gen_random_uuid(),
  child_id uuid not null,
  household_id uuid not null,
  tutor_user_id uuid not null references auth.users (id) on delete cascade,
  granted_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz,
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  -- household_id is denormalised; the composite FKs make it impossible to disagree with the child
  -- or to grant a user who is not a member of that household.
  constraint child_access_child_fk foreign key (child_id, household_id)
    references public.children (id, household_id) on delete cascade,
  constraint child_access_member_fk foreign key (household_id, tutor_user_id)
    references public.household_members (household_id, user_id) on delete cascade
);
-- at most one ACTIVE grant per child + tutor (history of revoked grants is kept)
create unique index child_access_one_active_idx on public.child_access (child_id, tutor_user_id)
  where revoked_at is null;
create index child_access_child_household_idx on public.child_access (child_id, household_id);
create index child_access_household_tutor_idx on public.child_access (household_id, tutor_user_id);
create index child_access_tutor_user_id_idx on public.child_access (tutor_user_id);
create index child_access_granted_by_idx on public.child_access (granted_by);

-- invites: single-use, hashed, expiring ------------------------------------------------------------
create table public.invites (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households (id) on delete cascade,
  role text not null check (role in ('guardian', 'tutor')),
  child_ids uuid[] not null default '{}',
  token_hash text not null unique,
  expires_at timestamptz not null,
  created_by uuid references auth.users (id) on delete set null,
  accepted_by uuid references auth.users (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  -- tutors are invited for specific children; guardians get the whole household
  constraint invites_role_children_chk check (
    (role = 'tutor' and cardinality(child_ids) between 1 and 20)
    or (role = 'guardian' and cardinality(child_ids) = 0)
  )
);
create index invites_household_id_idx on public.invites (household_id);
create index invites_created_by_idx on public.invites (created_by);
create index invites_accepted_by_idx on public.invites (accepted_by);

comment on table public.invites is
  'Only the sha256 hash of the token is stored. No client privileges: use create_invite / accept_invite.';

-- grown-up PIN and elevation ----------------------------------------------------------------------
create table public.grownup_pins (
  user_id uuid primary key references auth.users (id) on delete cascade,
  pin_hash text not null,
  failed_attempts int not null default 0 check (failed_attempts >= 0),
  locked_until timestamptz,
  updated_at timestamptz not null default now()
);

comment on table public.grownup_pins is
  'bcrypt PIN hash + lockout state. Never client-readable: use set_grownup_pin / elevate_grownup.';

create table public.grownup_elevations (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  device_id text not null check (char_length(device_id) between 1 and 128),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index grownup_elevations_user_expires_idx on public.grownup_elevations (user_id, expires_at);

-- sync_seq trigger + cursor index -----------------------------------------------------------------
create trigger household_members_set_sync_seq before insert or update on public.household_members
  for each row execute function private.set_sync_seq();
create index household_members_sync_seq_idx on public.household_members (sync_seq);

create trigger children_set_sync_seq before insert or update on public.children
  for each row execute function private.set_sync_seq();
create index children_sync_seq_idx on public.children (sync_seq);

create trigger child_access_set_sync_seq before insert or update on public.child_access
  for each row execute function private.set_sync_seq();
create index child_access_sync_seq_idx on public.child_access (sync_seq);

-- RLS on, nothing granted -------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.admin_users enable row level security;
alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.children enable row level security;
alter table public.child_secrets enable row level security;
alter table public.child_access enable row level security;
alter table public.invites enable row level security;
alter table public.grownup_pins enable row level security;
alter table public.grownup_elevations enable row level security;

revoke all on table
  public.profiles, public.admin_users, public.households, public.household_members, public.children,
  public.child_secrets, public.child_access, public.invites, public.grownup_pins,
  public.grownup_elevations
  from public, anon, authenticated;
