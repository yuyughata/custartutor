-- 070 ingest_progress_events: the only write path of progress_events and unit_progress.
--   Per-row validation and authorisation (a poison row never blocks the batch), idempotency on
--   (child_id, client_event_id), server-stamped household, mastery consistency, rate limit, tutor grants,
--   append-only privileges, read isolation, and the derivation of unit_progress (idempotent, commutative,
--   mastery never moves backwards).
begin;
create extension if not exists pgtap with schema extensions;
select plan(57);

-- fixtures (as the table owner) -----------------------------------------------------------------------------
-- gA a1..01 guardian of hA | gB b1..02 guardian of hB | tU c1..03 tutor of hA granted Ada
-- tX c2..04 tutor of hA with NO grant | out d1..05 belongs to no household
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('c2000000-0000-4000-8000-000000000004', 'tx@test.local'),
  ('d1000000-0000-4000-8000-000000000005', 'out@test.local');
insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c2000000-0000-4000-8000-000000000004', 'tutor');
-- Ada ca..01, Bayo ca..02 (rate limit), Dele ca..03 (deleted), Efe ca..04 + Fola ca..05 (derivation), Chidi cb..01 (hB)
insert into public.children (id, household_id, display_alias, level_code, deleted_at) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1', null),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P1', null),
  ('ca000003-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Dele', 'P1', now()),
  ('ca000004-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Efe', 'P1', null),
  ('ca000005-0000-4000-8000-000000000005', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Fola', 'P1', null),
  ('cb000001-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P1', null);
insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');
insert into public.schemes (id, subject_id, level_code, term)
select '5c000000-0000-4000-8000-000000000001', s.id, 'P1', 1 from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4000001-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, kind, title, stage) values
  ('ab000001-0000-4000-8000-000000000001', 'c4000001-0000-4000-8000-000000000001', 1, 'lesson', 'Unit 1', 'absorb'),
  ('ab000002-0000-4000-8000-000000000002', 'c4000001-0000-4000-8000-000000000001', 2, 'lesson', 'Unit 2', 'absorb');

-- helpers (rolled back with the test): an event builder and a one-line summary of a result array
create function public.tev(
  n int, child uuid, unit uuid, type text, payload jsonb default '{}'::jsonb,
  at timestamptz default '2026-10-12 10:00:00+00', seq int default null
) returns jsonb language sql immutable as $$
  select jsonb_build_object(
    'client_event_id', 'e0000000-0000-4000-8000-' || lpad(n::text, 12, '0'),
    'child_id', child, 'device_id', 'dev-1', 'device_seq', coalesce(seq, n), 'unit_id', unit,
    'occurred_at', to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'event_type', type, 'payload', payload);
$$;
create function public.tsum(j jsonb) returns text language sql immutable as $$
  select string_agg((e ->> 'status') || coalesce(':' || (e ->> 'reason'), ''), ',' order by o)
    from jsonb_array_elements(j) with ordinality as t(e, o);
$$;
grant execute on function public.tev(int, uuid, uuid, text, jsonb, timestamptz, int) to public;
grant execute on function public.tsum(jsonb) to public;
create temp table r (k text primary key, v jsonb);
grant all on r to public;

-- guardian A pushes -----------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- all five event types, in one batch; the household field a client might send is ignored
insert into r select 'a1', public.ingest_progress_events(jsonb_build_array(
  public.tev(1, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"household_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}'::jsonb,
  public.tev(2, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s1","junk":123}', '2026-10-12 10:01:00+00'),
  public.tev(3, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"correct","score":1,"attempt":1}', '2026-10-12 10:02:00+00'),
  public.tev(4, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.5,"passed":false,"question_count":4,"version_no":1}', '2026-10-12 10:03:00+00'),
  public.tev(5, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_completed',
             '{}', '2026-10-12 10:04:00+00')
));

select is(
  public.tsum((select v from r where k = 'a1')),
  'accepted,accepted,accepted,accepted,accepted',
  'a batch with all five event types is accepted'
);
select is(
  (select array_agg(e ->> 'client_event_id' order by o)
     from r, jsonb_array_elements(r.v) with ordinality as t(e, o) where k = 'a1'),
  array['e0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000002',
        'e0000000-0000-4000-8000-000000000003', 'e0000000-0000-4000-8000-000000000004',
        'e0000000-0000-4000-8000-000000000005'],
  'results come back in input order and echo each client_event_id'
);

reset role;
select is(
  (select count(*)::int from public.progress_events
    where child_id = 'ca000001-0000-4000-8000-000000000001'
      and household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  5,
  'events are stored with the household looked up from the child (a client-sent household_id is ignored)'
);
select is(
  (select payload from public.progress_events where client_event_id = 'e0000000-0000-4000-8000-000000000002'),
  '{"section_id":"s1"}'::jsonb,
  'unknown payload keys are dropped'
);
select results_eq(
  $$select device_seq, device_id, event_type from public.progress_events
     where client_event_id = 'e0000000-0000-4000-8000-000000000003'$$,
  $$values (3::bigint, 'dev-1', 'question_answered')$$,
  'device_seq, device_id and event_type are stored as sent'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- idempotency: a retry after a lost response, and a replay with a changed payload
insert into r select 'a2', public.ingest_progress_events(jsonb_build_array(
  public.tev(1, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(2, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"CHANGED"}', '2026-10-12 10:01:00+00')
));
select is(
  public.tsum((select v from r where k = 'a2')),
  'duplicate,duplicate',
  'a retried batch (even with a changed payload) is reported as duplicate'
);
reset role;
select is(
  (select count(*)::int from public.progress_events where child_id = 'ca000001-0000-4000-8000-000000000001'),
  5,
  'duplicates insert nothing and the first write wins'
);
select is(
  (select payload ->> 'section_id' from public.progress_events where client_event_id = 'e0000000-0000-4000-8000-000000000002'),
  's1',
  'the stored payload of a replayed event is unchanged'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- a poison row never blocks its neighbours -----------------------------------------------------------------------------
insert into r select 'p1', public.ingest_progress_events(jsonb_build_array(
  public.tev(11, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(12, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'section_completed', '{}'),
  public.tev(13, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
));
select is(
  public.tsum((select v from r where k = 'p1')),
  'accepted,rejected:invalid_payload,accepted',
  'a poison row is rejected on its own; the rows before and after it are accepted'
);

-- payload and shape validation (one call, one reason per row)
insert into r select 'v1', public.ingest_progress_events(jsonb_build_array(
  '"junk"'::jsonb,
  '7'::jsonb,
  '{"client_event_id":"not-a-uuid"}'::jsonb,
  public.tev(21, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started',
             '{}', '1999-12-31 23:59:59+00'),
  public.tev(22, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"occurred_at":"2026-13-45T10:00:00Z"}'::jsonb,
  public.tev(23, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"occurred_at":"2026-10-12 10:00:00"}'::jsonb,
  public.tev(24, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'party_time'),
  public.tev(25, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started',
             '{}', '2026-10-12 10:00:00+00', 0),
  public.tev(26, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"device_seq":1.5}'::jsonb,
  public.tev(27, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"device_id":""}'::jsonb,
  public.tev(28, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || jsonb_build_object('device_id', repeat('d', 129)),
  public.tev(29, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
    || '{"payload":"nope"}'::jsonb,
  public.tev(30, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'section_completed')
    || jsonb_build_object('payload', jsonb_build_object('section_id', repeat('s', 65)))
));
select is(
  public.tsum((select v from r where k = 'v1')),
  'rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,'
  || 'rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,'
  || 'rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,'
  || 'rejected:invalid_payload',
  'junk, bad ids, junk dates, unknown type, bad device_seq/device_id, non-object or oversized payload: all invalid_payload'
);
select is(
  (select (v -> 2 ->> 'client_event_id') from r where k = 'v1'),
  '00000000-0000-0000-0000-000000000000',
  'a row whose client_event_id is unusable echoes the nil uuid so the result array keeps its shape'
);

-- per-type payload checks
insert into r select 'v2', public.ingest_progress_events(jsonb_build_array(
  public.tev(31, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"correct","attempt":1}'),
  public.tev(32, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"maybe","score":null,"attempt":1}'),
  public.tev(33, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"ungraded","score":null,"attempt":0}'),
  public.tev(34, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"ungraded","score":null,"attempt":1}'),
  public.tev(35, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'question_answered',
             '{"question_id":"q1","result":"partial","score":1.2,"attempt":1}'),
  public.tev(36, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":1.5,"passed":true,"question_count":4,"version_no":1}'),
  public.tev(37, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.9,"question_count":4,"version_no":1}'),
  public.tev(38, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.9,"passed":true,"question_count":-1,"version_no":1}'),
  public.tev(39, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.9,"passed":true,"question_count":4,"version_no":0}')
));
select is(
  public.tsum((select v from r where k = 'v2')),
  'rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,accepted,rejected:invalid_payload,'
  || 'rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload,rejected:invalid_payload',
  'question_answered needs score (number or null), a known result and attempt >= 1; mastery needs score 0..1, boolean passed, question_count >= 0, version_no >= 1'
);

-- authorisation, unit existence, deleted child
insert into r select 'x1', public.ingest_progress_events(jsonb_build_array(
  public.tev(41, 'cb000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(42, 'cc000000-0000-4000-8000-000000000099', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(43, 'ca000003-0000-4000-8000-000000000003', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(44, 'ca000001-0000-4000-8000-000000000001', 'ab0000ff-0000-4000-8000-0000000000ff', 'unit_started'),
  public.tev(45, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'unit_started')
));
select is(
  public.tsum((select v from r where k = 'x1')),
  'rejected:no_access_to_child,rejected:no_access_to_child,rejected:child_deleted,rejected:unknown_unit,accepted',
  'another household''s child and a child that does not exist look the same; a deleted child and an unknown unit have their own reasons'
);

-- mastery consistency: passed <=> score >= 0.8 and at least one question
insert into r select 'm1', public.ingest_progress_events(jsonb_build_array(
  public.tev(51, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'mastery_check_completed',
             '{"score":0.79,"passed":true,"question_count":4,"version_no":1}'),
  public.tev(52, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'mastery_check_completed',
             '{"score":0.8,"passed":false,"question_count":4,"version_no":1}'),
  public.tev(53, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'mastery_check_completed',
             '{"score":1,"passed":true,"question_count":0,"version_no":1}'),
  public.tev(54, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'mastery_check_completed',
             '{"score":0,"passed":false,"question_count":0,"version_no":1}'),
  public.tev(55, 'ca000001-0000-4000-8000-000000000001', 'ab000002-0000-4000-8000-000000000002', 'mastery_check_completed',
             '{"score":0.8,"passed":true,"question_count":5,"version_no":1}')
));
select is(
  public.tsum((select v from r where k = 'm1')),
  'rejected:inconsistent_mastery,rejected:inconsistent_mastery,rejected:inconsistent_mastery,accepted,accepted',
  'the server rejects a passed flag that disagrees with score >= 0.8 or a pass with no question'
);
select is(
  (select status from public.unit_progress
    where child_id = 'ca000001-0000-4000-8000-000000000001' and unit_id = 'ab000002-0000-4000-8000-000000000002'),
  'mastered',
  'only a consistent passing check made the unit mastered'
);

-- whole-call errors --------------------------------------------------------------------------------------------------
select throws_ok($$select public.ingest_progress_events('{"a":1}'::jsonb)$$, '22023', 'invalid_events',
  'a non-array argument is a clean error');
select throws_ok($$select public.ingest_progress_events(null)$$, '22023', 'invalid_events',
  'a null argument is a clean error');
select throws_ok(
  $$select public.ingest_progress_events((select jsonb_agg(public.tev(1000 + g,
      'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'))
      from generate_series(1, 101) g))$$,
  '22023', 'batch_too_large', 'more than 100 events is a clean error');
select is(
  public.tsum(public.ingest_progress_events((select jsonb_agg(public.tev(1200 + g,
      'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'))
      from generate_series(1, 100) g))) = (select string_agg('accepted', ',') from generate_series(1, 100)),
  true,
  'exactly 100 events are accepted in one batch'
);
select is(public.ingest_progress_events('[]'::jsonb), '[]'::jsonb, 'an empty batch returns an empty array');

-- rate limit: more than 2000 events per child per hour --------------------------------------------------------------------
reset role;
insert into public.progress_events
  (household_id, child_id, client_event_id, device_id, device_seq, unit_id, event_type, payload, occurred_at)
select 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ca000002-0000-4000-8000-000000000002',
       ('f0000000-0000-4000-8000-' || lpad(g::text, 12, '0'))::uuid, 'bulk', g,
       'ab000001-0000-4000-8000-000000000001', 'unit_started', '{}', '2026-10-12 09:00:00+00'
  from generate_series(1, 2000) g;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
insert into r select 'rl', public.ingest_progress_events(jsonb_build_array(
  public.tev(61, 'ca000002-0000-4000-8000-000000000002', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  jsonb_build_object('client_event_id', 'f0000000-0000-4000-8000-000000000001',
    'child_id', 'ca000002-0000-4000-8000-000000000002', 'device_id', 'bulk', 'device_seq', 1,
    'unit_id', 'ab000001-0000-4000-8000-000000000001', 'occurred_at', '2026-10-12T09:00:00Z',
    'event_type', 'unit_started', 'payload', '{}'::jsonb),
  public.tev(62, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
));
select is(
  public.tsum((select v from r where k = 'rl')),
  'rejected:rate_limited,duplicate,accepted',
  'the 2001st event of a child within an hour is rate limited, a retry of a stored event is still a duplicate, other children are unaffected'
);

-- tutors ------------------------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
insert into r select 't1', public.ingest_progress_events(jsonb_build_array(
  public.tev(71, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started'),
  public.tev(72, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'unit_started')
));
select is(
  public.tsum((select v from r where k = 't1')),
  'accepted,rejected:no_access_to_child',
  'a tutor can push for the child they were granted, not for another child of the household'
);
set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}';
select is(
  public.tsum(public.ingest_progress_events(jsonb_build_array(
    public.tev(73, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')))),
  'rejected:no_access_to_child',
  'a tutor of the household without a grant for the child cannot push'
);
set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is(
  public.tsum(public.ingest_progress_events(jsonb_build_array(
    public.tev(74, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')))),
  'rejected:no_access_to_child',
  'a guardian of another household cannot push for the child'
);
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is(
  public.tsum(public.ingest_progress_events(jsonb_build_array(
    public.tev(75, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')))),
  'rejected:no_access_to_child',
  'a user without a household cannot push'
);
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
reset role;
update public.child_access set revoked_at = now(), deleted_at = now()
 where tutor_user_id = 'c1000000-0000-4000-8000-000000000003';
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select is(
  public.tsum(public.ingest_progress_events(jsonb_build_array(
    public.tev(76, 'ca000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'unit_started')))),
  'rejected:no_access_to_child',
  'a tutor whose grant was revoked can no longer push'
);
reset role;
select is(
  (select count(*)::int from public.progress_events where client_event_id in (
    'e0000000-0000-4000-8000-000000000072', 'e0000000-0000-4000-8000-000000000073',
    'e0000000-0000-4000-8000-000000000074', 'e0000000-0000-4000-8000-000000000075',
    'e0000000-0000-4000-8000-000000000076')),
  0,
  'rejected events leave no row behind'
);
set local role authenticated;
set local request.jwt.claims = '{}';
select throws_ok(
  $$select public.ingest_progress_events('[]'::jsonb)$$,
  '42501', 'not_authenticated', 'a call without a session is refused'
);

-- derivation: Efe, a shuffled and duplicated history ------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
-- sections pushed newest-first
insert into r select 'd1', public.ingest_progress_events(jsonb_build_array(
  public.tev(81, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_b"}', '2026-10-12 10:05:00+00'),
  public.tev(82, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_a"}', '2026-10-12 10:01:00+00')
));
select results_eq(
  $$select status, mastery_score, attempts, last_section, updated_at
      from public.unit_progress
     where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values ('in_progress', null::numeric, 0, 's_b', '2026-10-12 10:05:00+00'::timestamptz)$$,
  'sections only: in_progress, no score, no attempts; last_section is the NEWEST occurred_at whatever the arrival order'
);
-- a tie on occurred_at is broken by the greater client_event_id
insert into r select 'd2', public.ingest_progress_events(jsonb_build_array(
  public.tev(83, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_c"}', '2026-10-12 10:05:00+00')
));
select is(
  (select last_section from public.unit_progress
    where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'),
  's_c',
  'ties on occurred_at are broken by the greater client_event_id'
);
insert into r select 'd3', public.ingest_progress_events(jsonb_build_array(
  public.tev(84, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.5,"passed":false,"question_count":4,"version_no":1}', '2026-10-12 10:10:00+00')
));
select results_eq(
  $$select status, mastery_score, attempts from public.unit_progress
     where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values ('in_progress', 0.5000::numeric, 1)$$,
  'a failed check counts as an attempt and sets the best score; the unit stays in_progress'
);
insert into r select 'd4', public.ingest_progress_events(jsonb_build_array(
  public.tev(85, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.85,"passed":true,"question_count":4,"version_no":1}', '2026-10-12 10:20:00+00')
));
select results_eq(
  $$select status, mastery_score, attempts, updated_at from public.unit_progress
     where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values ('mastered', 0.8500::numeric, 2, '2026-10-12 10:20:00+00'::timestamptz)$$,
  'a passing check makes the unit mastered with the best score'
);
-- mastery never moves backwards
insert into r select 'd5', public.ingest_progress_events(jsonb_build_array(
  public.tev(86, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.2,"passed":false,"question_count":4,"version_no":2}', '2026-10-12 10:30:00+00')
));
select results_eq(
  $$select status, mastery_score, attempts, updated_at from public.unit_progress
     where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values ('mastered', 0.8500::numeric, 3, '2026-10-12 10:30:00+00'::timestamptz)$$,
  'a later failing attempt never un-masters the unit and never lowers the best score'
);
reset role;
create temp table seq0 as
  select sync_seq from public.unit_progress
   where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001';
grant all on seq0 to public;
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
-- a late-arriving OLD event, and a replay of a stored one, change nothing
insert into r select 'd6', public.ingest_progress_events(jsonb_build_array(
  public.tev(87, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'unit_started',
             '{}', '2026-10-12 09:00:00+00'),
  public.tev(85, 'ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.85,"passed":true,"question_count":4,"version_no":1}', '2026-10-12 10:20:00+00')
));
select is(
  public.tsum((select v from r where k = 'd6')), 'accepted,duplicate',
  'an old event arriving late is accepted, a replay is a duplicate'
);
reset role;
select results_eq(
  $$select status, mastery_score, attempts, last_section, updated_at, sync_seq = (select sync_seq from seq0)
      from public.unit_progress
     where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values ('mastered', 0.8500::numeric, 3, 's_c', '2026-10-12 10:30:00+00'::timestamptz, true)$$,
  'late and duplicate events do not change the derived row, and do not churn its sync_seq'
);
select lives_ok(
  $$select private.derive_unit_progress('ca000004-0000-4000-8000-000000000004', 'ab000001-0000-4000-8000-000000000001')$$,
  'derive_unit_progress can be re-run at any time'
);
select is(
  (select sync_seq = (select sync_seq from seq0) from public.unit_progress
    where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'),
  true,
  'a re-derivation that changes nothing leaves sync_seq alone (idempotent)'
);
select is(
  (select household_id from public.unit_progress
    where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'),
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'::uuid,
  'unit_progress carries the household of the child'
);

-- order independence: Fola gets Efe's whole history in REVERSE order in a single batch
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
insert into r select 'f1', public.ingest_progress_events(jsonb_build_array(
  public.tev(87, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'unit_started',
             '{}', '2026-10-12 09:00:00+00'),
  public.tev(86, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.2,"passed":false,"question_count":4,"version_no":2}', '2026-10-12 10:30:00+00'),
  public.tev(85, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.85,"passed":true,"question_count":4,"version_no":1}', '2026-10-12 10:20:00+00'),
  public.tev(84, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'mastery_check_completed',
             '{"score":0.5,"passed":false,"question_count":4,"version_no":1}', '2026-10-12 10:10:00+00'),
  public.tev(83, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_c"}', '2026-10-12 10:05:00+00'),
  public.tev(82, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_a"}', '2026-10-12 10:01:00+00'),
  public.tev(81, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_b"}', '2026-10-12 10:05:00+00'),
  public.tev(81, 'ca000005-0000-4000-8000-000000000005', 'ab000001-0000-4000-8000-000000000001', 'section_completed',
             '{"section_id":"s_b"}', '2026-10-12 10:05:00+00')
));
select is(
  public.tsum((select v from r where k = 'f1')),
  'accepted,accepted,accepted,accepted,accepted,accepted,accepted,duplicate',
  'the same ids may be used by a different child; a duplicate inside one batch is reported as duplicate'
);
reset role;
select is(
  (select count(*)::int from (
     select status, mastery_score, attempts, last_section, updated_at from public.unit_progress
      where child_id = 'ca000004-0000-4000-8000-000000000004' and unit_id = 'ab000001-0000-4000-8000-000000000001'
     intersect
     select status, mastery_score, attempts, last_section, updated_at from public.unit_progress
      where child_id = 'ca000005-0000-4000-8000-000000000005' and unit_id = 'ab000001-0000-4000-8000-000000000001'
   ) same),
  1,
  'the derived row is the same whatever the arrival order of the events (commutative)'
);

-- append-only and no client writes -------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into public.progress_events (household_id, child_id, client_event_id, device_id, device_seq, unit_id, event_type, occurred_at)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'ca000001-0000-4000-8000-000000000001', gen_random_uuid(), 'd', 1,
            'ab000001-0000-4000-8000-000000000001', 'unit_started', now())$$,
  '42501', null, 'a guardian cannot insert progress_events directly'
);
select throws_ok(
  $$update public.progress_events set payload = '{}'::jsonb where child_id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', null, 'a guardian cannot update progress_events'
);
select throws_ok(
  $$delete from public.progress_events where child_id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', null, 'a guardian cannot delete progress_events'
);
select throws_ok(
  $$update public.unit_progress set status = 'mastered' where child_id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', null, 'a guardian cannot write unit_progress (mastery is derived, never client-set)'
);
select throws_ok(
  $$insert into public.unit_progress (child_id, unit_id, household_id, status, updated_at)
    values ('ca000002-0000-4000-8000-000000000002', 'ab000001-0000-4000-8000-000000000001',
            'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'mastered', now())$$,
  '42501', null, 'a guardian cannot insert unit_progress'
);
reset role;
set local role service_role;
select throws_ok(
  $$update public.progress_events set payload = '{}'::jsonb$$,
  '42501', null, 'even the service role cannot update progress_events'
);
select throws_ok(
  $$delete from public.progress_events$$,
  '42501', null, 'even the service role cannot delete progress_events'
);
select throws_ok(
  $$truncate public.progress_events$$,
  '42501', null, 'even the service role cannot truncate progress_events'
);
reset role;

-- read isolation (RLS through can_access_child) -------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select count(distinct child_id)::int from public.progress_events),
  4,
  'guardian A reads the events of the four children of household A that have any (Ada, Bayo, Efe, Fola), nothing else'
);
select is(
  (select count(*)::int from public.unit_progress where household_id <> 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  0,
  'guardian A reads no progress of another household'
);
set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is(
  (select (select count(*) from public.progress_events) + (select count(*) from public.unit_progress))::int,
  0,
  'guardian B sees no event and no progress of household A'
);
set local request.jwt.claims = '{"sub":"c2000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal1"}';
select is(
  (select (select count(*) from public.progress_events) + (select count(*) from public.unit_progress))::int,
  0,
  'a tutor without a grant sees no event and no progress'
);
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is(
  (select (select count(*) from public.progress_events) + (select count(*) from public.unit_progress))::int,
  0,
  'a user outside every household sees no event and no progress'
);
reset role;
-- tU's grant was revoked above; grant again to test a tutor''s reads
insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000004-0000-4000-8000-000000000004', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select distinct child_id from public.progress_events$$,
  $$values ('ca000004-0000-4000-8000-000000000004'::uuid)$$,
  'a tutor reads the events of the granted child only'
);
select results_eq(
  $$select distinct child_id from public.unit_progress$$,
  $$values ('ca000004-0000-4000-8000-000000000004'::uuid)$$,
  'a tutor reads the progress of the granted child only'
);
reset role;
set local role anon;
select throws_ok($$select * from public.progress_events$$, '42501', null, 'anon cannot read progress_events');
select throws_ok($$select public.ingest_progress_events('[]'::jsonb)$$, '42501', null, 'anon cannot ingest');
reset role;

select * from finish();
rollback;
