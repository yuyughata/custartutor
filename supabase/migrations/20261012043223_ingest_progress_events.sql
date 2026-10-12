-- 12 ingest_progress_events: the ONLY write path of progress_events (and so of unit_progress).
--
-- Contract: packages/learner-core/src/wire.ts (PushResult, EVENT payloads). For EACH event, independently:
-- validate the shape and payload (the Zod schemas of wire.ts, field by field), authorise the child
-- (private.can_access_child: guardian of the household or tutor with an active grant), look up the household
-- from the child (never from the client), check the unit exists, check mastery consistency, rate-limit, insert
-- idempotently. One bad row never fails the batch: every event runs in its own BEGIN ... EXCEPTION block and
-- yields accepted / duplicate / rejected(reason), in input order. Only a malformed CALL raises: not signed in,
-- p_events not a JSON array, more than 100 events.
--
-- Lock order (see 20261012042817_sync_cursor_and_epoch.sql): PHASE 1 inserts the events (no sync lock needed,
-- progress_events is not syncable); PHASE 2 re-derives unit_progress for every touched (child, unit), in sorted
-- order, taking the global sync lock first. Nobody ever waits for an event-row conflict while holding the sync
-- lock, so concurrent ingests cannot deadlock on each other.
--
-- Reasons: invalid_payload, no_access_to_child, child_deleted, unknown_unit, inconsistent_mastery,
-- rate_limited, internal_error. Audit: deliberately none (high volume).

-- small helpers for payload validation ---------------------------------------------------------------------
create or replace function private.json_num_in(j jsonb, lo numeric, hi numeric, p_int boolean default false)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(j) = 'number'
      then (j #>> '{}')::numeric between lo and hi
           and (not p_int or (j #>> '{}')::numeric = trunc((j #>> '{}')::numeric))
    else false
  end;
$$;

create or replace function private.json_str_len(j jsonb, lo int, hi int)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when jsonb_typeof(j) = 'string' then char_length(j #>> '{}') between lo and hi
    else false
  end;
$$;

revoke all on function
  private.json_num_in(jsonb, numeric, numeric, boolean),
  private.json_str_len(jsonb, int, int)
  from public, anon, authenticated;

create or replace function private.ingest_progress_events(p_events jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
#variable_conflict use_column
declare
  c_max_batch constant int := 100;
  c_hourly_limit constant int := 2000;
  c_nil constant uuid := '00000000-0000-0000-0000-000000000000';
  c_uuid_re constant text := '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
  c_iso_re constant text := '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$';
  c_reasons constant text[] := array[
    'invalid_payload', 'no_access_to_child', 'child_deleted', 'unknown_unit',
    'inconsistent_mastery', 'rate_limited'
  ];
  v_uid uuid := (select auth.uid());
  v_n int;
  v_i int;
  v_ev jsonb;
  v_payload jsonb;
  v_norm jsonb;
  v_results jsonb := '[]'::jsonb;
  v_status text;
  v_reason text;
  v_id uuid;
  v_child uuid;
  v_unit uuid;
  v_type text;
  v_seq numeric;
  v_occ timestamptz;
  v_hid uuid;
  v_cached jsonb;
  v_access jsonb := '{}'::jsonb;  -- child id -> false | {h: household id, d: deleted}
  v_recent jsonb := '{}'::jsonb;  -- child id -> events received in the last hour (incl. this call)
  v_cnt int;
  v_rows int;
  v_any_accepted boolean := false;
  v_pairs_child uuid[] := '{}';
  v_pairs_unit uuid[] := '{}';
  v_pair record;
  v_score numeric;
  v_qc numeric;
begin
  if v_uid is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  if p_events is null or jsonb_typeof(p_events) <> 'array' then
    raise exception 'invalid_events' using errcode = '22023';
  end if;
  v_n := jsonb_array_length(p_events);
  if v_n > c_max_batch then
    raise exception 'batch_too_large' using errcode = '22023';
  end if;

  -- PHASE 1: validate + authorise + insert, one subtransaction per event ------------------------------------
  for v_i in 0 .. v_n - 1 loop
    v_ev := p_events -> v_i;
    v_status := 'rejected';
    v_reason := null;
    v_id := c_nil;

    begin
      if jsonb_typeof(v_ev) is distinct from 'object' then
        raise exception 'invalid_payload';
      end if;

      -- ids first, so that even a rejected row echoes its client_event_id
      if jsonb_typeof(v_ev -> 'client_event_id') is distinct from 'string'
         or (v_ev ->> 'client_event_id') !~* c_uuid_re then
        raise exception 'invalid_payload';
      end if;
      v_id := (v_ev ->> 'client_event_id')::uuid;

      if jsonb_typeof(v_ev -> 'child_id') is distinct from 'string'
         or (v_ev ->> 'child_id') !~* c_uuid_re
         or jsonb_typeof(v_ev -> 'unit_id') is distinct from 'string'
         or (v_ev ->> 'unit_id') !~* c_uuid_re then
        raise exception 'invalid_payload';
      end if;
      v_child := (v_ev ->> 'child_id')::uuid;
      v_unit := (v_ev ->> 'unit_id')::uuid;

      if not private.json_str_len(v_ev -> 'device_id', 1, 128) then
        raise exception 'invalid_payload';
      end if;
      if not private.json_num_in(v_ev -> 'device_seq', 1, 9007199254740991, true) then
        raise exception 'invalid_payload';
      end if;
      v_seq := (v_ev ->> 'device_seq')::numeric;

      if jsonb_typeof(v_ev -> 'event_type') is distinct from 'string' then
        raise exception 'invalid_payload';
      end if;
      v_type := v_ev ->> 'event_type';
      if v_type not in ('unit_started', 'section_completed', 'question_answered',
                        'mastery_check_completed', 'unit_completed') then
        raise exception 'invalid_payload';
      end if;

      -- ISO 8601 with offset, as z.iso.datetime({ offset: true }); a sane window rejects junk dates only
      if jsonb_typeof(v_ev -> 'occurred_at') is distinct from 'string'
         or (v_ev ->> 'occurred_at') !~ c_iso_re then
        raise exception 'invalid_payload';
      end if;
      v_occ := (v_ev ->> 'occurred_at')::timestamptz;  -- class 22 errors map to invalid_payload below
      if v_occ < timestamptz '2020-01-01 00:00:00+00' or v_occ >= timestamptz '2100-01-01 00:00:00+00' then
        raise exception 'invalid_payload';
      end if;

      -- payload per event type; only the known fields are kept (unknown keys are dropped)
      v_payload := v_ev -> 'payload';
      if jsonb_typeof(v_payload) is distinct from 'object' then
        raise exception 'invalid_payload';
      end if;
      case v_type
        when 'unit_started', 'unit_completed' then
          v_norm := '{}'::jsonb;
        when 'section_completed' then
          if not private.json_str_len(v_payload -> 'section_id', 1, 64) then
            raise exception 'invalid_payload';
          end if;
          v_norm := jsonb_build_object('section_id', v_payload -> 'section_id');
        when 'question_answered' then
          if not private.json_str_len(v_payload -> 'question_id', 1, 64)
             or coalesce(v_payload ->> 'result', '') not in ('correct', 'incorrect', 'partial', 'ungraded')
             or jsonb_typeof(v_payload -> 'result') is distinct from 'string'
             or not (private.json_num_in(v_payload -> 'score', 0, 1)
                     or coalesce(jsonb_typeof(v_payload -> 'score') = 'null', false))
             or not private.json_num_in(v_payload -> 'attempt', 1, 1000000, true) then
            raise exception 'invalid_payload';
          end if;
          v_norm := jsonb_build_object(
            'question_id', v_payload -> 'question_id',
            'result', v_payload -> 'result',
            'score', v_payload -> 'score',
            'attempt', v_payload -> 'attempt'
          );
        when 'mastery_check_completed' then
          if not private.json_num_in(v_payload -> 'score', 0, 1)
             or jsonb_typeof(v_payload -> 'passed') is distinct from 'boolean'
             or not private.json_num_in(v_payload -> 'question_count', 0, 100000, true)
             or not private.json_num_in(v_payload -> 'version_no', 1, 1000000000, true) then
            raise exception 'invalid_payload';
          end if;
          v_norm := jsonb_build_object(
            'score', v_payload -> 'score',
            'passed', v_payload -> 'passed',
            'question_count', v_payload -> 'question_count',
            'version_no', v_payload -> 'version_no'
          );
      end case;

      -- authorisation: guardian of the child's household, or tutor with an active grant. A child that does
      -- not exist and a child of another household are indistinguishable (no existence oracle).
      v_cached := v_access -> (v_child::text);
      if v_cached is null then
        if private.can_access_child(v_child) then
          select jsonb_build_object('h', c.household_id, 'd', c.deleted_at is not null)
            into v_cached
            from public.children c
           where c.id = v_child;
        else
          v_cached := 'false'::jsonb;
        end if;
        v_access := v_access || jsonb_build_object(v_child::text, v_cached);
      end if;
      if v_cached = 'false'::jsonb then
        raise exception 'no_access_to_child';
      end if;
      v_hid := (v_cached ->> 'h')::uuid;
      if (v_cached ->> 'd')::boolean then
        raise exception 'child_deleted';
      end if;

      if not exists (select 1 from public.units u where u.id = v_unit) then
        raise exception 'unknown_unit';
      end if;

      -- the server re-checks what the device computed: passed <=> score >= 0.8 and at least one question
      if v_type = 'mastery_check_completed' then
        v_score := (v_payload ->> 'score')::numeric;
        v_qc := (v_payload ->> 'question_count')::numeric;
        if (v_payload ->> 'passed')::boolean is distinct from (v_score >= 0.8 and v_qc >= 1) then
          raise exception 'inconsistent_mastery';
        end if;
      end if;

      -- a retry of a stored event is a duplicate whatever the rate limit says (idempotency first)
      if exists (select 1 from public.progress_events e
                  where e.child_id = v_child and e.client_event_id = v_id) then
        v_status := 'duplicate';
      else
        v_cnt := (v_recent ->> (v_child::text))::int;
        if v_cnt is null then
          select count(*)::int into v_cnt
            from public.progress_events e
           where e.child_id = v_child
             and e.received_at > now() - interval '1 hour';
        end if;
        if v_cnt >= c_hourly_limit then
          raise exception 'rate_limited';
        end if;

        insert into public.progress_events
          (household_id, child_id, client_event_id, device_id, device_seq, unit_id, event_type, payload,
           occurred_at)
        values
          (v_hid, v_child, v_id, v_ev ->> 'device_id', v_seq::bigint, v_unit, v_type, v_norm, v_occ)
        on conflict (child_id, client_event_id) do nothing;
        get diagnostics v_rows = row_count;

        if v_rows = 0 then
          v_status := 'duplicate'; -- lost a race with a concurrent identical push
        else
          v_status := 'accepted';
          v_any_accepted := true;
          v_recent := v_recent || jsonb_build_object(v_child::text, v_cnt + 1);
          v_pairs_child := v_pairs_child || v_child;
          v_pairs_unit := v_pairs_unit || v_unit;
        end if;
      end if;
    exception when others then
      v_status := 'rejected';
      v_reason := case
        when sqlstate = 'P0001' and sqlerrm = any (c_reasons) then sqlerrm
        when sqlstate like '22%' then 'invalid_payload'   -- bad number/date/uuid text
        else 'internal_error'
      end;
    end;

    v_results := v_results || jsonb_build_array(
      jsonb_build_object('client_event_id', v_id, 'status', v_status)
      || case when v_reason is null then '{}'::jsonb else jsonb_build_object('reason', v_reason) end
    );
  end loop;

  -- PHASE 2: re-derive unit_progress for every touched (child, unit), sorted so concurrent calls agree on order
  if v_any_accepted then
    perform private.sync_lock();
    for v_pair in
      select distinct t.c, t.u
        from unnest(v_pairs_child, v_pairs_unit) as t(c, u)
       order by t.c, t.u
    loop
      perform private.derive_unit_progress(v_pair.c, v_pair.u);
    end loop;
  end if;

  return v_results;
end;
$$;

revoke all on function private.ingest_progress_events(jsonb) from public, anon, authenticated;
grant execute on function private.ingest_progress_events(jsonb) to authenticated;

create or replace function public.ingest_progress_events(p_events jsonb)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.ingest_progress_events(p_events); $$;

revoke all on function public.ingest_progress_events(jsonb) from public, anon, authenticated;
grant execute on function public.ingest_progress_events(jsonb) to authenticated;

comment on function public.ingest_progress_events(jsonb) is
  'Learner push (wire.ts PushResult[]). Up to 100 events; each is validated, authorised (guardian or granted tutor), deduplicated on (child_id, client_event_id) and stored independently; returns [{client_event_id, status: accepted|duplicate|rejected, reason?}] in input order and re-derives unit_progress. Raises only for a non-array argument, more than 100 events or no session.';
