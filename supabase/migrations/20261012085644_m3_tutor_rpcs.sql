-- 24 M3 tutor, part 3: the guardian RPCs and the service-role RPCs of the `tutor-chat` edge function.
--
-- Two audiences, both behind the usual pattern (thin SECURITY INVOKER `public.*` wrapper over a SECURITY DEFINER
-- `private.*` implementation, search_path = ''):
--
--   a guardian (authenticated)       get_tutor_consent, set_tutor_consent (grant needs an elevation),
--                                    list_tutor_sessions, get_tutor_transcript (both need an elevation)
--   the `tutor-chat` edge function   tutor_reserve_turn, tutor_open_session, tutor_save_turn, tutor_get_turn,
--   (service_role ONLY)              tutor_open_case, tutor_log_usage, tutor_purge_expired (also pg_cron)
--
-- The tables have no client privilege, so these functions are the only paths to the data. What they enforce:
--
--   * GUARDIANS ONLY. A tutor with a child grant gets `not_a_guardian` on every guardian RPC here (M3: transcripts and
--     consent belong to the household's guardians). A child id of another household is `child_not_found`, the same
--     answer as a child that does not exist, so the RPCs never reveal whether an id exists.
--   * WITHHELD TURNS. A turn that opened a case (or was marked to be withheld) is withheld from the guardian until a
--     reviewer releases its case. The real text of a withheld message never leaves the database: get_tutor_transcript
--     returns a neutral placeholder instead. guardian_visible_categories lists the categories a guardian may read
--     without waiting (never self_harm or abuse_disclosure).
--   * CONSENT is a ledger (`consents`, append-only): the effective state of (child, scope 'ai_tutor') is its LATEST row;
--     a household-level row (child_id null) does not count.
--   * ONE TURN, ONE COUNT. The daily counter is atomic and idempotent per client_turn_id; a turn is stored once however
--     often it is submitted (advisory lock per (child, turn) and the unique key); one turn per session may be in flight.
--   * REDACTED TEXT ONLY. The edge function sends redacted text. As a backstop tutor_save_turn scrubs e-mail addresses,
--     links and Nigerian phone numbers (and, in the child's text, any run of 10 or more digits) that a redactor missed
--     and counts them in `redaction_count`; it cannot find names, which only the pipeline knows.
--
-- Stable snake_case messages; SQLSTATE 42501 = not allowed, P0002 = not found, 22023 = refused / invalid.

-- helpers (no API role may execute them) -------------------------------------------------------------------------------------
-- the child's day: the daily limit resets at midnight in Nigeria
create or replace function private.tutor_today()
returns date
language sql
stable
set search_path = ''
as $$ select (now() at time zone 'Africa/Lagos')::date; $$;

-- the consent text version the household must have accepted (CURRENT_TUTOR_CONSENT_VERSION in the contract; a Vitest
-- test keeps the two equal). A new version of the text is a migration that changes this function.
create or replace function private.tutor_required_consent_version()
returns text
language sql
immutable
set search_path = ''
as $$ select 'tutor-v1-draft'::text; $$;

-- Backstop scrubber for text that is about to be stored. Replaces e-mail addresses, links and Nigerian phone numbers;
-- with p_digits (the child's text) also every run of 10 or more digits (bank account, BVN, NIN). `hits` counts the
-- replacements. Idempotent: its own placeholders contain nothing it replaces.
create or replace function private.tutor_scrub(p_text text, p_digits boolean)
returns table (clean text, hits int)
language plpgsql
immutable
set search_path = ''
as $$
declare
  v text := coalesce(p_text, '');
  n int := 0;
  k int;
begin
  select count(*) into k
    from regexp_matches(v, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}', 'g');
  if k > 0 then
    v := regexp_replace(v, '[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(\.[A-Za-z0-9\-]+)*\.[A-Za-z]{2,}', '[email]', 'g');
    n := n + k;
  end if;

  select count(*) into k from regexp_matches(v, '(https?://|www\.)\S*[^\s.,;:!?)\]]', 'gi');
  if k > 0 then
    v := regexp_replace(v, '(https?://|www\.)\S*[^\s.,;:!?)\]]', '[link]', 'gi');
    n := n + k;
  end if;

  select count(*) into k
    from regexp_matches(v, '(?<!\d)(\+?234|0)[ .\-]*[789][01]([ .\-]*\d){8}(?!\d)', 'g');
  if k > 0 then
    v := regexp_replace(v, '(?<!\d)(\+?234|0)[ .\-]*[789][01]([ .\-]*\d){8}(?!\d)', '[phone]', 'g');
    n := n + k;
  end if;

  if p_digits then
    select count(*) into k from regexp_matches(v, '\d{10,}', 'g');
    if k > 0 then
      v := regexp_replace(v, '\d{10,}', '[number]', 'g');
      n := n + k;
    end if;
  end if;

  clean := v;
  hits := n;
  return next;
end;
$$;

-- Is a stored message withheld from the guardian? Pure rule:
--   released case                      -> visible
--   not flagged and not withheld       -> visible
--   self_harm / abuse_disclosure       -> withheld, whatever the settings say
--   no category                        -> withheld (fail closed)
--   category in guardian_visible       -> visible
--   anything else                      -> withheld
create or replace function private.tutor_message_withheld(
  p_flagged boolean,
  p_withheld boolean,
  p_category text,
  p_released boolean,
  p_visible jsonb
)
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when coalesce(p_released, false) then false
    when not (coalesce(p_flagged, false) or coalesce(p_withheld, false)) then false
    when p_category in ('self_harm', 'abuse_disclosure') then true
    when p_category is null then true
    when jsonb_typeof(p_visible) = 'array' and p_visible ? p_category then false
    else true
  end;
$$;

-- the category that drove a SafetyDecision: the most serious category it lists, else the one implied by the fixed reply
create or replace function private.tutor_primary_category(p_safety jsonb)
returns text
language sql
immutable
set search_path = ''
as $$
  select coalesce(
    (select e ->> 'category'
       from jsonb_array_elements(case when jsonb_typeof(p_safety -> 'categories') = 'array' then p_safety -> 'categories' else '[]'::jsonb end) e
      where jsonb_typeof(e) = 'object'
        and (e ->> 'category') in ('self_harm', 'abuse_disclosure', 'distress', 'sexual', 'violence', 'personal_info_shared', 'jailbreak', 'off_topic')
        and coalesce(e ->> 'severity', 'none') <> 'none'
      order by array_position(
        array['self_harm', 'abuse_disclosure', 'distress', 'sexual', 'violence', 'personal_info_shared', 'jailbreak', 'off_topic'],
        e ->> 'category')
      limit 1),
    case p_safety ->> 'reply_key'
      when 'self_harm' then 'self_harm'
      when 'abuse' then 'abuse_disclosure'
      when 'distress' then 'distress'
    end
  );
$$;

-- the TutorTurnResult shape of a stored tutor message
create or replace function private.tutor_turn_result(m public.tutor_messages)
returns jsonb
language sql
immutable
set search_path = ''
as $$
  select jsonb_build_object(
    'session_id', m.session_id,
    'message_id', m.id,
    'status', m.status,
    'reply', m.text,
    'safety_action', coalesce(m.safety ->> 'action', 'allow'),
    'show_activity', m.show_activity
  );
$$;

-- the guardian of the child's household, or a precise refusal. A child of another household and a child that does not
-- exist give the same answer (`child_not_found`).
create or replace function private.tutor_guardian_child(p_child_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_hid uuid;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select c.household_id into v_hid from public.children c where c.id = p_child_id;
  if not found or not private.can_access_child(p_child_id) then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;
  if not private.is_household_member(v_hid, array['guardian']) then
    raise exception 'not_a_guardian' using errcode = '42501';
  end if;
  return v_hid;
end;
$$;

-- the TutorConsentState of a child: its latest ai_tutor row decides; household-level rows (child_id null) do not count
create or replace function private.tutor_consent_state(p_child_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select jsonb_build_object(
    'granted', coalesce(l.action = 'grant', false),
    'version', case when l.action = 'grant' then to_jsonb(l.version) else 'null'::jsonb end,
    'required_version', private.tutor_required_consent_version()
  )
  from (select 1) one
  left join lateral (
    select c.action, c.version
      from public.consents c
     where c.child_id = p_child_id and c.scope = 'ai_tutor'
     order by c.created_at desc, c.id desc
     limit 1
  ) l on true;
$$;

revoke all on function
  private.tutor_today(),
  private.tutor_required_consent_version(),
  private.tutor_scrub(text, boolean),
  private.tutor_message_withheld(boolean, boolean, text, boolean, jsonb),
  private.tutor_primary_category(jsonb),
  private.tutor_turn_result(public.tutor_messages),
  private.tutor_guardian_child(uuid),
  private.tutor_consent_state(uuid)
  from public, anon, authenticated, service_role;

-- get_tutor_consent -----------------------------------------------------------------------------------------------------------
-- Guardian of the child. {granted, version, required_version}: granted is true when the latest ledger row is a grant,
-- version is the version it accepted (null otherwise), required_version is the text the app must show. The caller
-- compares: the consent is current only when granted and version = required_version.
create or replace function private.get_tutor_consent(p_child_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform private.tutor_guardian_child(p_child_id);
  return private.tutor_consent_state(p_child_id);
end;
$$;

-- set_tutor_consent -----------------------------------------------------------------------------------------------------------
-- Guardian of the child. Appends a row to the consent ledger (scope 'ai_tutor'). Granting needs a live grown-up elevation
-- (`elevation_required`), a child that is not deleted and the REQUIRED version (`consent_version_mismatch`: a consent to an
-- older text is not a consent). Withdrawing needs no elevation and takes any version label. Repeating the current state
-- (same action, same version) appends nothing. Returns the new state.
create or replace function private.set_tutor_consent(p_child_id uuid, p_action text, p_version text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := (select auth.uid());
  v_hid uuid;
  v_state jsonb;
begin
  v_hid := private.tutor_guardian_child(p_child_id);
  if p_action is null or p_action not in ('grant', 'withdraw') then
    raise exception 'invalid_consent_action' using errcode = '22023';
  end if;
  if p_version is null or btrim(p_version) = '' or char_length(p_version) > 32 then
    raise exception 'invalid_consent_version' using errcode = '22023';
  end if;
  if p_action = 'grant' then
    if not private.has_grownup_elevation() then
      raise exception 'elevation_required' using errcode = '42501';
    end if;
    if exists (select 1 from public.children c where c.id = p_child_id and c.deleted_at is not null) then
      raise exception 'child_not_found' using errcode = 'P0002';
    end if;
    if p_version <> private.tutor_required_consent_version() then
      raise exception 'consent_version_mismatch' using errcode = '22023';
    end if;
  end if;

  -- one writer per child, so two quick taps append one row
  perform pg_advisory_xact_lock(hashtextextended('tutor_consent:' || p_child_id::text, 0));
  v_state := private.tutor_consent_state(p_child_id);

  if p_action = 'grant' and (v_state ->> 'granted')::boolean and (v_state ->> 'version') = p_version then
    return v_state;
  end if;
  if p_action = 'withdraw' and not (v_state ->> 'granted')::boolean then
    return v_state;
  end if;

  -- clock_timestamp(): several rows in one transaction still sort in the order they were written
  insert into public.consents (user_id, household_id, child_id, scope, version, action, created_at)
  values (v_uid, v_hid, p_child_id, 'ai_tutor', p_version, p_action, clock_timestamp());
  return private.tutor_consent_state(p_child_id);
end;
$$;

-- list_tutor_sessions ---------------------------------------------------------------------------------------------------------
-- Guardian + live elevation. The newest sessions first: [{id, unit_id, started_at, turns, has_withheld}] (TutorSessionSummary).
create or replace function private.list_tutor_sessions(p_child_id uuid, p_limit int default 20)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_visible jsonb;
begin
  perform private.tutor_guardian_child(p_child_id);
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;
  if p_limit is null or p_limit not between 1 and 100 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  v_visible := private.tutor_setting('safeguarding.guardian_visible_categories');

  return coalesce((
    select jsonb_agg(x.item order by x.started_at desc)
      from (
        select s.started_at,
               jsonb_build_object(
                 'id', s.id,
                 'unit_id', s.unit_id,
                 'started_at', s.started_at,
                 'turns', s.turn_count,
                 'has_withheld', exists (
                   select 1
                     from public.tutor_messages m
                    where m.session_id = s.id
                      and m.text is not null
                      and private.tutor_message_withheld(
                            m.flagged, m.withheld, m.flag_category,
                            exists (select 1 from public.safeguarding_cases c
                                     where c.child_id = m.child_id and c.client_turn_id = m.client_turn_id
                                       and c.released_at is not null),
                            v_visible)
                 )
               ) as item
          from public.tutor_sessions s
         where s.child_id = p_child_id
         order by s.started_at desc
         limit p_limit
      ) x
  ), '[]'::jsonb);
end;
$$;

-- get_tutor_transcript ---------------------------------------------------------------------------------------------------------
-- Guardian + live elevation. The messages of a session in order: [{id, role, text, created_at, withheld}]
-- (TutorTranscriptMessage). A withheld message comes back with withheld = true and the neutral text 'Message not shown.'; its
-- real text is never selected into the result. The failed reply of a failed turn (no text) is left out.
create or replace function private.get_tutor_transcript(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child uuid;
  v_visible jsonb;
begin
  if (select auth.uid()) is null then
    raise exception 'not_authenticated' using errcode = '42501';
  end if;
  select s.child_id into v_child from public.tutor_sessions s where s.id = p_session_id;
  if not found or not private.can_access_child(v_child) then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  perform private.tutor_guardian_child(v_child);
  if not private.has_grownup_elevation() then
    raise exception 'elevation_required' using errcode = '42501';
  end if;
  v_visible := private.tutor_setting('safeguarding.guardian_visible_categories');

  return coalesce((
    select jsonb_agg(
             jsonb_build_object(
               'id', m.id,
               'role', m.role,
               'text', case when w.withheld then 'Message not shown.' else m.text end,
               'created_at', m.created_at,
               'withheld', w.withheld
             )
             order by m.seq)
      from public.tutor_messages m
      cross join lateral (
        select private.tutor_message_withheld(
                 m.flagged, m.withheld, m.flag_category,
                 exists (select 1 from public.safeguarding_cases c
                          where c.child_id = m.child_id and c.client_turn_id = m.client_turn_id
                            and c.released_at is not null),
                 v_visible) as withheld
      ) w
     where m.session_id = p_session_id
       and m.text is not null
  ), '[]'::jsonb);
end;
$$;

-- tutor_reserve_turn (service_role) ------------------------------------------------------------------------------------------
-- The daily budget. Atomically counts one turn of the child for today (Africa/Lagos) and says whether it is allowed:
-- {allowed, turns, limit}. The limit is the caller's (tutor.daily_turns_per_child, 1 to 500). A turn is counted ONCE: when
-- p_client_turn_id is the turn counted last, nothing is added again (a retry of a turn that crashed before it was stored).
-- A refused turn is not counted.
create or replace function private.tutor_reserve_turn(p_child_id uuid, p_limit int, p_client_turn_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_hid uuid;
  v_day date := private.tutor_today();
  v_turns int;
  v_last uuid;
begin
  if p_limit is null or p_limit not between 1 and 500 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  select c.household_id into v_hid from public.children c where c.id = p_child_id and c.deleted_at is null;
  if not found then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;

  insert into public.tutor_daily_usage (child_id, household_id, day, turns)
  values (p_child_id, v_hid, v_day, 0)
  on conflict (child_id, day) do nothing;

  -- the row lock serialises concurrent reservations of one child
  select u.turns, u.last_turn_id into v_turns, v_last
    from public.tutor_daily_usage u
   where u.child_id = p_child_id and u.day = v_day
   for update;

  if p_client_turn_id is not null and v_last = p_client_turn_id then
    return jsonb_build_object('allowed', true, 'turns', v_turns, 'limit', p_limit);
  end if;
  if v_turns >= p_limit then
    return jsonb_build_object('allowed', false, 'turns', v_turns, 'limit', p_limit);
  end if;

  update public.tutor_daily_usage u
     set turns = u.turns + 1, last_turn_id = p_client_turn_id
   where u.child_id = p_child_id and u.day = v_day
  returning u.turns into v_turns;
  return jsonb_build_object('allowed', true, 'turns', v_turns, 'limit', p_limit);
end;
$$;

-- tutor_open_session (service_role) ---------------------------------------------------------------------------------------------
-- Opens a session (p_session_id null: the first turn of a lesson) or continues one, and claims its single in-flight slot for
-- p_client_turn_id for p_lease_seconds. Returns
--   {stored: true,  busy: false, session_id}                    this turn is already stored (a retry that raced the save)
--   {stored: false, busy: true,  session_id}                    another turn (or this very one) is still running
--   {stored: false, busy: false, session_id, created, history, turn_count}
--                                                               the caller may run the turn. `history` is the last
--                                                               p_history_turns turns that COMPLETED normally, as
--                                                               [{role, text}] oldest first: turns that were blocked,
--                                                               redirected, replaced, answered with a safe reply or failed
--                                                               are never fed back to the model.
-- A session of another child is `session_not_found`; a session of another unit is `session_unit_mismatch`.
create or replace function private.tutor_open_session(
  p_child_id uuid,
  p_session_id uuid,
  p_unit_id uuid,
  p_version_no int,
  p_client_turn_id uuid,
  p_history_turns int default 0,
  p_lease_seconds int default 180
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_child public.children%rowtype;
  v_session public.tutor_sessions%rowtype;
  v_created boolean := false;
  v_stored uuid;
  v_history jsonb := '[]'::jsonb;
begin
  if p_child_id is null or p_unit_id is null or p_client_turn_id is null
     or p_version_no is null or p_version_no < 1
     or p_history_turns is null or p_history_turns not between 0 and 40 then
    raise exception 'invalid_turn_request' using errcode = '22023';
  end if;
  if p_lease_seconds is null or p_lease_seconds not between 10 and 600 then
    raise exception 'invalid_lease_seconds' using errcode = '22023';
  end if;
  select * into v_child from public.children c where c.id = p_child_id and c.deleted_at is null;
  if not found then
    raise exception 'child_not_found' using errcode = 'P0002';
  end if;
  if not exists (select 1 from public.units u where u.id = p_unit_id) then
    raise exception 'unit_not_found' using errcode = 'P0002';
  end if;

  -- one critical section per (child, turn): concurrent submits of the same turn cannot open two sessions
  perform pg_advisory_xact_lock(hashtextextended('tutor_turn:' || p_child_id::text || ':' || p_client_turn_id::text, 0));

  select m.session_id into v_stored
    from public.tutor_messages m
   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id and m.role = 'child';
  if found then
    return jsonb_build_object('stored', true, 'busy', false, 'session_id', v_stored);
  end if;

  if p_session_id is not null then
    select * into v_session from public.tutor_sessions s
     where s.id = p_session_id and s.child_id = p_child_id
     for update;
    if not found then
      raise exception 'session_not_found' using errcode = 'P0002';
    end if;
    if v_session.unit_id <> p_unit_id then
      raise exception 'session_unit_mismatch' using errcode = '22023';
    end if;
  else
    -- the first turn of a lesson may have been submitted before: its session is still claimed by this turn id
    select * into v_session from public.tutor_sessions s
     where s.child_id = p_child_id and s.in_flight_turn_id = p_client_turn_id
     for update;
    if not found then
      insert into public.tutor_sessions (household_id, child_id, unit_id, version_no, in_flight_turn_id, in_flight_until)
      values (v_child.household_id, p_child_id, p_unit_id, p_version_no, p_client_turn_id,
              now() + make_interval(secs => p_lease_seconds))
      returning * into v_session;
      v_created := true;
    end if;
  end if;

  if not v_created then
    if v_session.in_flight_until is not null and v_session.in_flight_until > now() then
      return jsonb_build_object('stored', false, 'busy', true, 'session_id', v_session.id);
    end if;
    begin
      update public.tutor_sessions s
         set in_flight_turn_id = p_client_turn_id, in_flight_until = now() + make_interval(secs => p_lease_seconds)
       where s.id = v_session.id;
    exception when unique_violation then
      -- this turn id already claims another session of the child: a client bug, answered as busy
      return jsonb_build_object('stored', false, 'busy', true, 'session_id', v_session.id);
    end;

    select coalesce(jsonb_agg(jsonb_build_object('role', h.role, 'text', h.text) order by h.seq), '[]'::jsonb)
      into v_history
      from (
        select m.role, m.text, m.seq
          from public.tutor_messages m
         where m.session_id = v_session.id and m.status = 'complete' and m.text is not null
         order by m.seq desc
         limit p_history_turns * 2
      ) h;
  end if;

  return jsonb_build_object(
    'stored', false, 'busy', false, 'session_id', v_session.id, 'created', v_created,
    'history', v_history, 'turn_count', v_session.turn_count
  );
end;
$$;

-- the case of a turn, created once (shared by tutor_save_turn and tutor_open_case) ---------------------------------------------------
-- Returns {case_id, created, due_at, category, severity}. due_at = now + safeguarding.sla_hours[severity]. The excerpt is the
-- last six STORED (redacted) messages of the session up to the reply of the flagged turn. The messages of the turn and its
-- session are marked flagged, so the purge and the guardian view follow the case.
create or replace function private.tutor_case_ensure(
  p_child_id uuid,
  p_client_turn_id uuid,
  p_category text,
  p_severity text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_case public.safeguarding_cases%rowtype;
  v_msg public.tutor_messages%rowtype;
  v_hours numeric;
  v_excerpt jsonb;
  v_created boolean := false;
begin
  select * into v_case from public.safeguarding_cases c
   where c.child_id = p_child_id and c.client_turn_id = p_client_turn_id;
  if found then
    return jsonb_build_object('case_id', v_case.id, 'created', false, 'due_at', v_case.due_at,
                              'category', v_case.category, 'severity', v_case.severity);
  end if;

  select * into v_msg from public.tutor_messages m
   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id and m.role = 'child';
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;

  v_hours := (private.tutor_setting('safeguarding.sla_hours') ->> p_severity)::numeric;
  select coalesce(jsonb_agg(jsonb_build_object('role', e.role, 'text', e.text, 'at', e.created_at) order by e.seq), '[]'::jsonb)
    into v_excerpt
    from (
      select m.role, m.text, m.created_at, m.seq
        from public.tutor_messages m
       where m.session_id = v_msg.session_id and m.text is not null and m.seq <= v_msg.seq + 1
       order by m.seq desc
       limit 6
    ) e;

  insert into public.safeguarding_cases
    (session_id, message_id, client_turn_id, household_id, child_id, category, severity, excerpt, due_at)
  values
    (v_msg.session_id, v_msg.id, p_client_turn_id, v_msg.household_id, p_child_id, p_category, p_severity, v_excerpt,
     now() + make_interval(secs => (v_hours * 3600)::double precision))
  on conflict (child_id, client_turn_id) do nothing
  returning * into v_case;
  v_created := found;
  if not v_created then
    select * into v_case from public.safeguarding_cases c
     where c.child_id = p_child_id and c.client_turn_id = p_client_turn_id;
  end if;

  update public.tutor_messages m
     set flagged = true, flag_category = coalesce(m.flag_category, p_category)
   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id;
  update public.tutor_sessions s set flagged = true where s.id = v_msg.session_id;

  return jsonb_build_object('case_id', v_case.id, 'created', v_created, 'due_at', v_case.due_at,
                            'category', v_case.category, 'severity', v_case.severity);
end;
$$;

-- tutor_save_turn (service_role) ----------------------------------------------------------------------------------------------
-- Stores one turn: the child's message and the tutor's reply, both REDACTED, with the safety decision, the advisory evidence
-- and activity suggestion, updates the session (counters, flagged, model, in-flight slot) and, when the safety decision says
-- open_case, opens the case in the same transaction (a crash between the save and a separate call cannot lose a case).
-- IDEMPOTENT on (child, client_turn_id): a second save (double submit) changes nothing and returns the stored turn with
-- duplicate = true. A failed turn stores the child's message and a reply row with no text (status failed); with
-- p_refund_turn the day's counter gets the turn back (the caller passes it only when no model call was billed).
-- Returns the TutorTurnResult shape plus {child_message_id, duplicate, case_id, scrubbed}.
create or replace function private.tutor_save_turn(
  p_child_id uuid,
  p_session_id uuid,
  p_client_turn_id uuid,
  p_message_id uuid,
  p_input_mode text,
  p_child_text text,
  p_redaction_count int,
  p_reply_text text,
  p_status text,
  p_safety jsonb,
  p_evidence jsonb,
  p_show_activity jsonb,
  p_model text,
  p_prompt_version text,
  p_refund_turn boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.tutor_sessions%rowtype;
  v_existing public.tutor_messages%rowtype;
  v_reply public.tutor_messages%rowtype;
  v_child_clean text;
  v_reply_clean text;
  v_child_hits int := 0;
  v_reply_hits int := 0;
  v_open_case boolean;
  v_withhold boolean;
  v_flagged boolean;
  v_category text;
  v_severity text;
  v_seq int;
  v_child_msg uuid := gen_random_uuid();
  v_tutor_msg uuid := coalesce(p_message_id, gen_random_uuid());
  v_evidence jsonb := '[]'::jsonb;
  v_activity jsonb;
  v_case jsonb;
begin
  if p_child_id is null or p_session_id is null or p_client_turn_id is null then
    raise exception 'invalid_turn_request' using errcode = '22023';
  end if;
  if p_status is null or p_status not in ('complete', 'replaced', 'blocked', 'safe_reply', 'failed') then
    raise exception 'invalid_turn_status' using errcode = '22023';
  end if;
  if p_input_mode is null or p_input_mode not in ('text', 'voice') then
    raise exception 'invalid_input_mode' using errcode = '22023';
  end if;
  if p_child_text is null or btrim(p_child_text) = '' or char_length(p_child_text) > 1000 then
    raise exception 'invalid_turn_text' using errcode = '22023';
  end if;
  if p_status <> 'failed'
     and (p_reply_text is null or btrim(p_reply_text) = '' or char_length(p_reply_text) > 4000) then
    raise exception 'invalid_turn_text' using errcode = '22023';
  end if;
  if p_redaction_count is null or p_redaction_count not between 0 and 1000 then
    raise exception 'invalid_turn_request' using errcode = '22023';
  end if;
  if p_safety is null or jsonb_typeof(p_safety) <> 'object' or octet_length(p_safety::text) > 4000
     or (p_safety ->> 'action') is null
     or (p_safety ->> 'action') not in ('allow', 'steer', 'redirect', 'blocked', 'safe_reply') then
    raise exception 'invalid_safety' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('tutor_turn:' || p_child_id::text || ':' || p_client_turn_id::text, 0));
  select * into v_session from public.tutor_sessions s
   where s.id = p_session_id and s.child_id = p_child_id
   for update;
  if not found then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;

  select * into v_existing from public.tutor_messages m
   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id and m.role = 'tutor';
  if found then
    if v_session.in_flight_turn_id = p_client_turn_id then
      update public.tutor_sessions s set in_flight_turn_id = null, in_flight_until = null where s.id = v_session.id;
    end if;
    return private.tutor_turn_result(v_existing)
        || jsonb_build_object('duplicate', true, 'scrubbed', 0,
             'case_id', (select c.id from public.safeguarding_cases c
                          where c.child_id = p_child_id and c.client_turn_id = p_client_turn_id),
             'child_message_id', (select m.id from public.tutor_messages m
                                   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id and m.role = 'child'));
  end if;

  -- what the safety decision asks for
  v_open_case := coalesce(case when jsonb_typeof(p_safety -> 'open_case') = 'boolean'
                               then (p_safety ->> 'open_case')::boolean end, false);
  v_withhold := coalesce(case when jsonb_typeof(p_safety -> 'withhold_from_guardian') = 'boolean'
                              then (p_safety ->> 'withhold_from_guardian')::boolean end, false);
  v_flagged := v_open_case or v_withhold;
  v_category := private.tutor_primary_category(p_safety);
  if v_flagged and v_category is null then
    v_category := 'distress';
    v_severity := 'high';
  else
    v_severity := case
      when p_safety ->> 'case_severity' in ('low', 'medium', 'high') then p_safety ->> 'case_severity'
      when v_category in ('self_harm', 'abuse_disclosure') then 'high'
      when v_category = 'distress' then 'medium'
      else 'low'
    end;
  end if;

  -- backstop scrub (the text is already redacted by the pipeline)
  select s.clean, s.hits into v_child_clean, v_child_hits from private.tutor_scrub(p_child_text, true) s;
  if p_status <> 'failed' then
    select s.clean, s.hits into v_reply_clean, v_reply_hits from private.tutor_scrub(p_reply_text, false) s;
  end if;

  -- advisory evidence: rebuilt from the three known fields, at most 10 items, notes scrubbed and cut to 200 characters
  if jsonb_typeof(p_evidence) = 'array' then
    select coalesce(jsonb_agg(
             jsonb_strip_nulls(jsonb_build_object(
               'kind', t.e ->> 'kind',
               'question_id', case when (t.e ->> 'question_id') ~ '^[A-Za-z0-9_\-]{1,64}$' then t.e ->> 'question_id' end,
               'note', (select s.clean from private.tutor_scrub(left(coalesce(t.e ->> 'note', ''), 200), false) s)
             )) order by t.o), '[]'::jsonb)
      into v_evidence
      from jsonb_array_elements(p_evidence) with ordinality as t(e, o)
     where t.o <= 10
       and jsonb_typeof(t.e) = 'object'
       and (t.e ->> 'kind') in ('understood', 'struggling', 'misconception');
  end if;
  if jsonb_typeof(p_show_activity) = 'object' and (p_show_activity ->> 'question_id') ~ '^[A-Za-z0-9_\-]{1,64}$' then
    v_activity := jsonb_build_object('question_id', p_show_activity ->> 'question_id');
  end if;

  v_seq := v_session.turn_count * 2 + 1;
  insert into public.tutor_messages
    (id, session_id, household_id, child_id, client_turn_id, seq, role, input_mode, text, redaction_count, status,
     flagged, withheld, flag_category)
  values
    (v_child_msg, p_session_id, v_session.household_id, p_child_id, p_client_turn_id, v_seq, 'child', p_input_mode,
     v_child_clean, p_redaction_count + v_child_hits, p_status, v_flagged, v_withhold,
     case when v_flagged then v_category end);
  insert into public.tutor_messages
    (id, session_id, household_id, child_id, client_turn_id, seq, role, text, redaction_count, status, safety, evidence,
     show_activity, flagged, withheld, flag_category)
  values
    (v_tutor_msg, p_session_id, v_session.household_id, p_child_id, p_client_turn_id, v_seq + 1, 'tutor',
     case when p_status = 'failed' then null else v_reply_clean end, v_reply_hits, p_status, p_safety, v_evidence,
     v_activity, v_flagged, v_withhold, case when v_flagged then v_category end);

  update public.tutor_sessions s
     set turn_count = s.turn_count + 1,
         last_active_at = now(),
         flagged = s.flagged or v_flagged,
         model = coalesce(left(nullif(btrim(p_model), ''), 100), s.model),
         prompt_version = coalesce(left(nullif(btrim(p_prompt_version), ''), 64), s.prompt_version),
         in_flight_turn_id = case when s.in_flight_turn_id = p_client_turn_id then null else s.in_flight_turn_id end,
         in_flight_until = case when s.in_flight_turn_id = p_client_turn_id then null else s.in_flight_until end
   where s.id = p_session_id;

  if v_open_case then
    v_case := private.tutor_case_ensure(p_child_id, p_client_turn_id, v_category, v_severity);
  end if;

  if p_refund_turn and p_status = 'failed' then
    update public.tutor_daily_usage u
       set turns = greatest(u.turns - 1, 0), last_turn_id = null
     where u.child_id = p_child_id and u.day = private.tutor_today() and u.last_turn_id = p_client_turn_id;
  end if;

  select * into v_reply from public.tutor_messages m where m.id = v_tutor_msg;
  return private.tutor_turn_result(v_reply)
      || jsonb_build_object('duplicate', false, 'child_message_id', v_child_msg, 'scrubbed', v_child_hits + v_reply_hits,
                            'case_id', v_case -> 'case_id');
end;
$$;

-- tutor_get_turn (service_role) -------------------------------------------------------------------------------------------------
-- The stored result of a turn ({session_id, message_id, status, reply, safety_action, show_activity}), or NULL when there is
-- none (never sent, or still running).
create or replace function private.tutor_get_turn(p_child_id uuid, p_client_turn_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select private.tutor_turn_result(m)
    from public.tutor_messages m
   where m.child_id = p_child_id and m.client_turn_id = p_client_turn_id and m.role = 'tutor';
$$;

-- tutor_open_case (service_role) ------------------------------------------------------------------------------------------------
-- Opens the safeguarding case of the turn that p_message_id (either message of it) belongs to. IDEMPOTENT per turn: a second
-- call returns the first case unchanged. Returns {case_id, created, due_at, category, severity}.
create or replace function private.tutor_open_case(p_message_id uuid, p_category text, p_severity text)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg public.tutor_messages%rowtype;
begin
  if p_category is null
     or p_category not in ('self_harm', 'abuse_disclosure', 'distress', 'sexual', 'violence', 'personal_info_shared', 'jailbreak', 'off_topic') then
    raise exception 'invalid_category' using errcode = '22023';
  end if;
  if p_severity is null or p_severity not in ('low', 'medium', 'high') then
    raise exception 'invalid_severity' using errcode = '22023';
  end if;
  select * into v_msg from public.tutor_messages m where m.id = p_message_id;
  if not found then
    raise exception 'message_not_found' using errcode = 'P0002';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('tutor_turn:' || v_msg.child_id::text || ':' || v_msg.client_turn_id::text, 0));
  return private.tutor_case_ensure(v_msg.child_id, v_msg.client_turn_id, p_category, p_severity);
end;
$$;

-- tutor_log_usage (service_role) ---------------------------------------------------------------------------------------------------
-- One ai_usage row per UsageRecord of the turn (tutor and moderation calls; failed but billed calls too). Tokens only: the
-- label is cut to plain identifier characters, no text is accepted. est_cost_usd by the M2 rule (private.ai_call_cost: the
-- exact ai.prices key, else the longest key that is a prefix of the reported model; NULL, never zero, when there is none).
-- Returns the number of rows written.
create or replace function private.tutor_log_usage(p_session_id uuid, p_usage jsonb)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prices jsonb := private.ai_setting('ai.prices');
  v_n int;
begin
  if p_usage is null or jsonb_typeof(p_usage) <> 'array' or jsonb_array_length(p_usage) > 20 then
    raise exception 'invalid_usage' using errcode = '22023';
  end if;
  if p_session_id is null or not exists (select 1 from public.tutor_sessions s where s.id = p_session_id) then
    raise exception 'session_not_found' using errcode = 'P0002';
  end if;
  begin
    with ins as (
      insert into public.ai_usage
        (tutor_session_id, label, task, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens,
         est_cost_usd, stop_reason, duration_ms)
      select
        p_session_id,
        coalesce(nullif(left(regexp_replace(coalesce(u.label, ''), '[^A-Za-z0-9_:.\-]', '', 'g'), 100), ''), 'tutor'),
        u.task,
        left(u.model, 100),
        coalesce(u.input_tokens, 0),
        coalesce(u.output_tokens, 0),
        coalesce(u.cache_read_tokens, 0),
        coalesce(u.cache_creation_tokens, 0),
        private.ai_call_cost(v_prices, u.model, u.input_tokens, u.output_tokens, u.cache_read_tokens, u.cache_creation_tokens),
        left(u.stop_reason, 64),
        coalesce(u.duration_ms, 0)
      from jsonb_to_recordset(p_usage) as u(
        label text, task text, model text, input_tokens int, output_tokens int,
        cache_read_tokens int, cache_creation_tokens int, stop_reason text, duration_ms int
      )
      where u.task in ('tutor', 'moderation') and u.model is not null and btrim(u.model) <> ''
      returning 1
    )
    select count(*) into v_n from ins;
  exception when invalid_text_representation or check_violation or numeric_value_out_of_range or datatype_mismatch then
    raise exception 'invalid_usage' using errcode = '22023';
  end;
  if v_n <> jsonb_array_length(p_usage) then
    raise exception 'invalid_usage' using errcode = '22023';
  end if;
  return v_n;
end;
$$;

-- tutor_purge_expired (service_role, and pg_cron when scheduled) ----------------------------------------------------------------------
-- Retention (tutor.retention_days, default 90):
--   * unflagged messages older than the retention period are deleted;
--   * a FLAGGED message follows its case: it is kept until the case is resolved and 30 days (the grace) have passed, and it
--     is never deleted before the ordinary retention period either. A flagged message without a case is kept one grace
--     period beyond the retention period;
--   * sessions left without messages (and idle for a day, and not running a turn) are deleted;
--   * the excerpt of a case resolved longer ago than the retention period is cleared (the case row, its decision and notes
--     stay), except for cases that were escalated;
--   * daily counters older than 35 days are deleted.
-- Returns {messages, flagged_messages, sessions, case_excerpts, usage_days}.
create or replace function private.tutor_purge_expired()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_days int := coalesce(private.json_int(private.tutor_setting('tutor.retention_days'), 1, 3650), 90);
  v_grace constant interval := interval '30 days';
  v_msgs int;
  v_flagged int;
  v_sessions int;
  v_excerpts int;
  v_usage int;
begin
  with d as (delete from public.tutor_messages m where not m.flagged and m.created_at < now() - make_interval(days => v_days) returning 1) select count(*) into v_msgs from d;

  with d as (delete from public.tutor_messages m where m.flagged and m.created_at < now() - make_interval(days => v_days) and (exists (select 1 from public.safeguarding_cases c where c.child_id = m.child_id and c.client_turn_id = m.client_turn_id and c.status = 'resolved' and c.resolved_at < now() - v_grace) or (not exists (select 1 from public.safeguarding_cases c where c.child_id = m.child_id and c.client_turn_id = m.client_turn_id) and m.created_at < now() - make_interval(days => v_days) - v_grace)) returning 1) select count(*) into v_flagged from d;

  with d as (delete from public.tutor_sessions s where s.last_active_at < now() - interval '1 day' and (s.in_flight_until is null or s.in_flight_until < now()) and not exists (select 1 from public.tutor_messages m where m.session_id = s.id) returning 1) select count(*) into v_sessions from d;

  with u as (update public.safeguarding_cases c set excerpt = '[]'::jsonb, excerpt_cleared_at = now() where c.status = 'resolved' and c.resolved_at < now() - make_interval(days => v_days) and c.decision is distinct from 'escalated' and c.excerpt_cleared_at is null returning 1) select count(*) into v_excerpts from u;

  with d as (delete from public.tutor_daily_usage u where u.day < private.tutor_today() - 35 returning 1) select count(*) into v_usage from d;

  return jsonb_build_object(
    'messages', v_msgs, 'flagged_messages', v_flagged, 'sessions', v_sessions,
    'case_excerpts', v_excerpts, 'usage_days', v_usage
  );
end;
$$;

-- grants: private implementations ---------------------------------------------------------------------------------------------------------
revoke all on function
  private.get_tutor_consent(uuid),
  private.set_tutor_consent(uuid, text, text),
  private.list_tutor_sessions(uuid, int),
  private.get_tutor_transcript(uuid),
  private.tutor_reserve_turn(uuid, int, uuid),
  private.tutor_open_session(uuid, uuid, uuid, int, uuid, int, int),
  private.tutor_case_ensure(uuid, uuid, text, text),
  private.tutor_save_turn(uuid, uuid, uuid, uuid, text, text, int, text, text, jsonb, jsonb, jsonb, text, text, boolean),
  private.tutor_get_turn(uuid, uuid),
  private.tutor_open_case(uuid, text, text),
  private.tutor_log_usage(uuid, jsonb),
  private.tutor_purge_expired()
  from public, anon, authenticated, service_role;

grant execute on function
  private.get_tutor_consent(uuid),
  private.set_tutor_consent(uuid, text, text),
  private.list_tutor_sessions(uuid, int),
  private.get_tutor_transcript(uuid)
  to authenticated;

grant execute on function
  private.tutor_reserve_turn(uuid, int, uuid),
  private.tutor_open_session(uuid, uuid, uuid, int, uuid, int, int),
  private.tutor_save_turn(uuid, uuid, uuid, uuid, text, text, int, text, text, jsonb, jsonb, jsonb, text, text, boolean),
  private.tutor_get_turn(uuid, uuid),
  private.tutor_open_case(uuid, text, text),
  private.tutor_log_usage(uuid, jsonb),
  private.tutor_purge_expired()
  to service_role;

-- public wrappers (SECURITY INVOKER) ----------------------------------------------------------------------------------------------------------
create or replace function public.get_tutor_consent(p_child_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.get_tutor_consent(p_child_id); $$;

create or replace function public.set_tutor_consent(p_child_id uuid, p_action text, p_version text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.set_tutor_consent(p_child_id, p_action, p_version); $$;

create or replace function public.list_tutor_sessions(p_child_id uuid, p_limit int default 20)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.list_tutor_sessions(p_child_id, p_limit); $$;

create or replace function public.get_tutor_transcript(p_session_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.get_tutor_transcript(p_session_id); $$;

create or replace function public.tutor_reserve_turn(p_child_id uuid, p_limit int, p_client_turn_id uuid default null)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_reserve_turn(p_child_id, p_limit, p_client_turn_id); $$;

create or replace function public.tutor_open_session(
  p_child_id uuid,
  p_session_id uuid,
  p_unit_id uuid,
  p_version_no int,
  p_client_turn_id uuid,
  p_history_turns int default 0,
  p_lease_seconds int default 180
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.tutor_open_session(p_child_id, p_session_id, p_unit_id, p_version_no, p_client_turn_id, p_history_turns, p_lease_seconds);
$$;

create or replace function public.tutor_save_turn(
  p_child_id uuid,
  p_session_id uuid,
  p_client_turn_id uuid,
  p_message_id uuid,
  p_input_mode text,
  p_child_text text,
  p_redaction_count int,
  p_reply_text text,
  p_status text,
  p_safety jsonb,
  p_evidence jsonb,
  p_show_activity jsonb,
  p_model text,
  p_prompt_version text,
  p_refund_turn boolean default false
)
returns jsonb
language sql
security invoker
set search_path = ''
as $$
  select private.tutor_save_turn(
    p_child_id, p_session_id, p_client_turn_id, p_message_id, p_input_mode, p_child_text, p_redaction_count,
    p_reply_text, p_status, p_safety, p_evidence, p_show_activity, p_model, p_prompt_version, p_refund_turn);
$$;

create or replace function public.tutor_get_turn(p_child_id uuid, p_client_turn_id uuid)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_get_turn(p_child_id, p_client_turn_id); $$;

create or replace function public.tutor_open_case(p_message_id uuid, p_category text, p_severity text)
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_open_case(p_message_id, p_category, p_severity); $$;

create or replace function public.tutor_log_usage(p_session_id uuid, p_usage jsonb)
returns int
language sql
security invoker
set search_path = ''
as $$ select private.tutor_log_usage(p_session_id, p_usage); $$;

create or replace function public.tutor_purge_expired()
returns jsonb
language sql
security invoker
set search_path = ''
as $$ select private.tutor_purge_expired(); $$;

revoke all on function
  public.get_tutor_consent(uuid),
  public.set_tutor_consent(uuid, text, text),
  public.list_tutor_sessions(uuid, int),
  public.get_tutor_transcript(uuid),
  public.tutor_reserve_turn(uuid, int, uuid),
  public.tutor_open_session(uuid, uuid, uuid, int, uuid, int, int),
  public.tutor_save_turn(uuid, uuid, uuid, uuid, text, text, int, text, text, jsonb, jsonb, jsonb, text, text, boolean),
  public.tutor_get_turn(uuid, uuid),
  public.tutor_open_case(uuid, text, text),
  public.tutor_log_usage(uuid, jsonb),
  public.tutor_purge_expired()
  from public, anon, authenticated, service_role;

grant execute on function
  public.get_tutor_consent(uuid),
  public.set_tutor_consent(uuid, text, text),
  public.list_tutor_sessions(uuid, int),
  public.get_tutor_transcript(uuid)
  to authenticated;

grant execute on function
  public.tutor_reserve_turn(uuid, int, uuid),
  public.tutor_open_session(uuid, uuid, uuid, int, uuid, int, int),
  public.tutor_save_turn(uuid, uuid, uuid, uuid, text, text, int, text, text, jsonb, jsonb, jsonb, text, text, boolean),
  public.tutor_get_turn(uuid, uuid),
  public.tutor_open_case(uuid, text, text),
  public.tutor_log_usage(uuid, jsonb),
  public.tutor_purge_expired()
  to service_role;

comment on function public.get_tutor_consent(uuid) is
  'Guardian of the child. {granted, version, required_version}: the latest ai_tutor row of the consent ledger decides (a household-level row does not count). The consent is current when granted and version = required_version.';
comment on function public.set_tutor_consent(uuid, text, text) is
  'Guardian of the child. Appends an ai_tutor row to the consent ledger. grant needs a live grown-up elevation and the required version (consent_version_mismatch otherwise); withdraw needs neither. Repeating the current state appends nothing. Returns the new state.';
comment on function public.list_tutor_sessions(uuid, int) is
  'Guardian of the child + live grown-up elevation (a granted tutor is refused). The newest sessions: [{id, unit_id, started_at, turns, has_withheld}].';
comment on function public.get_tutor_transcript(uuid) is
  'Guardian of the session''s child + live grown-up elevation. [{id, role, text, created_at, withheld}]. Messages of flagged turns whose case is not released are returned withheld with the placeholder text; their real text never leaves the database.';
comment on function public.tutor_reserve_turn(uuid, int, uuid) is
  'service_role only (tutor-chat). Atomic daily turn counter of the child (Africa/Lagos day): {allowed, turns, limit}. Counts a client_turn_id once; a refused turn is not counted.';
comment on function public.tutor_open_session(uuid, uuid, uuid, int, uuid, int, int) is
  'service_role only. Opens or continues a session and claims its single in-flight slot for the turn: {stored} | {busy} | {session_id, created, history, turn_count}. History = completed turns only.';
comment on function public.tutor_save_turn(uuid, uuid, uuid, uuid, text, text, int, text, text, jsonb, jsonb, jsonb, text, text, boolean) is
  'service_role only. Stores one turn (REDACTED child text and reply, safety, evidence, show_activity), idempotent on (child, client_turn_id); opens the safeguarding case in the same transaction when the safety decision says so; scrubs e-mails, links and phone numbers a redactor missed.';
comment on function public.tutor_get_turn(uuid, uuid) is
  'service_role only. The stored TutorTurnResult of (child, client_turn_id), or NULL.';
comment on function public.tutor_open_case(uuid, text, text) is
  'service_role only. Opens the safeguarding case of the turn of p_message_id with a redacted excerpt and due_at from safeguarding.sla_hours. Idempotent per turn.';
comment on function public.tutor_log_usage(uuid, jsonb) is
  'service_role only. One ai_usage row per UsageRecord (tutor / moderation), tokens only, cost by the M2 prefix rule (NULL when unpriced). Returns the number of rows.';
comment on function public.tutor_purge_expired() is
  'service_role (and pg_cron). Retention: deletes unflagged messages past tutor.retention_days, flagged ones when their case is resolved plus a 30 day grace, empty sessions, old case excerpts and old daily counters. Returns the counts.';
