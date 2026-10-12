-- 14 M2 content engine, part 1: app_settings, ai_jobs, ai_usage (docs/m2-plan.md, ADR 0007).
--
--   app_settings : key/value settings of the content engine (models, kill switch, budgets, prices, effort,
--                  prompt version). Content staff read; ONLY the super_admin RPC `set_app_setting` writes. Audited.
--   ai_jobs      : one row per content-engine job (scheme_ingest, chapter_plan, unit_generate, unit_revise).
--                  Clients read their own jobs (a super_admin all) through COLUMN-LEVEL grants that exclude
--                  `params`, `input`, `state`, `lease_token`: polling stays cheap and the lease secret and the
--                  (large) engine input never reach a browser. Nobody writes the table directly: the writers are
--                  `create_ai_job` / `cancel_ai_job` (content staff) and the service-role-only `ai_job_*` RPCs
--                  (the `ai-job` edge function), all SECURITY DEFINER behind thin invoker wrappers.
--   ai_usage     : one row per model call (tokens, estimated cost). A ledger: no client privilege of any kind,
--                  written by `ai_job_complete_step`, read only through `get_ai_usage_summary`.
-- RLS is on for all three.

-- updated_at trigger (the repo had none: other tables set updated_at by hand) ---------------------------------
create or replace function private.touch_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

revoke all on function private.touch_updated_at() from public, anon, authenticated;

-- app_settings ------------------------------------------------------------------------------------------------
create table public.app_settings (
  key text primary key check (
    key in ('ai.models', 'ai.kill_switch', 'ai.budget', 'ai.prices', 'ai.effort', 'ai.prompt_version')
  ),
  value jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references auth.users (id) on delete set null
);
create index app_settings_updated_by_idx on public.app_settings (updated_by);

comment on table public.app_settings is
  'Settings of the content engine (AiSettings in packages/authoring-core/src/contract.ts). Read by content staff; written only by set_app_setting (super_admin), which validates the shape of each key. Audited.';

create trigger app_settings_touch_updated_at before update on public.app_settings
  for each row execute function private.touch_updated_at();

-- ai_jobs ------------------------------------------------------------------------------------------------------
create table public.ai_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('scheme_ingest', 'chapter_plan', 'unit_generate', 'unit_revise')),
  status text not null default 'queued'
    check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- what the client asked for (validated ids / notes); `input` is what the engine receives
  params jsonb not null default '{}'::jsonb check (jsonb_typeof(params) = 'object'),
  input jsonb not null check (jsonb_typeof(input) = 'object'),
  state jsonb not null default '{"outputs":{}}'::jsonb check (jsonb_typeof(state) = 'object'),
  progress jsonb not null default '{"done":[],"next":null,"total":0}'::jsonb
    check (jsonb_typeof(progress) = 'object'),
  result jsonb,
  error jsonb check (error is null or jsonb_typeof(error) = 'object'),
  -- failed attempts of the CURRENT step (reset when a step completes)
  attempts int not null default 0 check (attempts >= 0),
  lease_until timestamptz,
  lease_token uuid,
  unit_id uuid references public.units (id) on delete set null,
  scheme_id uuid references public.schemes (id) on delete set null,
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) between 8 and 100),
  created_by uuid default auth.uid() references auth.users (id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  finished_at timestamptz,
  -- a lease is a (deadline, secret) pair; a finished job holds none
  constraint ai_jobs_lease_chk check ((lease_until is null) = (lease_token is null)),
  constraint ai_jobs_terminal_chk check (
    (status in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null)
  ),
  constraint ai_jobs_terminal_no_lease_chk check (
    status not in ('succeeded', 'failed', 'cancelled') or lease_token is null
  )
);
create unique index ai_jobs_creator_idempotency_uidx on public.ai_jobs (created_by, idempotency_key)
  where idempotency_key is not null;
create index ai_jobs_creator_created_idx on public.ai_jobs (created_by, created_at desc);
create index ai_jobs_status_idx on public.ai_jobs (status);
create index ai_jobs_unit_id_idx on public.ai_jobs (unit_id);
create index ai_jobs_scheme_id_idx on public.ai_jobs (scheme_id);

comment on table public.ai_jobs is
  'Content-engine jobs (ADR 0007). Clients read their own rows without params/input/state/lease_token (column grants); no client write path: create_ai_job / cancel_ai_job and the service-role ai_job_* RPCs only.';
comment on column public.ai_jobs.attempts is
  'Failed attempts of the current step; reset to 0 when a step completes. A job fails when a step reaches MAX_STEP_ATTEMPTS (3) failed attempts.';
comment on column public.ai_jobs.lease_token is
  'Secret of the live lease (service role only): a step may store its output only while it still holds the token.';

create trigger ai_jobs_touch_updated_at before update on public.ai_jobs
  for each row execute function private.touch_updated_at();

-- ai_usage -----------------------------------------------------------------------------------------------------
create table public.ai_usage (
  id bigint generated always as identity primary key,
  job_id uuid references public.ai_jobs (id) on delete set null,
  label text not null,
  task text not null check (task in ('authoring', 'tutor', 'moderation')),
  model text not null,
  input_tokens int not null default 0 check (input_tokens >= 0),
  output_tokens int not null default 0 check (output_tokens >= 0),
  cache_read_tokens int not null default 0 check (cache_read_tokens >= 0),
  cache_creation_tokens int not null default 0 check (cache_creation_tokens >= 0),
  -- NULL = no price entered for the model: the cost is UNKNOWN, never zero
  est_cost_usd numeric check (est_cost_usd is null or est_cost_usd >= 0),
  stop_reason text,
  duration_ms int not null default 0 check (duration_ms >= 0),
  created_by uuid references auth.users (id) on delete set null,
  created_at timestamptz not null default now()
);
create index ai_usage_job_id_idx on public.ai_usage (job_id);
create index ai_usage_created_by_idx on public.ai_usage (created_by);
create index ai_usage_created_at_idx on public.ai_usage (created_at);

comment on table public.ai_usage is
  'One row per model call. est_cost_usd is computed from ai.prices at insert time and is NULL when the model has no price. No client privilege: read through get_ai_usage_summary.';

-- RLS and grants --------------------------------------------------------------------------------------------------
alter table public.app_settings enable row level security;
alter table public.ai_jobs enable row level security;
alter table public.ai_usage enable row level security;

-- nobody (service_role included) touches these tables directly: the SECURITY DEFINER RPCs are the writers
revoke all on table public.app_settings, public.ai_jobs, public.ai_usage
  from public, anon, authenticated, service_role;

create policy app_settings_select on public.app_settings
  for select to authenticated
  using ((select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer'])));
grant select on public.app_settings to authenticated;

-- a creator sees their own jobs, a super_admin all of them
create policy ai_jobs_select on public.ai_jobs
  for select to authenticated
  using (
    (select private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']))
    and (created_by = (select auth.uid()) or (select private.has_admin_role(array['super_admin'])))
  );
grant select (
  id, kind, status, progress, result, error, attempts, lease_until, unit_id, scheme_id,
  created_by, created_at, updated_at, finished_at
) on public.ai_jobs to authenticated;

-- ai_usage: RLS on, no policy, no grant (read through get_ai_usage_summary only)

-- audit: setting changes are recorded like the other admin changes ----------------------------------------------
-- audit_row_change learns the key of app_settings as its entity id (the other tables have `id`).
create or replace function private.audit_row_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
  v_row jsonb;
  v_id text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new) - 'content' - 'lint_report' - 'sync_seq';
  elsif tg_op = 'DELETE' then
    v_old := to_jsonb(old) - 'content' - 'lint_report' - 'sync_seq';
  else
    v_old := to_jsonb(old) - 'content' - 'lint_report' - 'sync_seq';
    v_new := to_jsonb(new) - 'content' - 'lint_report' - 'sync_seq';
    if v_old = v_new then
      return null;
    end if;
  end if;

  v_row := coalesce(v_new, v_old);
  v_id := case tg_table_name
    when 'household_members' then (v_row ->> 'household_id') || ':' || (v_row ->> 'user_id')
    when 'admin_users' then v_row ->> 'user_id'
    when 'app_settings' then v_row ->> 'key'
    else v_row ->> 'id'
  end;

  insert into public.audit_log (actor, action, entity, entity_id, detail)
  values (
    (select auth.uid()),
    lower(tg_op),
    tg_table_name,
    v_id,
    jsonb_build_object('old', v_old, 'new', v_new)
  );
  return null;
end;
$$;

revoke all on function private.audit_row_change() from public, anon, authenticated;

create trigger app_settings_audit after insert or update or delete on public.app_settings
  for each row execute function private.audit_row_change();
