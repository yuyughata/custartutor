-- 093 M3 tutor, the safeguarding queue: list_safeguarding_cases / get_safeguarding_case / update_safeguarding_case.
--   * only `safeguarding` and `super_admin` at aal2; content_editor, reviewer, support, analyst, guardians and anon are refused
--   * EVERY successful list / get / update writes an audit row; a refused call writes none
--   * a reviewer sees the alias and the REDACTED excerpt, never an e-mail
--   * the status machine open -> in_review -> resolved (forward only), a decision only at resolution
--   * only the decision `release` lets the guardian read the held turns (checked end to end with get_tutor_transcript)
begin;
create extension if not exists pgtap with schema extensions;
select plan(90);

-- sa e9b..01 super_admin | sg ..02 safeguarding | ed ..03 content_editor | rv ..04 reviewer | sup ..05 support | ana ..06 analyst
-- ga e9a..01 guardian (secret e-mail) | pl ..04 plain user
insert into auth.users (id, email) values
  ('e9b00000-0000-4000-8000-000000000001', 'm3sa@test.local'),
  ('e9b00000-0000-4000-8000-000000000002', 'm3sg@test.local'),
  ('e9b00000-0000-4000-8000-000000000003', 'm3ed@test.local'),
  ('e9b00000-0000-4000-8000-000000000004', 'm3rv@test.local'),
  ('e9b00000-0000-4000-8000-000000000005', 'm3sup@test.local'),
  ('e9b00000-0000-4000-8000-000000000006', 'm3ana@test.local'),
  ('e9a00000-0000-4000-8000-000000000001', 'guardian.secret.address@test.local'),
  ('e9a00000-0000-4000-8000-000000000004', 'm3pl@test.local');
insert into public.admin_users (user_id, role) values
  ('e9b00000-0000-4000-8000-000000000001', 'super_admin'),
  ('e9b00000-0000-4000-8000-000000000002', 'safeguarding'),
  ('e9b00000-0000-4000-8000-000000000003', 'content_editor'),
  ('e9b00000-0000-4000-8000-000000000004', 'reviewer'),
  ('e9b00000-0000-4000-8000-000000000005', 'support'),
  ('e9b00000-0000-4000-8000-000000000006', 'analyst');
insert into public.households (id, name, created_by) values
  ('e9c00000-0000-4000-8000-00000000000a', 'Household A', 'e9a00000-0000-4000-8000-000000000001');
insert into public.household_members (household_id, user_id, role) values
  ('e9c00000-0000-4000-8000-00000000000a', 'e9a00000-0000-4000-8000-000000000001', 'guardian');
insert into public.children (id, household_id, display_alias, level_code) values
  ('e9d00000-0000-4000-8000-000000000001', 'e9c00000-0000-4000-8000-00000000000a', 'Ada', 'P1');
with d as (delete from public.app_settings returning 1) select count(*) from d;
with d as (delete from public.audit_log returning 1) select count(*) from d;
insert into public.schemes (id, subject_id, level_code, term, status)
select '5c900000-0000-4000-8000-000000000001', s.id, 'P1', 1, 'approved' from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4900000-0000-4000-8000-000000000001', '5c900000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, week_no, kind, title, objective, stage) values
  ('ab900000-0000-4000-8000-000000000001', 'c4900000-0000-4000-8000-000000000001', 1, 1, 'lesson', 'Unit 1', 'Objective 1', 'absorb');
insert into public.grownup_elevations (user_id, device_id, expires_at)
values ('e9a00000-0000-4000-8000-000000000001', 'dev-ga', now() + interval '10 minutes');

create temp table res (label text primary key, r jsonb);
grant all on res to public;
create function public.t_save(
  p_child uuid, p_session uuid, p_turn uuid, p_text text, p_reply text, p_status text, p_safety jsonb
)
returns jsonb language sql security invoker set search_path = ''
as $$ select public.tutor_save_turn(p_child, p_session, p_turn, null, 'text', p_text, 0, p_reply, p_status, p_safety, null, null,
                                    'claude-sonnet-5-5', 'm3-v1', false); $$;
grant execute on function public.t_save(uuid, uuid, uuid, text, text, text, jsonb) to service_role;

-- a conversation of Ada: a benign turn, then self-harm (high), distress (medium) and a blocked turn (low)
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
insert into res values ('s', public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', null, 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000001', 10));
select public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000001', 'hello', 'Hi Ada', 'complete',
  '{"action":"allow","categories":[],"open_case":false,"withhold_from_guardian":false}'::jsonb);
select public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000002', 10);
insert into res values ('c_sh', public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000002', 'SECRET-HARM my number is 08031234567', 'SECRET-SAFE-REPLY', 'safe_reply',
  '{"action":"safe_reply","reply_key":"self_harm","categories":[{"category":"self_harm","severity":"high"}],"open_case":true,"case_severity":"high","withhold_from_guardian":true,"from_patterns":true}'::jsonb));
select public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000003', 10);
insert into res values ('c_di', public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000003', 'SECRET-DISTRESS', 'SECRET-DISTRESS-REPLY', 'safe_reply',
  '{"action":"safe_reply","reply_key":"distress","categories":[{"category":"distress","severity":"high"}],"open_case":true,"case_severity":"medium","withhold_from_guardian":true,"from_patterns":false}'::jsonb));
select public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000004', 10);
insert into res values ('c_bl', public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000004', 'BLOCKED-TEXT', 'That is not something I can talk about', 'blocked',
  '{"action":"blocked","reply_key":"blocked","categories":[{"category":"violence","severity":"high"}],"open_case":true,"case_severity":"low","withhold_from_guardian":false,"from_patterns":false}'::jsonb));
reset role;
select is((select count(*)::int from public.safeguarding_cases), 3, 'fixture: three cases (high, medium, low)');
-- the audit trail starts empty for the queue
with d as (delete from public.audit_log returning 1) select count(*) from d;

-- A. who is refused -------------------------------------------------------------------------------------------------------------------------------
create temp table calls (n int primary key, label text, sql text);
grant all on calls to public;
insert into calls values
  (1, 'list', $$select public.list_safeguarding_cases()$$),
  (2, 'get', $$select public.get_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'))$$),
  (3, 'update', $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, null)$$);

set local role anon;
select throws_ok(c.sql, '42501', null, 'anon cannot ' || c.label) from calls c order by c.n;
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'not_authenticated', 'a JWT without a user cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'a content_editor cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'a reviewer cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'support cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'an analyst cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9a00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'a guardian (even with an elevation and aal2) cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'a safeguarding user at aal1 cannot ' || c.label) from calls c order by c.n;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(c.sql, '42501', 'admin_role_required', 'a super_admin at aal1 cannot ' || c.label) from calls c order by c.n;
reset role;
select is((select count(*)::int from public.audit_log), 0, 'none of the refused calls wrote an audit row');
select is(
  (select status from public.safeguarding_cases where id = (select (r ->> 'case_id')::uuid from res where label = 'c_sh')), 'open',
  'and none changed a case'
);

-- B. the queue ------------------------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.list_safeguarding_cases('nonsense')$$, '22023', 'invalid_status', 'an unknown status filter is refused');
select throws_ok($$select public.list_safeguarding_cases(null, 0)$$, '22023', 'invalid_limit', 'a limit of 0 is refused');
select throws_ok($$select public.list_safeguarding_cases(null, 201)$$, '22023', 'invalid_limit', 'and one above 200');
select results_eq(
  $$select c ->> 'category', c ->> 'severity', c ->> 'status', c ->> 'child_alias', c ->> 'level_code', (c ->> 'overdue')::boolean
      from jsonb_array_elements(public.list_safeguarding_cases()) c$$,
  $$values ('self_harm', 'high', 'open', 'Ada', 'P1', false), ('distress', 'medium', 'open', 'Ada', 'P1', false), ('violence', 'low', 'open', 'Ada', 'P1', false)$$,
  'a safeguarding user lists the queue: the most urgent first, with the alias and level'
);
select is(
  (select array_agg(k order by k) from jsonb_object_keys((select public.list_safeguarding_cases() -> 0)) k),
  array['assigned_to', 'category', 'child_alias', 'created_at', 'decision', 'due_at', 'id', 'level_code', 'overdue', 'severity', 'status']::text[],
  'the list items carry exactly these fields (no excerpt, no ids of the household or the child)'
);
select is((select jsonb_array_length(public.list_safeguarding_cases('open'))), 3, 'filter open: three');
select is((select jsonb_array_length(public.list_safeguarding_cases('resolved'))), 0, 'filter resolved: none yet');
select is((select jsonb_array_length(public.list_safeguarding_cases(null, 2))), 2, 'the limit is applied');
reset role;
select results_eq(
  $$select action, entity, actor::text, detail ->> 'status', (detail ->> 'count')::int from public.audit_log order by id$$,
  $$values ('safeguarding_queue_read', 'safeguarding_cases', 'e9b00000-0000-4000-8000-000000000002', null, 3),
           ('safeguarding_queue_read', 'safeguarding_cases', 'e9b00000-0000-4000-8000-000000000002', null, 3),
           ('safeguarding_queue_read', 'safeguarding_cases', 'e9b00000-0000-4000-8000-000000000002', 'open', 3),
           ('safeguarding_queue_read', 'safeguarding_cases', 'e9b00000-0000-4000-8000-000000000002', 'resolved', 0),
           ('safeguarding_queue_read', 'safeguarding_cases', 'e9b00000-0000-4000-8000-000000000002', null, 2)$$,
  'every successful list wrote an audit row (who, which filter, how many); the refused ones wrote none'
);

-- C. one case -------------------------------------------------------------------------------------------------------------------------------------------------
with d as (delete from public.audit_log returning 1) select count(*) from d;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
insert into res values ('g1', public.get_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh')));
select is(
  (select array_agg(k order by k) from jsonb_object_keys((select r from res where label = 'g1')) k),
  array['assigned_to', 'category', 'child_alias', 'child_id', 'created_at', 'decision', 'due_at', 'excerpt', 'excerpt_cleared_at',
        'household_id', 'id', 'in_review_at', 'level_code', 'notes', 'overdue', 'released_at', 'resolved_at', 'session_id',
        'severity', 'status', 'unit_id']::text[],
  'a case has exactly these fields'
);
select results_eq(
  $$select r ->> 'category', r ->> 'severity', r ->> 'status', r ->> 'child_alias', r ->> 'level_code', r ->> 'assigned_to' is null,
           r ->> 'unit_id', jsonb_array_length(r -> 'excerpt') from res where label = 'g1'$$,
  $$values ('self_harm', 'high', 'open', 'Ada', 'P1', true, 'ab900000-0000-4000-8000-000000000001', 4)$$,
  'the case: category, severity, status, the child''s alias and level, the unit, an excerpt of the four messages so far'
);
select results_eq(
  $$select e ->> 'role', e ->> 'text' from jsonb_array_elements((select r -> 'excerpt' from res where label = 'g1')) e
     where e ->> 'text' like 'SECRET%' order by e ->> 'role' desc$$,
  $$values ('tutor', 'SECRET-SAFE-REPLY'), ('child', 'SECRET-HARM my number is [phone]')$$,
  'the excerpt holds the REDACTED text (the phone number the redactor missed was scrubbed before it was stored)'
);
select is(
  (select position('@' in (select r::text from res where label = 'g1')) = 0
      and position('guardian.secret' in (select r::text from res where label = 'g1')) = 0
      and position('08031234567' in (select r::text from res where label = 'g1')) = 0),
  true,
  'no e-mail address, no guardian name and no phone number anywhere in the case'
);
select throws_ok($$select public.get_safeguarding_case(gen_random_uuid())$$, 'P0002', 'case_not_found', 'an unknown case');
select lives_ok($$select public.get_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'))$$, 'reading the case again');
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.get_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_di'))$$, 'a super_admin at aal2 can read a case');
reset role;
select results_eq(
  $$select action, entity, entity_id, actor::text, detail ->> 'category' from public.audit_log order by id$$,
  $$values ('safeguarding_case_read', 'safeguarding_cases', (select (r ->> 'case_id') from res where label = 'c_sh'), 'e9b00000-0000-4000-8000-000000000002', 'self_harm'),
           ('safeguarding_case_read', 'safeguarding_cases', (select (r ->> 'case_id') from res where label = 'c_sh'), 'e9b00000-0000-4000-8000-000000000002', 'self_harm'),
           ('safeguarding_case_read', 'safeguarding_cases', (select (r ->> 'case_id') from res where label = 'c_di'), 'e9b00000-0000-4000-8000-000000000001', 'distress')$$,
  'EVERY successful read of a case wrote an audit row, the repeat included; the unknown case wrote none'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.audit_log), 0, 'a safeguarding user cannot read the audit log');
select throws_ok($$select * from public.safeguarding_cases$$, '42501', null, 'nor the table of cases directly');
select throws_ok($$select * from public.tutor_messages$$, '42501', null, 'nor the messages');
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select ok((select count(*) from public.audit_log where action like 'safeguarding%') >= 3, 'a super_admin at aal2 reads the audit rows');
reset role;

-- D. the status machine ----------------------------------------------------------------------------------------------------------------------------------------
with d as (delete from public.audit_log returning 1) select count(*) from d;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(c.sql, '22023', c.msg, c.label)
from (values
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'open', null, null)$$, 'invalid_status', 'a case cannot be moved back to open'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'bogus', null, null)$$, 'invalid_status', 'an unknown status'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), null, null, null)$$, 'invalid_status', 'a null status'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'resolved', 'bogus', null)$$, 'invalid_decision', 'an unknown decision'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', 'release', null)$$, 'invalid_decision', 'a decision while taking the case (decisions come with the resolution)'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, repeat('a', 2001))$$, 'invalid_notes', 'notes above 2000 characters'),
  ($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'resolved', 'release', null)$$, 'illegal_status_move', 'an open case cannot be resolved without being taken first')
) as c(sql, msg, label);
select throws_ok($$select public.update_safeguarding_case(gen_random_uuid(), 'in_review', null, null)$$, 'P0002', 'case_not_found', 'an unknown case');
reset role;
select is((select count(*)::int from public.audit_log), 0, 'the refused updates wrote no audit row');
select results_eq(
  $$select status, decision, released_at is null from public.safeguarding_cases where id = (select (r ->> 'case_id')::uuid from res where label = 'c_sh')$$,
  $$values ('open', null::text, true)$$,
  'and changed nothing'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'status', r ->> 'assigned_to', r ->> 'in_review_at' is not null, r ->> 'decision', r ->> 'resolved_at'
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, 'Looking into it') as r) x$$,
  $$values ('in_review', 'e9b00000-0000-4000-8000-000000000002', true, null::text, null::text)$$,
  'taking a case: in_review, assigned to the caller, the time recorded'
);
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'status', r ->> 'assigned_to', r ->> 'notes'
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, 'Second note by the super_admin') as r) x$$,
  $$values ('in_review', 'e9b00000-0000-4000-8000-000000000002', 'Second note by the super_admin')$$,
  'saving notes keeps the assignee and replaces the notes'
);
select is(
  (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, '   ') ->> 'notes'),
  'Second note by the super_admin',
  'blank notes leave the notes as they are'
);
select throws_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'resolved', null, null)$$,
  '22023', 'decision_required', 'resolving needs a decision'
);
select results_eq(
  $$select r ->> 'status', r ->> 'decision', r ->> 'resolved_at' is not null, r ->> 'released_at'
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'resolved', 'keep_withheld', null) as r) x$$,
  $$values ('resolved', 'keep_withheld', true, null::text)$$,
  'resolving with keep_withheld: resolved, decision recorded, nothing released'
);
select throws_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'resolved', 'release', null)$$,
  '22023', 'illegal_status_move', 'a resolved case cannot be decided again (the decision cannot be flipped to release later)'
);
select throws_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_sh'), 'in_review', null, null)$$,
  '22023', 'illegal_status_move', 'nor reopened'
);
reset role;
select results_eq(
  $$select action, entity_id = (select (r ->> 'case_id') from res where label = 'c_sh'), actor::text, detail ->> 'from', detail ->> 'to', detail ->> 'decision', (detail ->> 'notes_length')::int
      from public.audit_log where action = 'safeguarding_case_updated' order by id$$,
  $$values ('safeguarding_case_updated', true, 'e9b00000-0000-4000-8000-000000000002', 'open', 'in_review', null, 15),
           ('safeguarding_case_updated', true, 'e9b00000-0000-4000-8000-000000000001', 'in_review', 'in_review', null, 30),
           ('safeguarding_case_updated', true, 'e9b00000-0000-4000-8000-000000000001', 'in_review', 'in_review', null, 0),
           ('safeguarding_case_updated', true, 'e9b00000-0000-4000-8000-000000000001', 'in_review', 'resolved', 'keep_withheld', 0)$$,
  'every change is audited (who, from, to, the decision, the length of the notes); the notes themselves are not copied into the audit log'
);

-- E. what the guardian sees ------------------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9a00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from jsonb_array_elements(public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))) m where (m ->> 'withheld')::boolean),
  4,
  'before any release: the self-harm turn and the distress turn (four messages) are withheld; the blocked violence turn and the benign one are readable'
);
select is(
  position('SECRET' in public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))::text), 0,
  'and none of the secrets is in the transcript'
);
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_di'), 'in_review', null, null)$$,
  'taking the distress case'
);
select results_eq(
  $$select r ->> 'status', r ->> 'decision', r ->> 'released_at' is not null
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_di'), 'resolved', 'contact_guardian', 'Agreed message sent by the owner') as r) x$$,
  $$values ('resolved', 'contact_guardian', false)$$,
  'contact_guardian resolves the case without releasing the turn'
);
set local request.jwt.claims = '{"sub":"e9a00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from jsonb_array_elements(public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))) m where (m ->> 'withheld')::boolean),
  4,
  'the distress turn is still withheld after contact_guardian'
);
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_bl'), 'in_review', null, null)$$,
  'a super_admin takes the blocked case'
);
select results_eq(
  $$select r ->> 'status', r ->> 'decision', r ->> 'released_at' is not null
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_bl'), 'resolved', 'no_action', null) as r) x$$,
  $$values ('resolved', 'no_action', false)$$,
  'no_action resolves without releasing'
);
reset role;
-- a second distress-like case to release: reopen is impossible, so create one more flagged turn
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000005', 10);
insert into res values ('c_fa', public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000005', 'SECRET-FALSE-ALARM', 'SECRET-FALSE-ALARM-REPLY', 'safe_reply',
  '{"action":"safe_reply","reply_key":"distress","categories":[{"category":"distress","severity":"medium"}],"open_case":true,"case_severity":"medium","withhold_from_guardian":true,"from_patterns":false}'::jsonb));
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9a00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select (s ->> 'has_withheld')::boolean from jsonb_array_elements(public.list_tutor_sessions('e9d00000-0000-4000-8000-000000000001', 5)) s),
  true,
  'the guardian''s session list says something is withheld'
);
select is(
  (select count(*)::int from jsonb_array_elements(public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))) m where (m ->> 'withheld')::boolean),
  6,
  'six messages are withheld now (self-harm, distress, false alarm)'
);
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_fa'), 'in_review', null, null)$$,
  'a reviewer takes the false alarm'
);
select results_eq(
  $$select r ->> 'status', r ->> 'decision', r ->> 'released_at' is not null
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_fa'), 'resolved', 'release', 'False alarm: a story the child was telling') as r) x$$,
  $$values ('resolved', 'release', true)$$,
  'release: resolved with the decision, released_at set'
);
set local request.jwt.claims = '{"sub":"e9a00000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from jsonb_array_elements(public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))) m where (m ->> 'withheld')::boolean),
  4,
  'after the release the guardian sees the false alarm turn: only the self-harm and distress turns stay withheld'
);
select results_eq(
  $$select m ->> 'text' from jsonb_array_elements(public.get_tutor_transcript((select (r ->> 'session_id')::uuid from res where label = 's'))) m
     where m ->> 'text' like 'SECRET%' order by (m ->> 'created_at')::timestamptz, m ->> 'role'$$,
  $$values ('SECRET-FALSE-ALARM'), ('SECRET-FALSE-ALARM-REPLY')$$,
  'exactly the released turn''s text is readable, and nothing else of the secrets'
);
select is(
  (select (s ->> 'has_withheld')::boolean from jsonb_array_elements(public.list_tutor_sessions('e9d00000-0000-4000-8000-000000000001', 5)) s),
  true,
  'the session still reports the turns that stay withheld'
);
reset role;
select results_eq(
  $$select status, decision, released_at is not null, assigned_to::text from public.safeguarding_cases order by due_at, decision$$,
  $$values ('resolved', 'keep_withheld', false, 'e9b00000-0000-4000-8000-000000000002'),
           ('resolved', 'contact_guardian', false, 'e9b00000-0000-4000-8000-000000000002'),
           ('resolved', 'release', true, 'e9b00000-0000-4000-8000-000000000002'),
           ('resolved', 'no_action', false, 'e9b00000-0000-4000-8000-000000000001')$$,
  'the four cases as the queue left them: only the false alarm was released'
);
-- escalated is a decision too
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select public.tutor_open_session('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'ab900000-0000-4000-8000-000000000001', 1, 'e9f00000-0000-4000-8000-000000000006', 10);
insert into res values ('c_es', public.t_save('e9d00000-0000-4000-8000-000000000001', (select (r ->> 'session_id')::uuid from res where label = 's'), 'e9f00000-0000-4000-8000-000000000006', 'SECRET-ESCALATE', 'SECRET-ESCALATE-REPLY', 'safe_reply',
  '{"action":"safe_reply","reply_key":"abuse","categories":[{"category":"abuse_disclosure","severity":"high"}],"open_case":true,"case_severity":"high","withhold_from_guardian":true,"from_patterns":true}'::jsonb));
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e9b00000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_es'), 'in_review', null, null)$$, 'taking the abuse case');
select results_eq(
  $$select r ->> 'status', r ->> 'decision', r ->> 'released_at' is not null
      from (select public.update_safeguarding_case((select (r ->> 'case_id')::uuid from res where label = 'c_es'), 'resolved', 'escalated', 'Passed to the agency by the owner') as r) x$$,
  $$values ('resolved', 'escalated', false)$$,
  'escalated is recorded and releases nothing'
);
select is(
  (select jsonb_array_length(public.list_safeguarding_cases('resolved', 100))), 5,
  'five resolved cases in the queue'
);
select is(
  (select jsonb_array_length(public.list_safeguarding_cases('open'))), 0,
  'and none open'
);
select is(
  (select c ->> 'category' from jsonb_array_elements(public.list_safeguarding_cases()) c limit 1) is not null, true,
  'resolved cases are listed after the unresolved ones, newest first'
);
reset role;
select is(
  (select position('SECRET' in coalesce(string_agg(detail::text, ''), '')) from public.audit_log), 0,
  'no message text of a child is ever copied into the audit log'
);

select * from finish();
rollback;
