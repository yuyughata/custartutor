-- 15 M2 content engine, part 2: the job RPCs (ADR 0007, docs/m2-plan.md "The server surface").
--
-- Two audiences, both behind the usual pattern (thin SECURITY INVOKER `public.*` wrapper over a SECURITY
-- DEFINER `private.*` implementation, search_path = ''):
--
--   content staff (authenticated, aal2)   create_ai_job, cancel_ai_job
--   the `ai-job` edge function            ai_job_acquire_lease, ai_job_complete_step, ai_job_fail_step,
--   (service_role ONLY)                   ai_job_budget_check
--
-- service_role bypasses RLS but not grants: it can execute exactly these four (plus set_pack_info) and has no
-- privilege on the tables. The lease is the safety device of client-driven stepping: a step stores its output only
-- while it still holds the lease token, so a late finisher can never overwrite a newer attempt.
--
-- Step accounting. `attempts` counts FAILED attempts of the current step (reset when a step completes). A step has
-- at most MAX_STEP_ATTEMPTS = 3 attempts: the third failure ends the job. A worker that dies without reporting
-- (timeout, killed isolate) leaves an expired lease; taking such a lease over counts as one failed attempt, so a
-- step that always kills its worker cannot loop forever.

-- settings helpers (no API role may execute them: only the definer RPCs below and in part 3 call them) ---------------
create or replace function private.ai_setting_default(p_key text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select case p_key
    when 'ai.models' then
      '{"authoring":"claude-opus-5-5","tutor":"claude-sonnet-5-5","moderation":"claude-haiku-5-5"}'::jsonb
    when 'ai.kill_switch' then 'false'::jsonb
    when 'ai.budget' then '{"max_usd_per_job":null,"daily_usd_cap":null}'::jsonb
    when 'ai.prices' then '{}'::jsonb
    when 'ai.effort' then '{}'::jsonb
    when 'ai.prompt_version' then '"m2-v1"'::jsonb
  end;
$$;

-- the stored value, or the default; stored objects are laid over the default object (a partial row keeps defaults)
create or replace function private.ai_setting(p_key text)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when s.value is null then private.ai_setting_default(p_key)
    when jsonb_typeof(s.value) = 'object' and jsonb_typeof(private.ai_setting_default(p_key)) = 'object'
      then private.ai_setting_default(p_key) || s.value
    else s.value
  end
  from (select (select a.value from public.app_settings a where a.key = p_key) as value) s;
$$;

-- the assembled AiSettings (contract.ts) -------------------------------------------------------------------------------
create or replace function private.ai_settings_json()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'models', private.ai_setting('ai.models'),
    'kill_switch', private.ai_setting('ai.kill_switch'),
    'budget', private.ai_setting('ai.budget'),
    'prices', private.ai_setting('ai.prices'),
    'effort', private.ai_setting('ai.effort'),
    'prompt_version', private.ai_setting('ai.prompt_version')
  );
$$;

-- estimated US-dollar cost of one call; NULL (unknown, never zero) when the model has no complete price entry -----------
create or replace function private.ai_call_cost(
  p_prices jsonb,
  p_model text,
  p_input int,
  p_output int,
  p_cache_read int,
  p_cache_write int
)
returns numeric
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(p_prices -> p_model) = 'object'
     and jsonb_typeof(p_prices -> p_model -> 'input_per_mtok') = 'number'
     and jsonb_typeof(p_prices -> p_model -> 'output_per_mtok') = 'number'
     and jsonb_typeof(p_prices -> p_model -> 'cache_read_per_mtok') = 'number'
     and jsonb_typeof(p_prices -> p_model -> 'cache_write_per_mtok') = 'number'
    then (
      coalesce(p_input, 0) * (p_prices -> p_model ->> 'input_per_mtok')::numeric
      + coalesce(p_output, 0) * (p_prices -> p_model ->> 'output_per_mtok')::numeric
      + coalesce(p_cache_read, 0) * (p_prices -> p_model ->> 'cache_read_per_mtok')::numeric
      + coalesce(p_cache_write, 0) * (p_prices -> p_model ->> 'cache_write_per_mtok')::numeric
    ) / 1000000
  end;
$$;

-- the JobRow shape (contract.ts): what clients and the edge function see; never input, state or the lease token ----------
create or replace function private.ai_job_view(j public.ai_jobs)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_build_object(
    'id', j.id,
    'kind', j.kind,
    'status', j.status,
    'progress', j.progress,
    'lease_until', j.lease_until,
    'attempts', j.attempts,
    'error', j.error,
    'result', j.result,
    'unit_id', j.unit_id,
    'scheme_id', j.scheme_id,
    'created_by', j.created_by,
    'created_at', j.created_at,
    'updated_at', j.updated_at,
    'finished_at', j.finished_at
  );
$$;

revoke all on function
  private.ai_setting_default(text),
  private.ai_setting(text),
  private.ai_settings_json(),
  private.ai_call_cost(jsonb, text, int, int, int, int),
  private.ai_job_view(public.ai_jobs)
  from public, anon, authenticated;

-- create_ai_job ---------------------------------------------------------------------------------------------------------
-- Content staff who may write (super_admin, content_editor) at aal2: every job ends in a draft, a scheme draft or a
-- plan that only these roles can save, so a reviewer must not be able to start (and pay for) one.
-- Idempotent on (creator, key). Refuses while the kill switch is on (`kill_switch`) and beyond 5 unfinished jobs per
-- creator (`too_many_jobs`). Returns the JobRow-shaped row.
create or replace function private.create_ai_job(
  p_kind text,
  p_params jsonb,
  p_input jsonb,
  p_unit_id uuid,
  p_scheme_id uuid,
  p_idempotency_key text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_params jsonb := coalesce(p_params, '{}'::jsonb);
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_job public.ai_jobs%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;
  if p_kind is null or p_kind not in ('scheme_ingest', 'chapter_plan', 'unit_generate', 'unit_revise') then
    raise exception 'invalid_job_kind' using errcode = '22023';
  end if;
  if p_input is null or jsonb_typeof(p_input) <> 'object' then
    raise exception 'invalid_job_input' using errcode = '22023';
  end if;
  if jsonb_typeof(v_params) <> 'object' then
    raise exception 'invalid_job_params' using errcode = '22023';
  end if;
  if v_key is not null and char_length(v_key) not between 8 and 100 then
    raise exception 'invalid_idempotency_key' using errcode = '22023';
  end if;
  if p_kind in ('unit_generate', 'unit_revise') and p_unit_id is null then
    raise exception 'unit_id_required' using errcode = '22023';
  end if;
  if p_kind = 'chapter_plan' and p_scheme_id is null then
    raise exception 'scheme_id_required' using errcode = '22023';
  end if;

  -- one critical section per creator: idempotency lookup, quota and insert cannot interleave
  perform pg_advisory_xact_lock(hashtextextended('ai_job_create:' || v_uid::text, 0));

  if v_key is not null then
    select * into v_job from public.ai_jobs j where j.created_by = v_uid and j.idempotency_key = v_key;
    if found then
      if v_job.kind <> p_kind then
        raise exception 'idempotency_key_reused' using errcode = '22023';
      end if;
      return private.ai_job_view(v_job);
    end if;
  end if;

  if private.ai_setting('ai.kill_switch') = 'true'::jsonb then
    raise exception 'kill_switch' using errcode = '42501';
  end if;
  if (select count(*) from public.ai_jobs j
       where j.created_by = v_uid and j.status in ('queued', 'running')) >= 5 then
    raise exception 'too_many_jobs' using errcode = '53400';
  end if;
  if p_unit_id is not null and not exists (select 1 from public.units u where u.id = p_unit_id) then
    raise exception 'unit_not_found' using errcode = 'P0002';
  end if;
  if p_scheme_id is not null and not exists (select 1 from public.schemes s where s.id = p_scheme_id) then
    raise exception 'scheme_not_found' using errcode = 'P0002';
  end if;

  insert into public.ai_jobs (kind, params, input, unit_id, scheme_id, idempotency_key, created_by)
  values (p_kind, v_params, p_input, p_unit_id, p_scheme_id, v_key, v_uid)
  returning * into v_job;

  return private.ai_job_view(v_job);
end;
$$;

-- cancel_ai_job ---------------------------------------------------------------------------------------------------------
-- The creator or a super_admin (aal2). queued/running -> cancelled and the lease is cleared, so a step in flight
-- cannot store its output any more. A finished job is returned unchanged (a cancel that loses the race to a
-- completing step is not an error). Someone else's job is reported as not found.
create or replace function private.cancel_ai_job(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_job public.ai_jobs%rowtype;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if not private.has_admin_role(array['super_admin', 'content_editor', 'reviewer']) then
    raise exception 'admin_role_required' using errcode = '42501';
  end if;

  select * into v_job from public.ai_jobs j where j.id = p_job_id for update;
  if not found
     or not (v_job.created_by = v_uid or private.has_admin_role(array['super_admin'])) then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  if v_job.status in ('queued', 'running') then
    update public.ai_jobs j
       set status = 'cancelled', lease_until = null, lease_token = null, finished_at = now()
     where j.id = v_job.id
    returning * into v_job;
  end if;
  return private.ai_job_view(v_job);
end;
$$;

-- ai_job_acquire_lease (service_role) -----------------------------------------------------------------------------------
-- Takes the lease for one step. Returns
--   {acquired: true,  job, kind, input, state, lease_token}   the caller may run a step
--   {acquired: false, reason: 'busy', job}                    a live lease exists
--   {acquired: false, reason: 'terminal', job}                succeeded / failed / cancelled (also: this very call
--                                                             failed the job because the previous attempt of the
--                                                             step died for the third time)
-- The first acquire flips queued -> running. An EXPIRED lease may be taken over; that counts as a failed attempt.
create or replace function private.ai_job_acquire_lease(p_job_id uuid, p_lease_seconds int)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ai_jobs%rowtype;
  v_token uuid := gen_random_uuid();
begin
  if p_lease_seconds is null or p_lease_seconds not between 10 and 900 then
    raise exception 'invalid_lease_seconds' using errcode = '22023';
  end if;

  select * into v_job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  if v_job.status in ('succeeded', 'failed', 'cancelled') then
    return jsonb_build_object('acquired', false, 'reason', 'terminal', 'job', private.ai_job_view(v_job));
  end if;
  if v_job.lease_until is not null and v_job.lease_until > now() then
    return jsonb_build_object('acquired', false, 'reason', 'busy', 'job', private.ai_job_view(v_job));
  end if;

  if v_job.lease_until is not null then
    -- the previous holder never reported back: that was a failed attempt
    update public.ai_jobs j
       set attempts = j.attempts + 1,
           error = jsonb_strip_nulls(jsonb_build_object(
             'code', 'aborted',
             'message', 'The previous attempt of this step did not finish in time.',
             'step', j.progress ->> 'next',
             'retryable', j.attempts + 1 < 3
           )),
           status = case when j.attempts + 1 >= 3 then 'failed' else j.status end,
           finished_at = case when j.attempts + 1 >= 3 then now() else null end,
           lease_until = null,
           lease_token = null
     where j.id = v_job.id
    returning * into v_job;
    if v_job.status = 'failed' then
      return jsonb_build_object('acquired', false, 'reason', 'terminal', 'job', private.ai_job_view(v_job));
    end if;
  end if;

  update public.ai_jobs j
     set status = 'running',
         lease_until = now() + make_interval(secs => p_lease_seconds),
         lease_token = v_token
   where j.id = v_job.id
  returning * into v_job;

  return jsonb_build_object(
    'acquired', true,
    'job', private.ai_job_view(v_job),
    'kind', v_job.kind,
    'input', v_job.input,
    'state', v_job.state,
    'lease_token', v_token
  );
end;
$$;

-- ai_job_complete_step (service_role) -----------------------------------------------------------------------------------
-- Stores the output of one step, ONLY while the caller still holds the lease (token match on a running job; an
-- expired-but-untaken lease still counts: nobody else has started). Merges outputs[p_step], replaces progress,
-- resets attempts and the error, clears the lease; with a non-null p_result the job is finished (succeeded).
-- ai_usage rows are inserted either way: a call that was made was paid for, even if its output is discarded
-- because the job was cancelled or the lease taken over. The cost is estimated from ai.prices, NULL when unpriced.
-- Returns whether the output was accepted.
create or replace function private.ai_job_complete_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_output jsonb,
  p_usage jsonb,
  p_progress jsonb,
  p_result jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ai_jobs%rowtype;
  v_prices jsonb := private.ai_setting('ai.prices');
begin
  if p_step is null or btrim(p_step) = '' then
    raise exception 'invalid_step' using errcode = '22023';
  end if;
  if p_usage is not null and jsonb_typeof(p_usage) <> 'array' then
    raise exception 'invalid_usage' using errcode = '22023';
  end if;
  if p_progress is null or jsonb_typeof(p_progress) <> 'object' then
    raise exception 'invalid_progress' using errcode = '22023';
  end if;

  select * into v_job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  insert into public.ai_usage
    (job_id, label, task, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     est_cost_usd, stop_reason, duration_ms, created_by)
  select
    v_job.id,
    coalesce(u.label, p_step),
    u.task,
    u.model,
    coalesce(u.input_tokens, 0),
    coalesce(u.output_tokens, 0),
    coalesce(u.cache_read_tokens, 0),
    coalesce(u.cache_creation_tokens, 0),
    private.ai_call_cost(v_prices, u.model, u.input_tokens, u.output_tokens,
                         u.cache_read_tokens, u.cache_creation_tokens),
    u.stop_reason,
    coalesce(u.duration_ms, 0),
    v_job.created_by
  from jsonb_to_recordset(coalesce(p_usage, '[]'::jsonb)) as u(
    label text, task text, model text, input_tokens int, output_tokens int,
    cache_read_tokens int, cache_creation_tokens int, stop_reason text, duration_ms int
  );

  if v_job.status <> 'running' or p_lease_token is null or v_job.lease_token is distinct from p_lease_token then
    return false;
  end if;

  update public.ai_jobs j
     set state = jsonb_set(
           coalesce(j.state, '{"outputs":{}}'::jsonb),
           '{outputs}',
           coalesce(j.state -> 'outputs', '{}'::jsonb)
             || jsonb_build_object(p_step, coalesce(p_output, 'null'::jsonb))
         ),
         progress = p_progress,
         attempts = 0,
         error = null,
         lease_until = null,
         lease_token = null,
         result = case when p_result is not null then p_result else j.result end,
         status = case when p_result is not null then 'succeeded' else 'running' end,
         finished_at = case when p_result is not null then now() else null end
   where j.id = v_job.id;
  return true;
end;
$$;

-- ai_job_fail_step (service_role) ---------------------------------------------------------------------------------------
-- Records a failed attempt, only while the caller holds the lease. A retryable failure keeps the job `running`
-- (error recorded, lease cleared, attempts + 1) until the step has failed MAX_STEP_ATTEMPTS (3) times; anything
-- else ends the job (`failed`, finished_at). The stored error is rebuilt from p_error's code and message only,
-- bounded in size: nothing else (raw model output, prompts) can enter the row through this function.
create or replace function private.ai_job_fail_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_error jsonb,
  p_retryable boolean
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.ai_jobs%rowtype;
  v_attempts int;
  v_retry boolean;
  v_error jsonb;
begin
  select * into v_job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;
  if v_job.status <> 'running' or p_lease_token is null or v_job.lease_token is distinct from p_lease_token then
    return false;
  end if;

  v_attempts := v_job.attempts + 1;
  v_retry := coalesce(p_retryable, false) and v_attempts < 3;
  v_error := jsonb_strip_nulls(jsonb_build_object(
    'code', coalesce(left(nullif(btrim(p_error ->> 'code'), ''), 64), 'internal'),
    'message', coalesce(left(nullif(btrim(p_error ->> 'message'), ''), 500), 'The step failed.'),
    'step', left(p_step, 128),
    'retryable', coalesce(p_retryable, false)
  ));

  update public.ai_jobs j
     set attempts = v_attempts,
         error = v_error,
         lease_until = null,
         lease_token = null,
         status = case when v_retry then 'running' else 'failed' end,
         finished_at = case when v_retry then null else now() end
   where j.id = v_job.id;
  return true;
end;
$$;

-- ai_job_budget_check (service_role) ------------------------------------------------------------------------------------
-- The numbers the edge function needs before every step. Costs are the SUM OF KNOWN COSTS: a call without a price
-- is unknown, not free, so it is counted in `unpriced_calls` (this job) and `day_unpriced_calls` (today) and the
-- caps apply to known costs only. "Today" is the current UTC day, across all jobs and creators.
create or replace function private.ai_job_budget_check(p_job_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_budget jsonb := private.ai_setting('ai.budget');
  v_day_start timestamptz := date_trunc('day', now() at time zone 'utc') at time zone 'utc';
  v_job_cost numeric;
  v_job_unpriced bigint;
  v_day_cost numeric;
  v_day_unpriced bigint;
begin
  if not exists (select 1 from public.ai_jobs j where j.id = p_job_id) then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  select coalesce(sum(u.est_cost_usd), 0), count(*) filter (where u.est_cost_usd is null)
    into v_job_cost, v_job_unpriced
    from public.ai_usage u
   where u.job_id = p_job_id;

  select coalesce(sum(u.est_cost_usd), 0), count(*) filter (where u.est_cost_usd is null)
    into v_day_cost, v_day_unpriced
    from public.ai_usage u
   where u.created_at >= v_day_start;

  return jsonb_build_object(
    'kill_switch', private.ai_setting('ai.kill_switch') = 'true'::jsonb,
    'job_cost_usd', v_job_cost,
    'day_cost_usd', v_day_cost,
    'max_usd_per_job', v_budget -> 'max_usd_per_job',
    'daily_usd_cap', v_budget -> 'daily_usd_cap',
    'unpriced_calls', v_job_unpriced,
    'day_unpriced_calls', v_day_unpriced
  );
end;
$$;

-- grants: private implementations -----------------------------------------------------------------------------------------
revoke all on function
  private.create_ai_job(text, jsonb, jsonb, uuid, uuid, text),
  private.cancel_ai_job(uuid),
  private.ai_job_acquire_lease(uuid, int),
  private.ai_job_complete_step(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean),
  private.ai_job_budget_check(uuid)
  from public, anon, authenticated;

grant execute on function
  private.create_ai_job(text, jsonb, jsonb, uuid, uuid, text),
  private.cancel_ai_job(uuid)
  to authenticated;

-- the edge function (service role) resolves exactly these through the public wrappers below
grant execute on function
  private.ai_job_acquire_lease(uuid, int),
  private.ai_job_complete_step(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean),
  private.ai_job_budget_check(uuid)
  to service_role;

-- public wrappers (SECURITY INVOKER) -----------------------------------------------------------------------------------------
create or replace function public.create_ai_job(
  p_kind text,
  p_params jsonb,
  p_input jsonb,
  p_unit_id uuid,
  p_scheme_id uuid,
  p_idempotency_key text
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.create_ai_job(p_kind, p_params, p_input, p_unit_id, p_scheme_id, p_idempotency_key); $$;

create or replace function public.cancel_ai_job(p_job_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.cancel_ai_job(p_job_id); $$;

create or replace function public.ai_job_acquire_lease(p_job_id uuid, p_lease_seconds int)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.ai_job_acquire_lease(p_job_id, p_lease_seconds); $$;

create or replace function public.ai_job_complete_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_output jsonb,
  p_usage jsonb,
  p_progress jsonb,
  p_result jsonb
)
returns boolean
language sql
security invoker
set search_path = ''
as $$ select private.ai_job_complete_step(p_job_id, p_lease_token, p_step, p_output, p_usage, p_progress, p_result); $$;

create or replace function public.ai_job_fail_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_error jsonb,
  p_retryable boolean
)
returns boolean
language sql
security invoker
set search_path = ''
as $$ select private.ai_job_fail_step(p_job_id, p_lease_token, p_step, p_error, p_retryable); $$;

create or replace function public.ai_job_budget_check(p_job_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.ai_job_budget_check(p_job_id); $$;

revoke all on function
  public.create_ai_job(text, jsonb, jsonb, uuid, uuid, text),
  public.cancel_ai_job(uuid),
  public.ai_job_acquire_lease(uuid, int),
  public.ai_job_complete_step(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean),
  public.ai_job_budget_check(uuid)
  from public, anon, authenticated, service_role;

grant execute on function
  public.create_ai_job(text, jsonb, jsonb, uuid, uuid, text),
  public.cancel_ai_job(uuid)
  to authenticated;

grant execute on function
  public.ai_job_acquire_lease(uuid, int),
  public.ai_job_complete_step(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb),
  public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean),
  public.ai_job_budget_check(uuid)
  to service_role;

comment on function public.create_ai_job(text, jsonb, jsonb, uuid, uuid, text) is
  'Admin (super_admin, content_editor) at aal2. Inserts a content-engine job (the `ai-job` edge function builds p_input from the database). Idempotent on (caller, p_idempotency_key). kill_switch when ai.kill_switch is on; too_many_jobs beyond 5 unfinished jobs per creator. Returns the JobRow-shaped row.';
comment on function public.cancel_ai_job(uuid) is
  'The job''s creator or a super_admin (content staff at aal2). queued/running -> cancelled and the lease is cleared; a finished job is returned unchanged. Returns the JobRow-shaped row.';
comment on function public.ai_job_acquire_lease(uuid, int) is
  'service_role only (ai-job edge function). Takes the lease for one step; returns {acquired, reason?, job, kind?, input?, state?, lease_token?}. An expired lease may be taken over and counts as a failed attempt.';
comment on function public.ai_job_complete_step(uuid, uuid, text, jsonb, jsonb, jsonb, jsonb) is
  'service_role only. Stores one step output while the lease token still matches, logs ai_usage (always) with estimated cost (NULL when unpriced), finishes the job when p_result is given. Returns whether the output was accepted.';
comment on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean) is
  'service_role only. Records a failed attempt while the lease token matches; a retryable failure keeps the job running until the step has failed 3 times, anything else fails the job. Returns whether it was recorded.';
comment on function public.ai_job_budget_check(uuid) is
  'service_role only. {kill_switch, job_cost_usd, day_cost_usd, max_usd_per_job, daily_usd_cap, unpriced_calls, day_unpriced_calls}: sums of KNOWN costs; calls without a price count as unpriced, not as zero.';
