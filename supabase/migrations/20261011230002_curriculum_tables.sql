-- 02 curriculum tables: levels, subjects, schemes, themes, characters, chapters, units, drafts and the
-- published snapshot. Tables only; RLS enabled here (deny-by-default), policies/grants in a later file.
--
-- Draft vs published: `unit_versions` (drafts, lint reports) is ADMIN-ONLY. Learners read only
-- `published_units` (immutable snapshots, one current per unit).

-- levels ------------------------------------------------------------------------------------------
create table public.levels (
  code text primary key check (code in ('P1', 'P2', 'P3', 'P4', 'P5', 'P6')),
  name text not null,
  stage text not null check (stage in ('absorb', 'connect', 'express')),
  sort int not null,
  sync_seq bigint not null default 0,
  deleted_at timestamptz
);

-- subjects ----------------------------------------------------------------------------------------
create table public.subjects (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  kind text not null check (kind in ('core', 'elective', 'extracurricular')),
  curriculum_source text not null check (curriculum_source in ('nerdc', 'global')),
  icon text,
  colour text,
  sort int not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  sync_seq bigint not null default 0,
  deleted_at timestamptz
);

-- schemes of work (NERDC base layer; never rewritten by AI generation) ------------------------------
create table public.schemes (
  id uuid primary key default gen_random_uuid(),
  subject_id uuid not null references public.subjects (id),
  level_code text not null references public.levels (code),
  term int not null check (term between 1 and 3),
  status text not null default 'draft' check (status in ('draft', 'approved', 'archived')),
  source_note text,
  created_at timestamptz not null default now(),
  unique (subject_id, level_code, term)
);
create index schemes_level_code_idx on public.schemes (level_code);

create table public.scheme_weeks (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references public.schemes (id) on delete cascade,
  week_no int not null check (week_no between 1 and 20),
  kind text not null check (kind in ('teaching', 'mid_term_exam', 'break', 'revision', 'exam', 'closing')),
  topic text,
  subtopics text[] not null default '{}',
  unique (scheme_id, week_no)
);

-- themes and characters ---------------------------------------------------------------------------
create table public.themes (
  id uuid primary key default gen_random_uuid(),
  term int not null check (term between 1 and 3),
  title text not null,
  description text,
  created_at timestamptz not null default now()
);

create table public.characters (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  name text not null,
  traits jsonb not null default '{}'::jsonb,
  voice jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

comment on table public.characters is
  'Cast bible. traits/voice are empty stubs until the character bible is supplied (it must not be guessed).';

-- chapters and units ------------------------------------------------------------------------------
create table public.chapters (
  id uuid primary key default gen_random_uuid(),
  scheme_id uuid not null references public.schemes (id),
  number int not null check (number >= 1),
  title text not null,
  theme_id uuid references public.themes (id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  unique (scheme_id, number)
);
create index chapters_theme_id_idx on public.chapters (theme_id);

create table public.units (
  id uuid primary key default gen_random_uuid(),
  chapter_id uuid not null references public.chapters (id),
  unit_no int not null check (unit_no >= 1),
  week_no int check (week_no between 1 and 20),
  kind text not null check (kind in ('lesson', 'mini_project', 'term_project', 'revision', 'assessment')),
  title text not null,
  objective text,
  stage text not null check (stage in ('absorb', 'connect', 'express')),
  periods int not null default 1 check (periods between 1 and 10),
  status text not null default 'draft' check (status in ('draft', 'published', 'archived')),
  created_at timestamptz not null default now(),
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  unique (chapter_id, unit_no)
);

create table public.theme_units (
  theme_id uuid not null references public.themes (id) on delete cascade,
  unit_id uuid not null references public.units (id) on delete cascade,
  lens text,
  primary key (theme_id, unit_id)
);
create index theme_units_unit_id_idx on public.theme_units (unit_id);

-- drafts: ADMIN ONLY ------------------------------------------------------------------------------
create table public.unit_versions (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units (id),
  version int not null check (version >= 1),
  schema_version int not null check (schema_version >= 1),
  content jsonb not null default '{}'::jsonb,
  status text not null default 'draft'
    check (status in ('draft', 'in_review', 'approved', 'published', 'superseded')),
  generated_by text not null check (generated_by in ('ai', 'human')),
  model text,
  prompt_version text,
  lint_report jsonb,
  base_version_id uuid references public.unit_versions (id),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  unique (unit_id, version)
);
create index unit_versions_base_version_id_idx on public.unit_versions (base_version_id);
create index unit_versions_created_by_idx on public.unit_versions (created_by);

-- published snapshots: immutable, one current per unit ---------------------------------------------
create table public.published_units (
  id uuid primary key default gen_random_uuid(),
  unit_id uuid not null references public.units (id),
  unit_version_id uuid not null unique references public.unit_versions (id),
  version_no int not null,
  schema_version int not null,
  content jsonb not null,
  published_by uuid references auth.users (id) on delete set null,
  published_at timestamptz not null default now(),
  is_current boolean not null default false,
  sync_seq bigint not null default 0,
  deleted_at timestamptz,
  unique (unit_id, version_no)
);
create unique index published_units_one_current_idx on public.published_units (unit_id) where is_current;
create index published_units_published_by_idx on public.published_units (published_by);

-- sync_seq trigger + cursor index on every syncable curriculum table -------------------------------
create trigger levels_set_sync_seq before insert or update on public.levels
  for each row execute function private.set_sync_seq();
create index levels_sync_seq_idx on public.levels (sync_seq);

create trigger subjects_set_sync_seq before insert or update on public.subjects
  for each row execute function private.set_sync_seq();
create index subjects_sync_seq_idx on public.subjects (sync_seq);

create trigger chapters_set_sync_seq before insert or update on public.chapters
  for each row execute function private.set_sync_seq();
create index chapters_sync_seq_idx on public.chapters (sync_seq);

create trigger units_set_sync_seq before insert or update on public.units
  for each row execute function private.set_sync_seq();
create index units_sync_seq_idx on public.units (sync_seq);

create trigger published_units_set_sync_seq before insert or update on public.published_units
  for each row execute function private.set_sync_seq();
create index published_units_sync_seq_idx on public.published_units (sync_seq);

-- RLS on, nothing granted (policies and grants come later) ------------------------------------------
alter table public.levels enable row level security;
alter table public.subjects enable row level security;
alter table public.schemes enable row level security;
alter table public.scheme_weeks enable row level security;
alter table public.themes enable row level security;
alter table public.characters enable row level security;
alter table public.chapters enable row level security;
alter table public.units enable row level security;
alter table public.theme_units enable row level security;
alter table public.unit_versions enable row level security;
alter table public.published_units enable row level security;

revoke all on table
  public.levels, public.subjects, public.schemes, public.scheme_weeks, public.themes, public.characters,
  public.chapters, public.units, public.theme_units, public.unit_versions, public.published_units
  from public, anon, authenticated;
