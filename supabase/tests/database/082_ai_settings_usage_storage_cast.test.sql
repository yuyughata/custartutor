-- 082 M2 content engine, the rest of the server surface: get_ai_settings / set_app_setting, get_ai_usage_summary,
-- the scheme-uploads bucket policies and the owner's cast facts.
--   * settings: content staff read (defaults for missing keys), only a super_admin at aal2 writes, every key is
--     validated by shape, every change is audited (an unchanged value is not)
--   * usage: super_admin, content_editor and analyst read the aggregates; unpriced calls give a NULL cost, never zero
--   * storage: content staff at aal2 upload and read ONLY under their own user-id prefix; no update, no delete
--   * cast: Zari and Zuri carry exactly the owner's facts; the merge keeps whatever the admins added
begin;
create extension if not exists pgtap with schema extensions;
select plan(116);

-- sa f4..01 super_admin | ed ..02 content_editor | rv ..03 reviewer | sup ..04 support | ana ..05 analyst | pl ..06 plain
insert into auth.users (id, email) values
  ('f4000000-0000-4000-8000-000000000001', 'u4sa@test.local'),
  ('f4000000-0000-4000-8000-000000000002', 'u4ed@test.local'),
  ('f4000000-0000-4000-8000-000000000003', 'u4rv@test.local'),
  ('f4000000-0000-4000-8000-000000000004', 'u4sup@test.local'),
  ('f4000000-0000-4000-8000-000000000005', 'u4ana@test.local'),
  ('f4000000-0000-4000-8000-000000000006', 'u4pl@test.local');
insert into public.admin_users (user_id, role) values
  ('f4000000-0000-4000-8000-000000000001', 'super_admin'),
  ('f4000000-0000-4000-8000-000000000002', 'content_editor'),
  ('f4000000-0000-4000-8000-000000000003', 'reviewer'),
  ('f4000000-0000-4000-8000-000000000004', 'support'),
  ('f4000000-0000-4000-8000-000000000005', 'analyst');

-- start from an empty settings table (the dev project may hold real settings; this is rolled back)
with d as (delete from public.app_settings returning 1) select count(*) from d;
with d as (delete from public.audit_log where entity = 'app_settings' returning 1) select count(*) from d;

-- A. get_ai_settings --------------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select public.get_ai_settings()$$, '42501', null, 'anon cannot call get_ai_settings');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.get_ai_settings()$$, '42501', 'not_authenticated', 'a JWT without a user is refused');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.get_ai_settings()$$, '42501', 'admin_role_required', 'an ordinary user cannot read the settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.get_ai_settings()$$, '42501', 'admin_role_required', 'support cannot read the settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.get_ai_settings()$$, '42501', 'admin_role_required', 'an analyst cannot read the settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok($$select public.get_ai_settings()$$, '42501', 'admin_role_required', 'a reviewer at aal1 cannot read the settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select is(
  public.get_ai_settings(),
  '{"models":{"authoring":"claude-opus-5-5","tutor":"claude-sonnet-5-5","moderation":"claude-haiku-5-5"},
    "kill_switch":false,"budget":{"max_usd_per_job":null,"daily_usd_cap":null},"prices":{},"effort":{},"prompt_version":"m2-v1"}'::jsonb,
  'a reviewer reads the defaults of an empty settings table (DEFAULT_AI_SETTINGS)'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.get_ai_settings()$$, 'a content_editor reads the settings');
select is((select count(*)::int from public.app_settings), 0, 'and the table itself is empty');

-- B. set_app_setting --------------------------------------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', null, 'anon cannot call set_app_setting');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'a content_editor cannot write settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'a reviewer cannot write settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'support cannot write settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'an analyst cannot write settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'an ordinary user cannot write settings');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, '42501', 'admin_role_required', 'a super_admin at aal1 cannot write settings');

set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.set_app_setting('ai.nope', 'true'::jsonb)$$, '22023', 'invalid_setting_key', 'an unknown key is refused');
select throws_ok($$select public.set_app_setting(null, 'true'::jsonb)$$, '22023', 'invalid_setting_key', 'a null key is refused');
select throws_ok($$select public.set_app_setting('ai.kill_switch', null)$$, '22023', 'invalid_setting_value', 'a null value is refused');
select throws_ok(
  format($q$select public.set_app_setting(%L, %L::jsonb)$q$, c.k, c.v),
  '22023', 'invalid_setting_value', 'rejected: ' || c.label
)
from (values
  ('ai.models', '{}', 'models: empty'),
  ('ai.models', '{"authoring":"a","tutor":"b"}', 'models: a task is missing'),
  ('ai.models', '{"authoring":"a","tutor":"b","moderation":"c","extra":"d"}', 'models: an extra key'),
  ('ai.models', '{"authoring":"a","tutor":" ","moderation":"c"}', 'models: a blank model id'),
  ('ai.models', '{"authoring":"a","tutor":5,"moderation":"c"}', 'models: a number as model id'),
  ('ai.models', '["a","b","c"]', 'models: an array'),
  ('ai.kill_switch', '"yes"', 'kill_switch: a string'),
  ('ai.kill_switch', '1', 'kill_switch: a number'),
  ('ai.kill_switch', 'null', 'kill_switch: JSON null'),
  ('ai.budget', '{}', 'budget: empty'),
  ('ai.budget', '{"max_usd_per_job":null}', 'budget: a cap is missing'),
  ('ai.budget', '{"max_usd_per_job":0,"daily_usd_cap":null}', 'budget: a zero cap'),
  ('ai.budget', '{"max_usd_per_job":-1,"daily_usd_cap":null}', 'budget: a negative cap'),
  ('ai.budget', '{"max_usd_per_job":"5","daily_usd_cap":null}', 'budget: a cap as text'),
  ('ai.budget', '{"max_usd_per_job":1,"daily_usd_cap":2,"x":1}', 'budget: an extra key'),
  ('ai.prices', '[]', 'prices: an array'),
  ('ai.prices', '{"m":1}', 'prices: an entry that is not an object'),
  ('ai.prices', '{"m":{"input_per_mtok":1,"output_per_mtok":1,"cache_read_per_mtok":1}}', 'prices: a field is missing'),
  ('ai.prices', '{"m":{"input_per_mtok":1,"output_per_mtok":1,"cache_read_per_mtok":1,"cache_write_per_mtok":1,"x":1}}', 'prices: an extra field'),
  ('ai.prices', '{"m":{"input_per_mtok":-1,"output_per_mtok":1,"cache_read_per_mtok":1,"cache_write_per_mtok":1}}', 'prices: a negative price'),
  ('ai.prices', '{"m":{"input_per_mtok":"1","output_per_mtok":1,"cache_read_per_mtok":1,"cache_write_per_mtok":1}}', 'prices: a price as text'),
  ('ai.prices', '{"":{"input_per_mtok":1,"output_per_mtok":1,"cache_read_per_mtok":1,"cache_write_per_mtok":1}}', 'prices: a blank model id'),
  ('ai.effort', '[]', 'effort: an array'),
  ('ai.effort', '{"unit_generate":"ultra"}', 'effort: an unknown level'),
  ('ai.effort', '{"unit_generate":5}', 'effort: a number'),
  ('ai.effort', '{"":"high"}', 'effort: a blank key'),
  ('ai.prompt_version', '""', 'prompt_version: empty'),
  ('ai.prompt_version', '"   "', 'prompt_version: blank'),
  ('ai.prompt_version', to_jsonb(repeat('v', 65))::text, 'prompt_version: 65 characters'),
  ('ai.prompt_version', '5', 'prompt_version: a number')
) as c(k, v, label);
reset role;
select is((select count(*)::int from public.app_settings), 0, 'none of the refused values was stored');

set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.set_app_setting('ai.models', '{"authoring":"claude-opus-5-5","tutor":"claude-sonnet-5-5","moderation":"claude-haiku-5-5-x"}'::jsonb)$$,
  'a super_admin sets the models'
);
select lives_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, 'and the kill switch');
select lives_ok($$select public.set_app_setting('ai.budget', '{"max_usd_per_job":null,"daily_usd_cap":null}'::jsonb)$$, 'budgets without caps are valid');
select lives_ok($$select public.set_app_setting('ai.budget', '{"max_usd_per_job":2.5,"daily_usd_cap":10}'::jsonb)$$, 'and with caps');
select lives_ok(
  $$select public.set_app_setting('ai.prices',
      '{"claude-opus-5-5":{"input_per_mtok":10,"output_per_mtok":20,"cache_read_per_mtok":0,"cache_write_per_mtok":12.5}}'::jsonb)$$,
  'prices (a zero price is allowed)'
);
select lives_ok($$select public.set_app_setting('ai.effort', '{"unit_generate:core":"high","tutor":"low"}'::jsonb)$$, 'the effort overrides');
select lives_ok($$select public.set_app_setting('ai.prompt_version', '"m2-v2"'::jsonb)$$, 'and the prompt version');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select is(
  public.get_ai_settings(),
  '{"models":{"authoring":"claude-opus-5-5","tutor":"claude-sonnet-5-5","moderation":"claude-haiku-5-5-x"},
    "kill_switch":true,"budget":{"max_usd_per_job":2.5,"daily_usd_cap":10},
    "prices":{"claude-opus-5-5":{"input_per_mtok":10,"output_per_mtok":20,"cache_read_per_mtok":0,"cache_write_per_mtok":12.5}},
    "effort":{"unit_generate:core":"high","tutor":"low"},"prompt_version":"m2-v2"}'::jsonb,
  'get_ai_settings assembles exactly what was set'
);
select is((select count(*)::int from public.app_settings), 6, 'content staff can read the settings table (6 keys)');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.app_settings), 0, 'support cannot read the settings table');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.app_settings), 0, 'an ordinary user cannot read the settings table');
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.app_settings), 0, 'a reviewer at aal1 cannot read the settings table');

-- audit: each change is recorded, an unchanged value is not ------------------------------------------------------------------
reset role;
select results_eq(
  $$select action, entity_id, actor::text, detail -> 'new' ->> 'value', jsonb_typeof(detail -> 'old') = 'null'
      from public.audit_log where entity = 'app_settings' and entity_id = 'ai.kill_switch' order by id$$,
  $$values ('insert', 'ai.kill_switch', 'f4000000-0000-4000-8000-000000000001', 'true', true)$$,
  'the first value of a key is audited (actor, key, new value)'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.set_app_setting('ai.kill_switch', 'true'::jsonb)$$, 'setting the same value again is accepted');
select lives_ok($$select public.set_app_setting('ai.kill_switch', 'false'::jsonb)$$, 'and so is changing it');
reset role;
select results_eq(
  $$select action, detail -> 'old' ->> 'value', detail -> 'new' ->> 'value'
      from public.audit_log where entity = 'app_settings' and entity_id = 'ai.kill_switch' order by id$$,
  $$values ('insert', null, 'true'), ('update', 'true', 'false')$$,
  'only the real change was audited, with old and new value; the repeat wrote nothing'
);
select is(
  (select count(*)::int from public.audit_log where entity = 'app_settings'),
  8,
  'eight audit rows in total: six first values and two changes (budget, kill switch)'
);

-- defaults fill the gaps -----------------------------------------------------------------------------------------------------
with d as (delete from public.app_settings where key in ('ai.models', 'ai.kill_switch') returning 1) select count(*) from d;
update public.app_settings set value = '{"max_usd_per_job": 3}'::jsonb where key = 'ai.budget';
set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select s -> 'models' ->> 'authoring', s ->> 'kill_switch', s -> 'budget' ->> 'max_usd_per_job', s -> 'budget' ->> 'daily_usd_cap',
           s ->> 'prompt_version'
      from (select public.get_ai_settings() as s) x$$,
  $$values ('claude-opus-5-5', 'false', '3', null, 'm2-v2')$$,
  'missing keys fall back to the defaults, and a partial stored object is laid over them'
);
reset role;

-- C. get_ai_usage_summary ----------------------------------------------------------------------------------------------------
insert into public.ai_jobs (id, kind, status, input, created_by, created_at, finished_at) values
  ('b0400000-0000-4000-8000-000000000001', 'unit_generate', 'succeeded', '{}', 'f4000000-0000-4000-8000-000000000002', '2026-01-10T10:00:00Z', '2026-01-10T10:30:00Z'),
  ('b0400000-0000-4000-8000-000000000002', 'unit_generate', 'failed', '{}', 'f4000000-0000-4000-8000-000000000002', '2026-01-10T12:00:00Z', '2026-01-10T12:10:00Z'),
  ('b0400000-0000-4000-8000-000000000003', 'chapter_plan', 'succeeded', '{}', 'f4000000-0000-4000-8000-000000000002', '2026-01-11T09:00:00Z', '2026-01-11T09:05:00Z'),
  ('b0400000-0000-4000-8000-000000000004', 'scheme_ingest', 'cancelled', '{}', 'f4000000-0000-4000-8000-000000000002', '2026-01-11T10:00:00Z', '2026-01-11T10:01:00Z'),
  ('b0400000-0000-4000-8000-000000000005', 'unit_revise', 'queued', '{}', 'f4000000-0000-4000-8000-000000000002', '2026-02-20T00:00:00Z', null);
insert into public.ai_usage (job_id, label, task, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, est_cost_usd, created_at) values
  ('b0400000-0000-4000-8000-000000000001', 'u1', 'authoring', 'm-a', 100, 50, 10, 5, 0.5, '2026-01-10T10:05:00Z'),
  ('b0400000-0000-4000-8000-000000000001', 'u2', 'authoring', 'm-a', 200, 100, 0, 0, 1.5, '2026-01-10T10:10:00Z'),
  ('b0400000-0000-4000-8000-000000000002', 'u3', 'authoring', 'm-b', 10, 10, 0, 0, null, '2026-01-10T12:05:00Z'),
  ('b0400000-0000-4000-8000-000000000003', 'u4', 'authoring', 'm-a', 1000, 500, 100, 50, 2.0, '2026-01-11T09:02:00Z'),
  ('b0400000-0000-4000-8000-000000000004', 'u5', 'authoring', 'm-b', 1, 1, 0, 0, null, '2026-01-11T10:00:30Z'),
  ('b0400000-0000-4000-8000-000000000005', 'u6', 'authoring', 'm-a', 5000, 5000, 0, 0, 9, '2026-02-20T00:05:00Z');

create temp table summ (r jsonb);
grant all on summ to public;

set local role anon;
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', null, 'anon cannot call get_ai_usage_summary'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', 'admin_role_required', 'a reviewer cannot read the usage'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', 'admin_role_required', 'support cannot read the usage'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', 'admin_role_required', 'an ordinary user cannot read the usage'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', 'admin_role_required', 'an analyst at aal1 cannot read the usage'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  '42501', 'admin_role_required', 'a content_editor at aal1 cannot read the usage'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-12T00:00:00Z', '2026-01-10T00:00:00Z')$$,
  '22023', 'invalid_range', 'a window that ends before it starts is refused'
);
select throws_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-10T00:00:00Z')$$,
  '22023', 'invalid_range', 'an empty window is refused'
);
select throws_ok($$select public.get_ai_usage_summary(null, '2026-01-10T00:00:00Z')$$, '22023', 'invalid_range', 'a null start is refused');
select throws_ok($$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', null)$$, '22023', 'invalid_range', 'a null end is refused');
select throws_ok(
  $$select public.get_ai_usage_summary('2025-01-01T00:00:00Z', '2026-01-03T00:00:00Z')$$,
  '22023', 'invalid_range', 'a window over 366 days is refused'
);
select lives_ok(
  $$insert into summ select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  'a super_admin reads the summary of a two-day window'
);
select is(
  (select r -> 'totals' from summ),
  '{"calls":5,"input_tokens":1311,"output_tokens":661,"cache_read_tokens":110,"cache_creation_tokens":55,"est_cost_usd":4.0,"unpriced_calls":2,
    "jobs":{"queued":0,"running":0,"succeeded":2,"failed":1,"cancelled":1}}'::jsonb,
  'totals: calls, the four token sums, the sum of KNOWN costs, the unpriced calls and the jobs by status (rows outside the window left out)'
);
select is(
  (select r -> 'by_day' from summ),
  '[{"day":"2026-01-10","calls":3,"input_tokens":310,"output_tokens":160,"cache_read_tokens":10,"cache_creation_tokens":5,"est_cost_usd":2.0,"unpriced_calls":1},
    {"day":"2026-01-11","calls":2,"input_tokens":1001,"output_tokens":501,"cache_read_tokens":100,"cache_creation_tokens":50,"est_cost_usd":2.0,"unpriced_calls":1}]'::jsonb,
  'by_day: one row per UTC day, in order'
);
select is(
  (select r -> 'by_model' from summ),
  '[{"model":"m-a","calls":3,"input_tokens":1300,"output_tokens":650,"cache_read_tokens":110,"cache_creation_tokens":55,"est_cost_usd":4.0,"unpriced_calls":0},
    {"model":"m-b","calls":2,"input_tokens":11,"output_tokens":11,"cache_read_tokens":0,"cache_creation_tokens":0,"est_cost_usd":null,"unpriced_calls":2}]'::jsonb,
  'by_model: a model whose calls are all unpriced has a NULL cost, not zero'
);
select is(
  (select r -> 'by_kind' from summ),
  '[{"kind":"scheme_ingest","calls":1,"input_tokens":1,"output_tokens":1,"cache_read_tokens":0,"cache_creation_tokens":0,"est_cost_usd":null,"unpriced_calls":1,
     "jobs":{"queued":0,"running":0,"succeeded":0,"failed":0,"cancelled":1}},
    {"kind":"chapter_plan","calls":1,"input_tokens":1000,"output_tokens":500,"cache_read_tokens":100,"cache_creation_tokens":50,"est_cost_usd":2.0,"unpriced_calls":0,
     "jobs":{"queued":0,"running":0,"succeeded":1,"failed":0,"cancelled":0}},
    {"kind":"unit_generate","calls":3,"input_tokens":310,"output_tokens":160,"cache_read_tokens":10,"cache_creation_tokens":5,"est_cost_usd":2.0,"unpriced_calls":1,
     "jobs":{"queued":0,"running":0,"succeeded":1,"failed":1,"cancelled":0}},
    {"kind":"unit_revise","calls":0,"input_tokens":0,"output_tokens":0,"cache_read_tokens":0,"cache_creation_tokens":0,"est_cost_usd":null,"unpriced_calls":0,
     "jobs":{"queued":0,"running":0,"succeeded":0,"failed":0,"cancelled":0}}]'::jsonb,
  'by_kind: the four job kinds in order, with their calls and jobs by status'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  'a content_editor reads the summary'
);
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.get_ai_usage_summary('2026-01-10T00:00:00Z', '2026-01-12T00:00:00Z')$$,
  'an analyst reads the summary'
);
select results_eq(
  $$select r -> 'totals' ->> 'calls', r -> 'totals' ->> 'est_cost_usd', r -> 'by_day', r -> 'by_model', jsonb_array_length(r -> 'by_kind')::text
      from (select public.get_ai_usage_summary('2026-03-01T00:00:00Z', '2026-03-02T00:00:00Z') as r) x$$,
  $$values ('0', null, '[]'::jsonb, '[]'::jsonb, '4')$$,
  'an empty window gives zero calls, a NULL cost, empty lists and the four kinds'
);
select results_eq(
  $$select r -> 'totals' ->> 'est_cost_usd', r -> 'totals' ->> 'unpriced_calls'
      from (select public.get_ai_usage_summary('2026-01-10T12:00:00Z', '2026-01-10T13:00:00Z') as r) x$$,
  $$values (null, '1')$$,
  'a window holding only an unpriced call has a NULL cost (unknown), never zero'
);
reset role;

-- D. the owner's cast facts ----------------------------------------------------------------------------------------------------
select results_eq(
  $$select slug, traits -> 'age_years', traits -> 'age_note', traits -> 'gender', traits -> 'pronouns', traits -> 'personality',
           traits ? 'relationship_note', voice
      from public.characters where slug in ('zari', 'zuri') order by slug$$,
  $$values ('zari', '7'::jsonb, null::jsonb, '"female"'::jsonb, '"she/her"'::jsonb, '[]'::jsonb, false, '{}'::jsonb),
           ('zuri', '4'::jsonb, '"almost 5"'::jsonb, '"male"'::jsonb, '"he/him"'::jsonb, '[]'::jsonb, false, '{}'::jsonb)$$,
  'Zari is 7, female, she/her; Zuri is 4 ("almost 5"), male, he/him; no relationship, no personality, empty voice'
);
select ok(
  (select bool_and(traits ->> 'derived_guidance' ilike 'Derived from age only%' and traits ->> 'derived_guidance' ilike '%not facts about%')
     from public.characters where slug in ('zari', 'zuri')),
  'the guidance is worded as derived from age only (and not as facts about the character)'
);
select is(
  (select bool_and(k in ('age_years', 'age_note', 'gender', 'pronouns', 'personality', 'derived_guidance'))
     from public.characters c, jsonb_object_keys(c.traits) k where c.slug in ('zari', 'zuri')),
  true,
  'nothing else about the characters was invented'
);
-- the migration's own statement, run on top of admin edits: keys survive, edits survive, the owner's facts hold
update public.characters set traits = traits || '{"custom_key":"kept","personality":["curious"],"derived_guidance":"edited by an admin","age_years":99}'::jsonb
 where slug = 'zari';
update public.characters c
   set traits =
         jsonb_build_object('personality', '[]'::jsonb, 'derived_guidance', 'the default guidance')
         || c.traits
         || jsonb_build_object('age_years', 7, 'gender', 'female', 'pronouns', 'she/her')
 where c.slug = 'zari';
select results_eq(
  $$select traits ->> 'custom_key', traits -> 'personality', traits ->> 'derived_guidance', traits -> 'age_years', traits ->> 'gender'
      from public.characters where slug = 'zari'$$,
  $$values ('kept', '["curious"]'::jsonb, 'edited by an admin', '7'::jsonb, 'female')$$,
  'the merge keeps added keys and edited personality / guidance, and restores the owner''s facts'
);
create temp table zari_once as select traits from public.characters where slug = 'zari';
update public.characters c
   set traits =
         jsonb_build_object('personality', '[]'::jsonb, 'derived_guidance', 'the default guidance')
         || c.traits
         || jsonb_build_object('age_years', 7, 'gender', 'female', 'pronouns', 'she/her')
 where c.slug = 'zari';
select is(
  (select traits from public.characters where slug = 'zari'),
  (select traits from zari_once),
  'running it again changes nothing (idempotent)'
);

-- E. the scheme-uploads bucket -------------------------------------------------------------------------------------------------
create temp table st (policies boolean, bucket boolean);
grant all on st to public;
do $$
declare
  v_bucket boolean := false;
begin
  if to_regclass('storage.buckets') is not null then
    execute 'select exists (select 1 from storage.buckets where id = ''scheme-uploads'')' into v_bucket;
  end if;
  insert into pg_temp.st values (
    to_regclass('storage.objects') is not null
      and exists (select 1 from pg_policy where polrelid = to_regclass('storage.objects') and polname = 'scheme_uploads_insert')
      and exists (select 1 from pg_policy where polrelid = to_regclass('storage.objects') and polname = 'scheme_uploads_select'),
    v_bucket
  );
end
$$;

select case when (select bucket from st) then results_eq(
  $$select public, file_size_limit, allowed_mime_types from storage.buckets where id = 'scheme-uploads'$$,
  $$values (false, 20971520::bigint, array['application/pdf',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'text/plain']::text[])$$,
  'the scheme-uploads bucket is private, 20 MiB, PDF / DOCX / plain text only'
) else ok(true, 'skipped: the storage service has not created the bucket') end;

select case when (select policies from st) then results_eq(
  $$select (polname::text collate "default"), case polname::text when 'scheme_uploads_insert' then polcmd = 'a' else polcmd = 'r' end
      from pg_policy where polrelid = 'storage.objects'::regclass and polname like 'scheme_uploads%' order by polname$$,
  $$values ('scheme_uploads_insert', true), ('scheme_uploads_select', true)$$,
  'exactly two policies: insert and select (no update, no delete, no all)'
) else ok(true, 'skipped: the storage policies are not installed on this stack') end;

select case when (select policies from st) then results_eq(
  $$select count(*)::int from pg_policy p
     where p.polrelid = 'storage.objects'::regclass and p.polname like 'scheme_uploads%'
       and (select array_agg(r.rolname::text order by r.rolname) from pg_roles r where r.oid = any (p.polroles)) <> array['authenticated']$$,
  $$values (0)$$,
  'both policies are for authenticated only'
) else ok(true, 'skipped: the storage policies are not installed on this stack') end;

-- as the owner, one object under the reviewer's prefix and one in the packs bucket
select case when (select policies from st) then lives_ok(
  $$insert into storage.objects (bucket_id, name) values
      ('scheme-uploads', 'f4000000-0000-4000-8000-000000000003/reviewer-owned.pdf'),
      ('packs', 'units/x/1/manifest.json')$$,
  'fixture objects (owner)'
) else ok(true, 'skipped') end;

set local role authenticated;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000002/scheme.pdf')$$,
  'a content_editor uploads under their own prefix'
) else ok(true, 'skipped') end;
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000001/stolen.pdf')$$,
  '42501', null, 'but not under somebody else''s prefix'
) else ok(true, 'skipped') end;
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'scheme.pdf')$$,
  '42501', null, 'nor at the root of the bucket'
) else ok(true, 'skipped') end;
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000002x/lookalike.pdf')$$,
  '42501', null, 'nor under a prefix that merely starts like theirs'
) else ok(true, 'skipped') end;
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('packs', 'f4000000-0000-4000-8000-000000000002/scheme.pdf')$$,
  '42501', null, 'nor into another bucket (the policy names the bucket)'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select name from storage.objects where bucket_id = 'scheme-uploads' order by name$$,
  $$values ('f4000000-0000-4000-8000-000000000002/scheme.pdf')$$,
  'the editor reads back only their own object (not the reviewer''s)'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select count(*)::int from storage.objects where bucket_id = 'packs'$$,
  $$values (0)$$,
  'and nothing of the packs bucket'
) else ok(true, 'skipped') end;
-- update and delete: no policy, so nothing changes (storage may also refuse a direct delete outright, which is fine)
do $$
begin
  if (select policies from pg_temp.st) then
    begin
      execute 'with u as (update storage.objects set name = name || ''x'' where bucket_id = ''scheme-uploads'' returning 1) select count(*) from u';
    exception when others then null;
    end;
    begin
      execute 'with d as (delete from storage.objects where bucket_id = ''scheme-uploads'' returning 1) select count(*) from d';
    exception when others then null;
    end;
  end if;
end
$$;
reset role;
select case when (select policies from st) then results_eq(
  $$select name from storage.objects where bucket_id = 'scheme-uploads' and name like 'f4000000-0000-4000-8000-00000000000%' order by name$$,
  $$values ('f4000000-0000-4000-8000-000000000002/scheme.pdf'), ('f4000000-0000-4000-8000-000000000003/reviewer-owned.pdf')$$,
  'a client can neither rename nor delete an uploaded object (no update or delete policy)'
) else ok(true, 'skipped') end;
set local role authenticated;

set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000002/aal1.pdf')$$,
  '42501', null, 'a content_editor at aal1 cannot upload'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select count(*)::int from storage.objects where bucket_id = 'scheme-uploads'$$, $$values (0)$$,
  'nor read'
) else ok(true, 'skipped') end;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000003/new.pdf')$$,
  '42501', null, 'a reviewer cannot upload (only the roles that can start an ingest job)'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select name from storage.objects where bucket_id = 'scheme-uploads' order by name$$,
  $$values ('f4000000-0000-4000-8000-000000000003/reviewer-owned.pdf')$$,
  'but a reviewer reads what sits under their own prefix'
) else ok(true, 'skipped') end;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000004/support.pdf')$$,
  '42501', null, 'support cannot upload'
) else ok(true, 'skipped') end;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000005/analyst.pdf')$$,
  '42501', null, 'an analyst cannot upload'
) else ok(true, 'skipped') end;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000006/plain.pdf')$$,
  '42501', null, 'an ordinary user cannot upload'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select count(*)::int from storage.objects where bucket_id = 'scheme-uploads'$$, $$values (0)$$,
  'and sees nothing in the bucket'
) else ok(true, 'skipped') end;
set local request.jwt.claims = '{"sub":"f4000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select case when (select policies from st) then lives_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000001/sa.pdf')$$,
  'a super_admin uploads under their own prefix'
) else ok(true, 'skipped') end;
select case when (select policies from st) then results_eq(
  $$select name from storage.objects where bucket_id = 'scheme-uploads' order by name$$,
  $$values ('f4000000-0000-4000-8000-000000000001/sa.pdf')$$,
  'and, like everybody else, reads only their own prefix'
) else ok(true, 'skipped') end;
reset role;
set local role anon;
select case when (select policies from st) then throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('scheme-uploads', 'f4000000-0000-4000-8000-000000000002/anon.pdf')$$,
  '42501', null, 'anon cannot upload'
) else ok(true, 'skipped') end;
reset role;

select * from finish();
rollback;
