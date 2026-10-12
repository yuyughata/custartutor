-- 080 M2 content engine, jobs: app_settings / ai_jobs / ai_usage access, create_ai_job, cancel_ai_job and the
-- service-role-only lease RPCs (ai_job_acquire_lease, ai_job_complete_step, ai_job_fail_step, ai_job_budget_check).
--   * clients read their own jobs through column grants that hide params, input, state, lease_token; nobody writes
--     the three tables directly; ai_usage has no client privilege at all
--   * create_ai_job: write roles at aal2, idempotent per (creator, key), kill switch, 5 unfinished jobs per creator
--   * leases: a live lease is busy, an expired one is taken over (and counts as a failed attempt), a late finisher
--     cannot store its output, 3 failed attempts end the job, terminal jobs cannot be leased, errors are scrubbed
--   * costs come from ai.prices (NULL when unpriced); the budget check sums KNOWN costs and reports unpriced calls
begin;
create extension if not exists pgtap with schema extensions;
select plan(161);

-- sa f2..01 super_admin | ed ..02 content_editor | rv ..03 reviewer | sup ..04 support | ana ..05 analyst
-- pl ..06 plain user    | ed2 ..07 content_editor
insert into auth.users (id, email) values
  ('f2000000-0000-4000-8000-000000000001', 'm2sa@test.local'),
  ('f2000000-0000-4000-8000-000000000002', 'm2ed@test.local'),
  ('f2000000-0000-4000-8000-000000000003', 'm2rv@test.local'),
  ('f2000000-0000-4000-8000-000000000004', 'm2sup@test.local'),
  ('f2000000-0000-4000-8000-000000000005', 'm2ana@test.local'),
  ('f2000000-0000-4000-8000-000000000006', 'm2pl@test.local'),
  ('f2000000-0000-4000-8000-000000000007', 'm2ed2@test.local');
insert into public.admin_users (user_id, role) values
  ('f2000000-0000-4000-8000-000000000001', 'super_admin'),
  ('f2000000-0000-4000-8000-000000000002', 'content_editor'),
  ('f2000000-0000-4000-8000-000000000003', 'reviewer'),
  ('f2000000-0000-4000-8000-000000000004', 'support'),
  ('f2000000-0000-4000-8000-000000000005', 'analyst'),
  ('f2000000-0000-4000-8000-000000000007', 'content_editor');

-- no settings rows: everything runs on the defaults unless a test sets one
with d as (delete from public.app_settings returning 1) select count(*) from d;

insert into public.schemes (id, subject_id, level_code, term, status)
select '5c200000-0000-4000-8000-000000000001', s.id, 'P1', 1, 'approved'
  from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4200000-0000-4000-8000-000000000001', '5c200000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, week_no, kind, title, objective, stage) values
  ('ab200000-0000-4000-8000-000000000001', 'c4200000-0000-4000-8000-000000000001', 1, 1, 'lesson', 'Unit 1', 'Objective 1', 'absorb');

create temp table jobs (label text primary key, id uuid not null, view jsonb);
grant all on jobs to public;
create temp table tok (label text primary key, token uuid not null);
grant all on tok to public;

-- 1. structure: tables, column grants, function ACLs -------------------------------------------------------------------
select is(
  (select count(*)::int from pg_class
    where oid in ('public.app_settings'::regclass, 'public.ai_jobs'::regclass, 'public.ai_usage'::regclass)
      and relrowsecurity),
  3,
  'row level security is on for app_settings, ai_jobs and ai_usage'
);
select is(
  (select array_agg(a.attname::text order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.ai_jobs'::regclass and a.attnum > 0 and not a.attisdropped
      and has_column_privilege('authenticated', 'public.ai_jobs', a.attname, 'SELECT')),
  array['attempts', 'created_at', 'created_by', 'error', 'finished_at', 'id', 'kind', 'lease_until',
        'progress', 'result', 'scheme_id', 'status', 'unit_id', 'updated_at'],
  'authenticated may read exactly the JobRow columns of ai_jobs'
);
select is(
  (select array_agg(a.attname::text order by a.attname::text collate "C")
     from pg_attribute a
    where a.attrelid = 'public.ai_jobs'::regclass and a.attnum > 0 and not a.attisdropped
      and not has_column_privilege('authenticated', 'public.ai_jobs', a.attname, 'SELECT')),
  array['idempotency_key', 'input', 'lease_token', 'params', 'state'],
  'input, state, lease_token, params and idempotency_key are not readable by clients'
);
select is(
  (select count(*)::int
     from unnest(array['anon', 'authenticated', 'service_role']) as r(role_name)
    cross join unnest(array['public.app_settings', 'public.ai_jobs', 'public.ai_usage']) as t(tbl)
    where has_any_column_privilege(r.role_name, t.tbl, 'INSERT,UPDATE,REFERENCES')
       or has_table_privilege(r.role_name, t.tbl, 'DELETE,TRUNCATE')),
  0,
  'no API role (service_role included) can write app_settings, ai_jobs or ai_usage directly'
);
select is(
  (select count(*)::int
     from unnest(array['anon', 'service_role']) as r(role_name)
    cross join unnest(array['public.app_settings', 'public.ai_jobs', 'public.ai_usage']) as t(tbl)
    where has_any_column_privilege(r.role_name, t.tbl, 'SELECT')),
  0,
  'anon and service_role cannot read the three tables either'
);
select is(
  has_any_column_privilege('authenticated', 'public.ai_usage', 'SELECT,INSERT,UPDATE,REFERENCES'),
  false,
  'authenticated has no privilege at all on ai_usage (read through get_ai_usage_summary only)'
);
select results_eq(
  $$select (select count(*)::int from pg_policy where polrelid = 'public.ai_usage'::regclass),
           (select count(*)::int from pg_policy where polrelid = 'public.app_settings'::regclass),
           (select count(*)::int from pg_policy where polrelid = 'public.ai_jobs'::regclass)$$,
  $$values (0, 1, 1)$$,
  'one select policy each on app_settings and ai_jobs, none on ai_usage'
);
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('ai_job_acquire_lease', 'ai_job_complete_step', 'ai_job_fail_step', 'ai_job_budget_check')
      and (has_function_privilege('anon', p.oid, 'EXECUTE') or has_function_privilege('authenticated', p.oid, 'EXECUTE'))),
  0,
  'anon and authenticated cannot execute any ai_job_* function (wrapper or implementation)'
);
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('ai_job_acquire_lease', 'ai_job_complete_step', 'ai_job_fail_step', 'ai_job_budget_check')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')),
  8,
  'service_role can execute the four ai_job_* wrappers and their implementations'
);
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.proname in ('create_ai_job', 'cancel_ai_job', 'save_scheme_draft', 'approve_scheme',
                        'apply_chapter_plan', 'create_unit_version_draft', 'set_unit_version_status',
                        'get_ai_settings', 'set_app_setting', 'get_ai_usage_summary')
      and has_function_privilege('service_role', p.oid, 'EXECUTE')),
  0,
  'service_role cannot execute the client RPCs'
);
select throws_ok(
  $$insert into public.app_settings (key, value) values ('ai.other', '1'::jsonb)$$,
  '23514', null, 'app_settings only accepts the known keys'
);

-- 2. clients cannot read the hidden columns or write anything -----------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok($$select input from public.ai_jobs$$, '42501', null, 'a client cannot select ai_jobs.input');
select throws_ok($$select state from public.ai_jobs$$, '42501', null, 'a client cannot select ai_jobs.state');
select throws_ok($$select lease_token from public.ai_jobs$$, '42501', null, 'a client cannot select ai_jobs.lease_token');
select throws_ok($$select idempotency_key from public.ai_jobs$$, '42501', null, 'a client cannot select ai_jobs.idempotency_key');
select throws_ok($$select * from public.ai_jobs$$, '42501', null, 'select * on ai_jobs is refused (columns must be named)');
select throws_ok(
  $$insert into public.ai_jobs (kind, input) values ('chapter_plan', '{}'::jsonb)$$,
  '42501', null, 'a client cannot insert into ai_jobs'
);
select throws_ok($$update public.ai_jobs set status = 'succeeded'$$, '42501', null, 'a client cannot update ai_jobs');
select throws_ok(
  $$with d as (delete from public.ai_jobs returning 1) select count(*) from d$$,
  '42501', null, 'a client cannot delete from ai_jobs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok($$select count(*) from public.ai_usage$$, '42501', null, 'not even a super_admin reads ai_usage directly');
select throws_ok(
  $$insert into public.app_settings (key, value) values ('ai.kill_switch', 'true'::jsonb)$$,
  '42501', null, 'not even a super_admin writes app_settings directly (set_app_setting only)'
);
select throws_ok(
  $$update public.app_settings set value = 'true'::jsonb$$,
  '42501', null, 'not even a super_admin updates app_settings directly'
);
select throws_ok(
  $$select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000001', 150)$$,
  '42501', null, 'a super_admin cannot call the service-role lease RPCs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.ai_job_complete_step('a0200000-0000-4000-8000-000000000001', gen_random_uuid(), 's', null, null, '{}'::jsonb, null)$$,
  '42501', null, 'an editor cannot call ai_job_complete_step'
);
select throws_ok(
  $$select public.ai_job_fail_step('a0200000-0000-4000-8000-000000000001', gen_random_uuid(), 's', '{}'::jsonb, true)$$,
  '42501', null, 'an editor cannot call ai_job_fail_step'
);
select throws_ok(
  $$select public.ai_job_budget_check('a0200000-0000-4000-8000-000000000001')$$,
  '42501', null, 'an editor cannot call ai_job_budget_check'
);
reset role;

-- 3. create_ai_job -------------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', null, 'anon cannot call create_ai_job'
);
reset role;

set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'not_authenticated', 'a JWT without a user is refused'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'an ordinary user cannot create jobs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'a reviewer cannot create jobs (every job ends in a write only editors may do)'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'support cannot create jobs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'an analyst cannot create jobs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'a content_editor at aal1 cannot create jobs'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'admin_role_required', 'a super_admin at aal1 cannot create jobs'
);

set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('nonsense', '{}'::jsonb, '{}'::jsonb, null, null, null)$$,
  '22023', 'invalid_job_kind', 'an unknown kind is refused'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '[]'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '22023', 'invalid_job_input', 'the input must be an object'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '[]'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '22023', 'invalid_job_params', 'the params must be an object'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', 'short')$$,
  '22023', 'invalid_idempotency_key', 'an idempotency key shorter than 8 characters is refused'
);
select throws_ok(
  $$select public.create_ai_job('unit_generate', '{}'::jsonb, '{}'::jsonb, null, null, null)$$,
  '22023', 'unit_id_required', 'unit jobs need a unit'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, null, null)$$,
  '22023', 'scheme_id_required', 'a chapter plan job needs a scheme'
);
select throws_ok(
  $$select public.create_ai_job('unit_generate', '{}'::jsonb, '{}'::jsonb, 'ab2000ff-0000-4000-8000-0000000000ff', null, null)$$,
  'P0002', 'unit_not_found', 'an unknown unit is a clean error'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c2000ff-0000-4000-8000-0000000000ff', null)$$,
  'P0002', 'scheme_not_found', 'an unknown scheme is a clean error'
);

select lives_ok(
  $$insert into jobs (label, id, view)
    select 'a1', (j ->> 'id')::uuid, j
      from (select public.create_ai_job('unit_generate', '{"unit_id":"ab200000-0000-4000-8000-000000000001","notes":"n"}'::jsonb,
              '{"unit":{"title":"Unit 1"}}'::jsonb, 'ab200000-0000-4000-8000-000000000001', '5c200000-0000-4000-8000-000000000001',
              'idem-key-0001') as j) x$$,
  'a content_editor at aal2 creates a job'
);
select is(
  (select array_agg(k order by k collate "C") from jsonb_object_keys((select view from jobs where label = 'a1')) k),
  array['attempts', 'created_at', 'created_by', 'error', 'finished_at', 'id', 'kind', 'lease_until',
        'progress', 'result', 'scheme_id', 'status', 'unit_id', 'updated_at'],
  'the returned row has exactly the JobRow keys (no input, state or lease token)'
);
select results_eq(
  $$select view ->> 'status', view ->> 'kind', view ->> 'created_by', (view -> 'progress')::text,
           view ->> 'attempts', view ->> 'lease_until', view ->> 'unit_id'
      from jobs where label = 'a1'$$,
  $$values ('queued', 'unit_generate', 'f2000000-0000-4000-8000-000000000002',
            '{"done": [], "next": null, "total": 0}', '0', null, 'ab200000-0000-4000-8000-000000000001')$$,
  'a new job is queued, unleased, with an empty progress, owned by the caller'
);
reset role;
select results_eq(
  $$select kind, status, params::text, input::text, state::text, unit_id::text, scheme_id::text, idempotency_key,
           lease_token is null, created_by::text
      from public.ai_jobs where id = (select id from jobs where label = 'a1')$$,
  $$values ('unit_generate', 'queued', '{"notes": "n", "unit_id": "ab200000-0000-4000-8000-000000000001"}',
            '{"unit": {"title": "Unit 1"}}', '{"outputs": {}}', 'ab200000-0000-4000-8000-000000000001',
            '5c200000-0000-4000-8000-000000000001', 'idem-key-0001', true, 'f2000000-0000-4000-8000-000000000002')$$,
  'the stored row keeps the params, the engine input, the key and an empty state'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is(
  (select public.create_ai_job('unit_generate', '{}'::jsonb, '{"other":true}'::jsonb,
            'ab200000-0000-4000-8000-000000000001', null, 'idem-key-0001') ->> 'id')::uuid,
  (select id from jobs where label = 'a1'),
  'the same idempotency key returns the same job'
);
reset role;
select is(
  (select count(*)::int from public.ai_jobs where idempotency_key = 'idem-key-0001'),
  1,
  'a repeated key did not create a second job'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('unit_revise', '{}'::jsonb, '{}'::jsonb, 'ab200000-0000-4000-8000-000000000001', null, 'idem-key-0001')$$,
  '22023', 'idempotency_key_reused', 'a key reused for another kind is refused'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into jobs (label, id)
    select 'b1', (public.create_ai_job('unit_generate', '{}'::jsonb, '{"x":1}'::jsonb,
            'ab200000-0000-4000-8000-000000000001', null, 'idem-key-0001') ->> 'id')::uuid$$,
  'another editor can use the same key (keys are per creator)'
);
select isnt(
  (select id from jobs where label = 'b1'), (select id from jobs where label = 'a1'),
  'and gets a different job'
);

-- 4. kill switch and the 5-job limit -------------------------------------------------------------------------------------
reset role;
insert into public.app_settings (key, value) values ('ai.kill_switch', 'true'::jsonb);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '42501', 'kill_switch', 'no new job while the kill switch is on'
);
select is(
  (select public.create_ai_job('unit_generate', '{}'::jsonb, '{}'::jsonb, 'ab200000-0000-4000-8000-000000000001', null, 'idem-key-0001') ->> 'id')::uuid,
  (select id from jobs where label = 'a1'),
  'a replay of an existing key still returns the existing job under the kill switch'
);
reset role;
update public.app_settings set value = 'false'::jsonb where key = 'ai.kill_switch';

set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into jobs (label, id)
    select 'c' || g, (public.create_ai_job('chapter_plan', '{}'::jsonb, '{"n":1}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null) ->> 'id')::uuid
      from generate_series(1, 4) g$$,
  'the editor creates four more jobs (5 unfinished in total)'
);
select throws_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{"n":1}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  '53400', 'too_many_jobs', 'a sixth unfinished job is refused'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{"n":1}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  'the limit is per creator: another editor still can'
);

-- 5. who sees which job -----------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 5, 'an editor sees their own 5 jobs and nobody else''s');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 2, 'the other editor sees only their 2');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 7, 'a super_admin sees every job');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is((select count(id)::int from public.ai_jobs), 0, 'a super_admin at aal1 sees none');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 0, 'a reviewer sees none of the editors'' jobs');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 0, 'support sees no jobs');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 0, 'an analyst sees no jobs');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(id)::int from public.ai_jobs), 0, 'an ordinary user sees no jobs');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is((select count(id)::int from public.ai_jobs), 0, 'an editor at aal1 sees none');
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select status, attempts, lease_until is null, progress::text from public.ai_jobs
     where id = (select id from jobs where label = 'a1')$$,
  $$values ('queued', 0, true, '{"done": [], "next": null, "total": 0}')$$,
  'an editor can poll the safe columns of their job'
);
reset role;

-- 6. cancel_ai_job --------------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select public.cancel_ai_job('a0200000-0000-4000-8000-000000000001')$$,
  '42501', null, 'anon cannot call cancel_ai_job'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.cancel_ai_job((select id from jobs where label = 'a1'))$$,
  '42501', 'admin_role_required', 'an ordinary user cannot cancel'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.cancel_ai_job((select id from jobs where label = 'a1'))$$,
  '42501', 'admin_role_required', 'an editor at aal1 cannot cancel'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.cancel_ai_job((select id from jobs where label = 'a1'))$$,
  'P0002', 'job_not_found', 'another editor cannot cancel (or even find) my job'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.cancel_ai_job((select id from jobs where label = 'a1'))$$,
  'P0002', 'job_not_found', 'a reviewer cannot cancel someone else''s job'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.cancel_ai_job('a0200000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'job_not_found', 'cancelling an unknown job is a clean error'
);
select is(
  (select public.cancel_ai_job((select id from jobs where label = 'c1')) ->> 'status'),
  'cancelled',
  'the creator cancels a queued job'
);
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select is(
  (select public.cancel_ai_job((select id from jobs where label = 'c2')) ->> 'status'),
  'cancelled',
  'a super_admin cancels someone else''s job'
);
select is(
  (select public.cancel_ai_job((select id from jobs where label = 'c2')) ->> 'status'),
  'cancelled',
  'cancelling a cancelled job is a no-op, not an error'
);
reset role;
select results_eq(
  $$select status, finished_at is not null, lease_token is null, lease_until is null
      from public.ai_jobs where id = (select id from jobs where label = 'c1')$$,
  $$values ('cancelled', true, true, true)$$,
  'a cancelled job is finished and holds no lease'
);
update public.ai_jobs set status = 'succeeded', finished_at = now() where id = (select id from jobs where label = 'c3');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is(
  (select public.cancel_ai_job((select id from jobs where label = 'c3')) ->> 'status'),
  'succeeded',
  'a finished job is returned unchanged by cancel'
);
select lives_ok(
  $$select public.create_ai_job('chapter_plan', '{}'::jsonb, '{"n":1}'::jsonb, null, '5c200000-0000-4000-8000-000000000001', null)$$,
  'finished and cancelled jobs no longer count against the limit of 5'
);
reset role;

-- 7. the lease RPCs, as the service role --------------------------------------------------------------------------------------
insert into public.ai_jobs (id, kind, input, created_by) values
  ('a0200000-0000-4000-8000-000000000011', 'unit_generate', '{"n":1}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000012', 'unit_generate', '{"n":2}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000013', 'unit_generate', '{"n":3}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000014', 'unit_generate', '{"n":4}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000015', 'unit_generate', '{"n":5}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000016', 'unit_generate', '{"n":6}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000017', 'unit_generate', '{"n":7}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000018', 'unit_generate', '{"n":8}'::jsonb, 'f2000000-0000-4000-8000-000000000002'),
  ('a0200000-0000-4000-8000-000000000019', 'unit_generate', '{"n":9}'::jsonb, 'f2000000-0000-4000-8000-000000000002');

set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok($$select count(id) from public.ai_jobs$$, '42501', null, 'the service role has no direct access to ai_jobs');
select throws_ok($$select count(id) from public.ai_usage$$, '42501', null, 'the service role has no direct access to ai_usage');
select throws_ok(
  $$select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 5)$$,
  '22023', 'invalid_lease_seconds', 'a lease shorter than 10 seconds is refused'
);
select throws_ok(
  $$select public.ai_job_acquire_lease('a0200000-0000-4000-8000-0000000000ff', 150)$$,
  'P0002', 'job_not_found', 'acquiring an unknown job is a clean error'
);
select throws_ok(
  $$select public.ai_job_complete_step('a0200000-0000-4000-8000-0000000000ff', gen_random_uuid(), 's', null, null, '{}'::jsonb, null)$$,
  'P0002', 'job_not_found', 'completing a step of an unknown job is a clean error'
);
select throws_ok(
  $$select public.ai_job_fail_step('a0200000-0000-4000-8000-0000000000ff', gen_random_uuid(), 's', '{}'::jsonb, true)$$,
  'P0002', 'job_not_found', 'failing a step of an unknown job is a clean error'
);
select throws_ok(
  $$select public.ai_job_budget_check('a0200000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'job_not_found', 'the budget check of an unknown job is a clean error'
);

-- L1: the happy path -----------------------------------------------------------------------------------------------------
create temp table acq (label text primary key, res jsonb);
grant all on acq to public;
select lives_ok(
  $$insert into acq select 'L1', public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 150)$$,
  'the first acquire takes the lease'
);
insert into tok select 'L1a', (res ->> 'lease_token')::uuid from acq where label = 'L1';
select results_eq(
  $$select (res ->> 'acquired')::boolean, res -> 'job' ->> 'status', (res -> 'job' ->> 'lease_until')::timestamptz = now() + interval '150 seconds',
           res ->> 'kind', res -> 'input', res -> 'state', res -> 'job' ? 'input', res -> 'job' ? 'lease_token', res -> 'job' ? 'state'
      from acq where label = 'L1'$$,
  $$values (true, 'running', true, 'unit_generate', '{"n": 1}'::jsonb, '{"outputs": {}}'::jsonb, false, false, false)$$,
  'acquire flips queued to running, leases for 150s and hands over input and state (the job view hides them)'
);
select results_eq(
  $$select res ->> 'acquired', res ->> 'reason', res -> 'job' ->> 'status'
      from (select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 150) as res) x$$,
  $$values ('false', 'busy', 'running')$$,
  'a live lease means busy'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000011', gen_random_uuid(), 'outline',
    '{"o":1}'::jsonb, '[{"label":"unit_generate:outline","task":"authoring","model":"m-unpriced","input_tokens":10,"output_tokens":5,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":120}]'::jsonb,
    '{"done":["outline"],"next":"s1","total":3}'::jsonb, null),
  false,
  'a wrong lease token cannot complete a step'
);
reset role;
select results_eq(
  $$select state::text, lease_token = (select token from tok where label = 'L1a'), attempts, progress::text
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000011'$$,
  $$values ('{"outputs": {}}', true, 0, '{"done": [], "next": null, "total": 0}')$$,
  'the refused completion changed nothing and the lease is still held'
);
select results_eq(
  $$select count(*)::int, count(*) filter (where est_cost_usd is null)::int
      from public.ai_usage where job_id = 'a0200000-0000-4000-8000-000000000011'$$,
  $$values (1, 1)$$,
  'but the spend of that call is logged (unpriced: cost NULL)'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000011', (select token from tok where label = 'L1a'), 'outline',
    '{"o":1}'::jsonb, '[{"label":"unit_generate:outline","task":"authoring","model":"m-unpriced","input_tokens":10,"output_tokens":5,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":120}]'::jsonb,
    '{"done":["outline"],"next":"s1","total":3}'::jsonb, null),
  true,
  'the lease holder completes a step'
);
reset role;
select results_eq(
  $$select state::text, progress::text, attempts, status, lease_token is null, lease_until is null, error is null, finished_at is null
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000011'$$,
  $$values ('{"outputs": {"outline": {"o": 1}}}', '{"done": ["outline"], "next": "s1", "total": 3}', 0, 'running', true, true, true, true)$$,
  'the output is merged, the progress replaced and the lease released'
);
select results_eq(
  $$select label, task, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, est_cost_usd is null,
           stop_reason, duration_ms, created_by::text
      from public.ai_usage where job_id = 'a0200000-0000-4000-8000-000000000011' order by id desc limit 1$$,
  $$values ('unit_generate:outline', 'authoring', 'm-unpriced', 10, 5, 0, 0, true, 'end_turn', 120, 'f2000000-0000-4000-8000-000000000002')$$,
  'the usage row carries the call''s tokens, stop reason and the job creator'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000011', (select token from tok where label = 'L1a'), 'outline',
    '{"o":2}'::jsonb, null, '{"done":["outline"],"next":"s1","total":3}'::jsonb, null),
  false,
  'a lease token works once: completing again with it is refused'
);
select lives_ok(
  $$insert into acq select 'L1b', public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 150)$$,
  'the next step takes a fresh lease'
);
insert into tok select 'L1b', (res ->> 'lease_token')::uuid from acq where label = 'L1b';
select results_eq(
  $$select (select token from tok where label = 'L1b') <> (select token from tok where label = 'L1a'),
           res -> 'state'
      from acq where label = 'L1b'$$,
  $$values (true, '{"outputs": {"outline": {"o": 1}}}'::jsonb)$$,
  'the new lease has a new token and sees the stored outputs'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000011', (select token from tok where label = 'L1b'), 's1',
    '{"s":1}'::jsonb, '[]'::jsonb, '{"done":["outline","s1"],"next":null,"total":2}'::jsonb, '{"unit_version_id":"x"}'::jsonb),
  true,
  'the last step finishes the job with a result'
);
reset role;
select results_eq(
  $$select status, result::text, finished_at is not null, lease_token is null, lease_until is null
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000011'$$,
  $$values ('succeeded', '{"unit_version_id": "x"}', true, true, true)$$,
  'the job is succeeded with its result and holds no lease'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select res ->> 'acquired', res ->> 'reason', res -> 'job' ->> 'status'
      from (select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 150) as res) x$$,
  $$values ('false', 'terminal', 'succeeded')$$,
  'a finished job cannot be leased'
);

-- L2: an expired lease is taken over, and a dead worker is a failed attempt --------------------------------------------------
select lives_ok(
  $$insert into acq select 'L2a', public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000012', 150)$$,
  'L2: the first holder takes the lease'
);
insert into tok select 'L2a', (res ->> 'lease_token')::uuid from acq where label = 'L2a';
reset role;
update public.ai_jobs set lease_until = now() - interval '1 second' where id = 'a0200000-0000-4000-8000-000000000012';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into acq select 'L2b', public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000012', 150)$$,
  'L2: an expired lease can be taken over'
);
insert into tok select 'L2b', (res ->> 'lease_token')::uuid from acq where label = 'L2b';
select results_eq(
  $$select (res ->> 'acquired')::boolean, (select token from tok where label = 'L2b') <> (select token from tok where label = 'L2a'),
           res -> 'job' ->> 'attempts', res -> 'job' -> 'error' ->> 'code', (res -> 'job' -> 'error' ->> 'retryable')::boolean
      from acq where label = 'L2b'$$,
  $$values (true, true, '1', 'aborted', true)$$,
  'the takeover counts the dead attempt, with a new token'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000012', (select token from tok where label = 'L2a'), 'outline',
    '{"late":true}'::jsonb, null, '{"done":["outline"],"next":null,"total":1}'::jsonb, '{"r":1}'::jsonb),
  false,
  'the late finisher of the first lease cannot store its output'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000012', (select token from tok where label = 'L2a'), 'outline', '{"code":"x","message":"y"}'::jsonb, true),
  false,
  'nor can it report a failure'
);
reset role;
select results_eq(
  $$select status, state::text, lease_token = (select token from tok where label = 'L2b'), attempts
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000012'$$,
  $$values ('running', '{"outputs": {}}', true, 1)$$,
  'the newer attempt is untouched'
);
update public.ai_jobs set lease_until = now() - interval '1 second' where id = 'a0200000-0000-4000-8000-000000000012';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000012', 150) ->> 'acquired')::boolean,
  true,
  'second takeover: still allowed (2 failed attempts)'
);
reset role;
update public.ai_jobs set lease_until = now() - interval '1 second' where id = 'a0200000-0000-4000-8000-000000000012';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select res ->> 'acquired', res ->> 'reason', res -> 'job' ->> 'status', res -> 'job' ->> 'attempts', res -> 'job' ? 'finished_at'
      from (select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000012', 150) as res) x$$,
  $$values ('false', 'terminal', 'failed', '3', true)$$,
  'the third dead attempt fails the job instead of leasing it again'
);
reset role;
select results_eq(
  $$select status, finished_at is not null, lease_token is null, error ->> 'code'
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000012'$$,
  $$values ('failed', true, true, 'aborted')$$,
  'L2 ends failed, finished, unleased, with the aborted error'
);

-- L3: failure accounting ----------------------------------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L3a', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000013', 150) ->> 'lease_token')::uuid$$,
  'L3: lease taken'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000013', gen_random_uuid(), 'outline', '{"code":"transport","message":"x"}'::jsonb, true),
  false,
  'a failure with the wrong token is not recorded'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000013', (select token from tok where label = 'L3a'), 'outline',
    jsonb_build_object('code', 'transport', 'message', repeat('x', 600), 'raw', 'SECRET-RAW-MODEL-OUTPUT', 'stack', 'at foo (bar.ts:1)'), true),
  true,
  'a retryable failure is recorded'
);
reset role;
select results_eq(
  $$select status, attempts, lease_token is null, lease_until is null, finished_at is null, error ->> 'code', error ->> 'step',
           (error ->> 'retryable')::boolean, char_length(error ->> 'message')
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000013'$$,
  $$values ('running', 1, true, true, true, 'transport', 'outline', true, 500)$$,
  'the job keeps running with the error recorded (message bounded) and the lease released'
);
select results_eq(
  $$select (select array_agg(k order by k collate "C") from jsonb_object_keys(error) k), error::text like '%SECRET%', error::text like '%bar.ts%'
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000013'$$,
  $$values (array['code', 'message', 'retryable', 'step']::text[], false, false)$$,
  'only code, message, step and retryable are stored: raw output and stack traces cannot enter the row'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L3b', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000013', 150) ->> 'lease_token')::uuid$$,
  'L3: the retry takes a new lease'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000013', (select token from tok where label = 'L3b'), 'outline', '{"code":"transport","message":"again"}'::jsonb, true),
  true,
  'L3: second failure recorded'
);
reset role;
select results_eq(
  $$select status, attempts from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000013'$$,
  $$values ('running', 2)$$,
  'two failed attempts: still running'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L3c', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000013', 150) ->> 'lease_token')::uuid$$,
  'L3: the third attempt takes a new lease'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000013', (select token from tok where label = 'L3c'), 'outline', '{"code":"transport","message":"third"}'::jsonb, true),
  true,
  'L3: third failure recorded'
);
reset role;
select results_eq(
  $$select status, attempts, finished_at is not null, lease_token is null from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000013'$$,
  $$values ('failed', 3, true, true)$$,
  'the third failed attempt ends the job even though it was retryable'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000013', (select token from tok where label = 'L3c'), 'outline', '{"code":"x","message":"y"}'::jsonb, true),
  false,
  'a failed job accepts no more reports'
);
select is(
  public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000013', 150) ->> 'reason',
  'terminal',
  'and cannot be leased'
);

-- L4: a non-retryable failure ends the job at once; L5: success resets the attempt counter ---------------------------------------
select lives_ok(
  $$insert into tok select 'L4', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000014', 150) ->> 'lease_token')::uuid$$,
  'L4: lease taken'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000014', (select token from tok where label = 'L4'), 'outline', '{"code":"refusal","message":"declined"}'::jsonb, false),
  true,
  'L4: a non-retryable failure is recorded'
);
reset role;
select results_eq(
  $$select status, attempts, finished_at is not null, error ->> 'code', (error ->> 'retryable')::boolean
      from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000014'$$,
  $$values ('failed', 1, true, 'refusal', false)$$,
  'the job failed on the first attempt'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L5a', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000015', 150) ->> 'lease_token')::uuid$$,
  'L5: lease taken'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000015', (select token from tok where label = 'L5a'), 'outline', '{"code":"transport","message":"x"}'::jsonb, true),
  true,
  'L5: one retryable failure'
);
select lives_ok(
  $$insert into tok select 'L5b', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000015', 150) ->> 'lease_token')::uuid$$,
  'L5: the retry'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000015', (select token from tok where label = 'L5b'), 'outline', '{"o":1}'::jsonb, null,
    '{"done":["outline"],"next":"s1","total":2}'::jsonb, null),
  true,
  'L5: the retry succeeds'
);
reset role;
select results_eq(
  $$select attempts, error is null, status from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000015'$$,
  $$values (0, true, 'running')$$,
  'a completed step resets the attempts and clears the old error'
);

-- L6: a cancelled job drops the output of the step in flight, but not its spend --------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L6', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000016', 150) ->> 'lease_token')::uuid$$,
  'L6: lease taken'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f2000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is(
  (select public.cancel_ai_job('a0200000-0000-4000-8000-000000000016') ->> 'status'),
  'cancelled',
  'L6: the creator cancels while a step is in flight'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000016', (select token from tok where label = 'L6'), 'outline', '{"o":1}'::jsonb,
    '[{"label":"l","task":"authoring","model":"m-unpriced","input_tokens":7,"output_tokens":3,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":9}]'::jsonb,
    '{"done":["outline"],"next":null,"total":1}'::jsonb, '{"r":1}'::jsonb),
  false,
  'L6: the finishing step is refused'
);
reset role;
select results_eq(
  $$select j.status, j.state::text, j.result is null, (select count(*)::int from public.ai_usage u where u.job_id = j.id)
      from public.ai_jobs j where j.id = 'a0200000-0000-4000-8000-000000000016'$$,
  $$values ('cancelled', '{"outputs": {}}', true, 1)$$,
  'L6: the job stays cancelled with no output, but the call is still in the usage log'
);

-- L7: costs and the budget check -----------------------------------------------------------------------------------------------
insert into public.app_settings (key, value) values
  ('ai.prices', '{"m-priced": {"input_per_mtok": 3, "output_per_mtok": 15, "cache_read_per_mtok": 0.3, "cache_write_per_mtok": 3.75}}'::jsonb);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select b ->> 'job_cost_usd', b ->> 'unpriced_calls', b ->> 'max_usd_per_job', b ->> 'daily_usd_cap', b ->> 'kill_switch'
      from (select public.ai_job_budget_check('a0200000-0000-4000-8000-000000000017') as b) x$$,
  $$values ('0', '0', null, null, 'false')$$,
  'a job without usage costs nothing; no caps, no kill switch by default'
);
select lives_ok(
  $$insert into tok select 'L7', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000017', 150) ->> 'lease_token')::uuid$$,
  'L7: lease taken'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000017', (select token from tok where label = 'L7'), 'outline', '{"o":1}'::jsonb,
    '[{"label":"priced","task":"authoring","model":"m-priced","input_tokens":1000,"output_tokens":500,"cache_read_tokens":2000,"cache_creation_tokens":100,"stop_reason":"end_turn","duration_ms":5},
      {"label":"unpriced","task":"authoring","model":"m-other","input_tokens":900,"output_tokens":900,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":5}]'::jsonb,
    '{"done":["outline"],"next":"s1","total":2}'::jsonb, null),
  true,
  'L7: a step with one priced and one unpriced call completes'
);
reset role;
select results_eq(
  $$select label, est_cost_usd from public.ai_usage where job_id = 'a0200000-0000-4000-8000-000000000017' order by id$$,
  $$values ('priced', 0.011475::numeric), ('unpriced', null::numeric)$$,
  'cost = (1000 x 3 + 500 x 15 + 2000 x 0.3 + 100 x 3.75) / 1e6 for the priced model, NULL for the unpriced one'
);
insert into public.ai_usage (job_id, label, task, model, est_cost_usd, created_at)
values ('a0200000-0000-4000-8000-000000000017', 'old', 'authoring', 'm-priced', 100, now() - interval '2 days');
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select (b ->> 'job_cost_usd')::numeric, (b ->> 'unpriced_calls')::int,
           (b ->> 'day_cost_usd')::numeric >= 0.011475, (b ->> 'day_cost_usd')::numeric < 100, (b ->> 'day_unpriced_calls')::int >= 1
      from (select public.ai_job_budget_check('a0200000-0000-4000-8000-000000000017') as b) x$$,
  $$values (100.011475::numeric, 1, true, true, true)$$,
  'the job cost sums the known costs of all its calls, today''s cost only today''s; the unpriced call is counted, not priced at zero'
);
reset role;
update public.app_settings set value = '{"m-priced": {"input_per_mtok": 3, "output_per_mtok": 15, "cache_read_per_mtok": 0.3, "cache_write_per_mtok": 3.75}}'::jsonb
 where key = 'ai.prices';
insert into public.app_settings (key, value) values
  ('ai.budget', '{"max_usd_per_job": 0.01, "daily_usd_cap": 5}'::jsonb),
  ('ai.kill_switch', 'true'::jsonb)
on conflict (key) do update set value = excluded.value;
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select (b ->> 'max_usd_per_job')::numeric, (b ->> 'daily_usd_cap')::numeric, (b ->> 'kill_switch')::boolean
      from (select public.ai_job_budget_check('a0200000-0000-4000-8000-000000000017') as b) x$$,
  $$values (0.01::numeric, 5::numeric, true)$$,
  'the check reports the caps and the kill switch from app_settings'
);

-- the price lookup: the exact model id, else the longest price key that is a prefix of it ----------------------------------------
reset role;
update public.app_settings set value = jsonb_build_object(
  'claude-opus-5-5', jsonb_build_object('input_per_mtok', 10, 'output_per_mtok', 20, 'cache_read_per_mtok', 1, 'cache_write_per_mtok', 2),
  'claude-opus', jsonb_build_object('input_per_mtok', 1, 'output_per_mtok', 2, 'cache_read_per_mtok', 0.1, 'cache_write_per_mtok', 0.2),
  'claude-opus-5-5-20261001', jsonb_build_object('input_per_mtok', 5, 'output_per_mtok', 5, 'cache_read_per_mtok', 5, 'cache_write_per_mtok', 5)
) where key = 'ai.prices';
select results_eq(
  $$select m, private.ai_call_cost((select value from public.app_settings where key = 'ai.prices'), m, 1000000, 1000000, 1000000, 1000000)
      from (values ('claude-opus-5-5'), ('claude-opus-5-5-20270101'), ('claude-opus-5-5-20261001'), ('claude-opus-4-1'),
                   ('claude-opus-5'), ('claude-opus'), ('claude-haiku-5-5'), ('opus'), ('')) as t(m)
     order by m$$,
  $$values ('', null::numeric), ('claude-haiku-5-5', null), ('claude-opus', 3.3::numeric), ('claude-opus-4-1', 3.3::numeric),
           ('claude-opus-5', 3.3::numeric), ('claude-opus-5-5', 33::numeric), ('claude-opus-5-5-20261001', 20::numeric),
           ('claude-opus-5-5-20270101', 33::numeric), ('opus', null)$$,
  'alias key priced; a dated snapshot id uses the alias price; the longest prefix wins; an exact entry beats a prefix; a key longer than the id or an unrelated model is unpriced (NULL)'
);
select results_eq(
  $$select private.ai_call_cost('{}'::jsonb, 'claude-opus-5-5', 1, 1, 1, 1), private.ai_call_cost(null, 'claude-opus-5-5', 1, 1, 1, 1),
           private.ai_call_cost((select value from public.app_settings where key = 'ai.prices'), null, 1, 1, 1, 1)$$,
  $$values (null::numeric, null::numeric, null::numeric)$$,
  'no prices, no price table or no model: unknown cost, never zero'
);
update public.app_settings set value = jsonb_build_object(
  'claude-opus-5-5', jsonb_build_object('input_per_mtok', 10, 'output_per_mtok', 20, 'cache_read_per_mtok', 1, 'cache_write_per_mtok', 2)
) where key = 'ai.prices';
update public.app_settings set value = 'false'::jsonb where key = 'ai.kill_switch';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$insert into tok select 'L9', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000019', 150) ->> 'lease_token')::uuid$$,
  'L9: lease taken'
);
select is(
  public.ai_job_complete_step('a0200000-0000-4000-8000-000000000019', (select token from tok where label = 'L9'), 'outline', '{"o":1}'::jsonb,
    '[{"label":"snapshot","task":"authoring","model":"claude-opus-5-5-20261001","input_tokens":1000000,"output_tokens":1000000,"cache_read_tokens":1000000,"cache_creation_tokens":1000000,"stop_reason":"end_turn","duration_ms":1},
      {"label":"other","task":"moderation","model":"claude-haiku-5-5","input_tokens":5,"output_tokens":5,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":1}]'::jsonb,
    '{"done":["outline"],"next":"s1","total":2}'::jsonb, null),
  true,
  'L9: a step reports a dated snapshot of a priced alias and an unpriced model'
);
reset role;
select results_eq(
  $$select label, est_cost_usd from public.ai_usage where job_id = 'a0200000-0000-4000-8000-000000000019' order by id$$,
  $$values ('snapshot', 33::numeric), ('other', null::numeric)$$,
  'the snapshot call is priced through the alias; the unpriced model stays NULL'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select results_eq(
  $$select (b ->> 'job_cost_usd')::numeric, (b ->> 'unpriced_calls')::int
      from (select public.ai_job_budget_check('a0200000-0000-4000-8000-000000000019') as b) x$$,
  $$values (33::numeric, 1)$$,
  'the budget check counts the alias-priced call and reports the unpriced one separately'
);

-- failed but billed: a failed step logs the calls it made ---------------------------------------------------------------------
select lives_ok(
  $$insert into tok select 'L8', (public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000018', 150) ->> 'lease_token')::uuid$$,
  'L8: lease taken'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000018', gen_random_uuid(), 'outline', '{"code":"schema","message":"bad"}'::jsonb, true,
    '[{"label":"stale","task":"authoring","model":"claude-opus-5-5","input_tokens":1000000,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"end_turn","duration_ms":1}]'::jsonb),
  false,
  'L8: a failure report with a stale token changes nothing'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000018', (select token from tok where label = 'L8'), 'outline', '{"code":"schema","message":"bad"}'::jsonb, true,
    '[{"label":"billed","task":"authoring","model":"claude-opus-5-5-20270101","input_tokens":0,"output_tokens":1000000,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"refusal","duration_ms":3},
      {"label":"billed2","task":"authoring","model":"claude-haiku-5-5","input_tokens":1,"output_tokens":1,"cache_read_tokens":0,"cache_creation_tokens":0,"stop_reason":"max_tokens","duration_ms":3}]'::jsonb),
  true,
  'L8: the failure of the lease holder is recorded together with its billed calls'
);
select is(
  public.ai_job_fail_step('a0200000-0000-4000-8000-000000000018', gen_random_uuid(), 'outline', '{"code":"schema","message":"bad"}'::jsonb, true),
  false,
  'the 5-argument call still works (usage defaults to none) and, with a stale token, records nothing'
);
select throws_ok(
  $$select public.ai_job_fail_step('a0200000-0000-4000-8000-000000000018', gen_random_uuid(), 'outline', '{}'::jsonb, true, '{}'::jsonb)$$,
  '22023', 'invalid_usage', 'usage must be an array'
);
reset role;
select results_eq(
  $$select label, est_cost_usd, stop_reason from public.ai_usage where job_id = 'a0200000-0000-4000-8000-000000000018' order by id$$,
  $$values ('stale', 10::numeric, 'end_turn'), ('billed', 20::numeric, 'refusal'), ('billed2', null::numeric, 'max_tokens')$$,
  'the failed step''s calls are in the usage log with their cost (alias-priced, unpriced = NULL), stale-token report included'
);
select results_eq(
  $$select status, attempts, error ->> 'code' from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000018'$$,
  $$values ('running', 1, 'schema')$$,
  'and the attempt accounting is the same as before: one failed attempt, still running'
);

-- the kill switch also stops new leases (create_ai_job refuses new jobs, see above) --------------------------------------------
update public.app_settings set value = 'true'::jsonb where key = 'ai.kill_switch';
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select throws_ok(
  $$select public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000018', 150)$$,
  '42501', 'kill_switch', 'no lease is granted while the kill switch is on'
);
select is(
  public.ai_job_acquire_lease('a0200000-0000-4000-8000-000000000011', 150) ->> 'reason',
  'terminal',
  'a finished job is still reported as finished under the kill switch'
);
reset role;
select is(
  (select attempts from public.ai_jobs where id = 'a0200000-0000-4000-8000-000000000018'),
  1,
  'and the refused lease changed nothing'
);
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';

-- argument validation --------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.ai_job_complete_step('a0200000-0000-4000-8000-000000000017', gen_random_uuid(), ' ', null, null, '{}'::jsonb, null)$$,
  '22023', 'invalid_step', 'a blank step name is refused'
);
select throws_ok(
  $$select public.ai_job_complete_step('a0200000-0000-4000-8000-000000000017', gen_random_uuid(), 's', null, null, '[]'::jsonb, null)$$,
  '22023', 'invalid_progress', 'progress must be an object'
);
select throws_ok(
  $$select public.ai_job_complete_step('a0200000-0000-4000-8000-000000000017', gen_random_uuid(), 's', null, '{}'::jsonb, '{}'::jsonb, null)$$,
  '22023', 'invalid_usage', 'usage must be an array'
);
reset role;

-- table invariants (owner) ------------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.ai_jobs set status = 'succeeded' where id = 'a0200000-0000-4000-8000-000000000015'$$,
  '23514', null, 'a finished job must have finished_at (check constraint)'
);
select throws_ok(
  $$update public.ai_jobs set lease_token = gen_random_uuid() where id = 'a0200000-0000-4000-8000-000000000015'$$,
  '23514', null, 'a lease token without a deadline is refused (check constraint)'
);

select * from finish();
rollback;
