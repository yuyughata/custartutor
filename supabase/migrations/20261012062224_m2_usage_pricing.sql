-- 19 M2 content engine, part 6: failed-but-billed calls, prefix price lookup, kill switch at the lease.
--
-- 1. A refusal, a truncated reply or a schema failure still costs tokens. `StepError` (contract.ts) now carries the
--    calls made before the failure, so `ai_job_fail_step` takes `p_usage` and logs it exactly like
--    `ai_job_complete_step` does (same rows, same cost rule, logged even when the lease token no longer matches: the
--    money is spent either way). Both functions now share `private.ai_log_usage`.
-- 2. Price lookup = `priceFor` of contract.ts: the exact model id, else the LONGEST price key that is a prefix of the
--    reported id (the API may report a dated snapshot, `claude-opus-5-5-20261001`, for the alias
--    `claude-opus-5-5`). `private.ai_price_for` is the one implementation; `private.ai_call_cost` uses it. The cost
--    is computed once, at insert; ai_job_budget_check and get_ai_usage_summary only add up the stored est_cost_usd,
--    so a prefix-priced call counts there too and an unmatched model stays NULL (unknown, never zero).
-- 3. The kill switch is enforced at BOTH ends: create_ai_job (part 2) refuses a new job, and
--    ai_job_acquire_lease now refuses a new lease (`kill_switch`), so no step can start while it is on even if a
--    caller skips ai_job_budget_check. A finished or busy job is still reported as such.
--
-- ai_job_fail_step gains a parameter, so it is a NEW function (6 arguments). The migration tooling holds back
-- anything that removes an object, so the old 5-argument pair is not removed here: it is made inert (no role may
-- execute it, so PostgREST does not expose it and there is no overload to choose between) and marked deprecated;
-- migrations/README.md lists the two statements that remove it.

-- 2. price lookup -----------------------------------------------------------------------------------------------------
create or replace function private.ai_price_for(p_prices jsonb, p_model text)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select e.value
    from jsonb_each(case when jsonb_typeof(p_prices) = 'object' then p_prices else '{}'::jsonb end) e
   where p_model is not null
     and jsonb_typeof(e.value) = 'object'
     and starts_with(p_model, e.key)
   order by char_length(e.key) desc
   limit 1;
$$;

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
    when jsonb_typeof(p.price -> 'input_per_mtok') = 'number'
     and jsonb_typeof(p.price -> 'output_per_mtok') = 'number'
     and jsonb_typeof(p.price -> 'cache_read_per_mtok') = 'number'
     and jsonb_typeof(p.price -> 'cache_write_per_mtok') = 'number'
    then (
      coalesce(p_input, 0) * (p.price ->> 'input_per_mtok')::numeric
      + coalesce(p_output, 0) * (p.price ->> 'output_per_mtok')::numeric
      + coalesce(p_cache_read, 0) * (p.price ->> 'cache_read_per_mtok')::numeric
      + coalesce(p_cache_write, 0) * (p.price ->> 'cache_write_per_mtok')::numeric
    ) / 1000000
  end
  from (select private.ai_price_for(p_prices, p_model) as price) p;
$$;

-- 1. one place that logs the calls of a step (completed or failed) -------------------------------------------------------
create or replace function private.ai_log_usage(p_job_id uuid, p_created_by uuid, p_step text, p_usage jsonb)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prices jsonb := private.ai_setting('ai.prices');
begin
  insert into public.ai_usage
    (job_id, label, task, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
     est_cost_usd, stop_reason, duration_ms, created_by)
  select
    p_job_id,
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
    p_created_by
  from jsonb_to_recordset(coalesce(p_usage, '[]'::jsonb)) as u(
    label text, task text, model text, input_tokens int, output_tokens int,
    cache_read_tokens int, cache_creation_tokens int, stop_reason text, duration_ms int
  );
end;
$$;

revoke all on function
  private.ai_price_for(jsonb, text),
  private.ai_call_cost(jsonb, text, int, int, int, int),
  private.ai_log_usage(uuid, uuid, text, jsonb)
  from public, anon, authenticated;

-- ai_job_complete_step: unchanged behaviour, now through ai_log_usage ----------------------------------------------------
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

  -- spend is recorded whether or not the output is accepted
  perform private.ai_log_usage(v_job.id, v_job.created_by, p_step, p_usage);

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

-- ai_job_fail_step: now with the calls that were billed before the failure ------------------------------------------------
-- the 5-argument version stays only as an inert stub (see the header)
revoke all on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean)
  from public, anon, authenticated, service_role;
revoke all on function private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean)
  from public, anon, authenticated, service_role;
comment on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean) is
  'DEPRECATED and not executable by any role: replaced by the 6-argument version with p_usage. Safe to remove.';
comment on function private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean) is
  'DEPRECATED and not executable by any role: replaced by the 6-argument version with p_usage. Safe to remove.';

-- Records a failed attempt, only while the caller holds the lease. A retryable failure keeps the job `running`
-- (error recorded, lease cleared, attempts + 1) until the step has failed MAX_STEP_ATTEMPTS (3) times; anything
-- else ends the job (`failed`, finished_at). The stored error is rebuilt from p_error's code and message only,
-- bounded in size: nothing else (raw model output, prompts) can enter the row through this function. p_usage (the
-- StepError's billed calls) is logged like the usage of a completed step, even when the lease token no longer matches.
create or replace function private.ai_job_fail_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_error jsonb,
  p_retryable boolean,
  p_usage jsonb
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
  if p_usage is not null and jsonb_typeof(p_usage) <> 'array' then
    raise exception 'invalid_usage' using errcode = '22023';
  end if;

  select * into v_job from public.ai_jobs j where j.id = p_job_id for update;
  if not found then
    raise exception 'job_not_found' using errcode = 'P0002';
  end if;

  perform private.ai_log_usage(v_job.id, v_job.created_by, coalesce(p_step, 'unknown'), p_usage);

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

revoke all on function private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function private.ai_job_fail_step(uuid, uuid, text, jsonb, boolean, jsonb) to service_role;

create or replace function public.ai_job_fail_step(
  p_job_id uuid,
  p_lease_token uuid,
  p_step text,
  p_error jsonb,
  p_retryable boolean,
  p_usage jsonb default '[]'::jsonb
)
returns boolean
language sql
security invoker
set search_path = ''
as $$ select private.ai_job_fail_step(p_job_id, p_lease_token, p_step, p_error, p_retryable, p_usage); $$;

revoke all on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean, jsonb) to service_role;

comment on function public.ai_job_fail_step(uuid, uuid, text, jsonb, boolean, jsonb) is
  'service_role only. Records a failed attempt while the lease token matches; a retryable failure keeps the job running until the step has failed 3 times, anything else fails the job. p_usage = the calls billed before the failure (logged like a completed step''s, with cost; also when the token no longer matches). Returns whether the failure was recorded.';

-- 3. ai_job_acquire_lease: no new lease while the kill switch is on ---------------------------------------------------------
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

  -- nothing starts while the kill switch is on (a dead lease is not counted either: nothing is being retried)
  if private.ai_setting('ai.kill_switch') = 'true'::jsonb then
    raise exception 'kill_switch' using errcode = '42501';
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

comment on function public.ai_job_acquire_lease(uuid, int) is
  'service_role only (ai-job edge function). Takes the lease for one step; returns {acquired, reason?, job, kind?, input?, state?, lease_token?}. Refuses with kill_switch while ai.kill_switch is on (a finished or busy job is still reported as such). An expired lease may be taken over and counts as a failed attempt.';
