-- 072 sync_pull: one page of changes for the learner app (wire.ts PullResponse).
--   Scope = the caller's primary guardian household (no leak across households), tombstones, paging and
--   has_more, cursor monotonicity, flattened units, pack-info gating, epoch, and the ordering assumptions of
--   the sync cursor that can be checked inside one session (writers draw sync_seq under one global lock;
--   readers use one snapshot).
begin;
create extension if not exists pgtap with schema extensions;
select plan(52);

-- gA a1..01 guardian of hA | gB b1..02 guardian of hB | tU c1..03 tutor of hA | out d1..05 no household
-- gC e1..06 guardian of hC (since January) and hD (since June)
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('d1000000-0000-4000-8000-000000000005', 'out@test.local'),
  ('e1000000-0000-4000-8000-000000000006', 'gc@test.local');
insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'Household C', 'e1000000-0000-4000-8000-000000000006'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'Household D', 'e1000000-0000-4000-8000-000000000006');
insert into public.household_members (household_id, user_id, role, created_at) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian', '2026-03-01'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian', '2026-03-01'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor', '2026-03-01'),
  ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', 'e1000000-0000-4000-8000-000000000006', 'guardian', '2026-06-01'),
  ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'e1000000-0000-4000-8000-000000000006', 'guardian', '2026-01-01');
insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1'),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P2'),
  ('cb000001-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P3');
insert into public.schemes (id, subject_id, level_code, term)
select '5c000000-0000-4000-8000-000000000001', s.id, 'P1', 1 from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4000001-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, kind, title, stage) values
  ('ab000001-0000-4000-8000-000000000001', 'c4000001-0000-4000-8000-000000000001', 1, 'lesson', 'Unit 1', 'absorb'),
  ('ab000002-0000-4000-8000-000000000002', 'c4000001-0000-4000-8000-000000000001', 2, 'lesson', 'Unit 2', 'absorb'),
  ('ab000003-0000-4000-8000-000000000003', 'c4000001-0000-4000-8000-000000000001', 3, 'lesson', 'Unit 3', 'absorb');
insert into public.unit_versions (id, unit_id, version, schema_version, content, status, generated_by) values
  ('f0000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 1, 1, '{"x":1}', 'published', 'human'),
  ('f0000002-0000-4000-8000-000000000002', 'ab000002-0000-4000-8000-000000000002', 1, 1, '{"x":2}', 'published', 'human'),
  ('f0000003-0000-4000-8000-000000000003', 'ab000001-0000-4000-8000-000000000001', 2, 1, '{"x":3}', 'published', 'human');
insert into public.published_units (id, unit_id, unit_version_id, version_no, schema_version, content, is_current) values
  ('9a000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 'f0000001-0000-4000-8000-000000000001', 1, 1, '{"x":1}', true),
  ('9a000002-0000-4000-8000-000000000002', 'ab000002-0000-4000-8000-000000000002', 'f0000002-0000-4000-8000-000000000002', 1, 1, '{"x":2}', true);
-- unit 1 v1 has a built pack; unit 2 is published but its pack is not built yet
set local request.jwt.claims = '{"role":"service_role"}';
select private.set_pack_info('9a000001-0000-4000-8000-000000000001',
  'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64));
set local request.jwt.claims = '{}';

-- helpers (rolled back with the test)
create function public.trows(j jsonb) returns table (src text, obj jsonb) language sql immutable as $$
  select k, e from unnest(array['children', 'subjects', 'units', 'published', 'unit_progress']) as k,
         lateral jsonb_array_elements(j -> k) as e;
$$;
create function public.tseqs(j jsonb) returns bigint[] language sql immutable as $$
  select coalesce(array_agg((obj ->> 'sync_seq')::bigint order by (obj ->> 'sync_seq')::bigint), '{}')
    from public.trows(j);
$$;
create function public.tpages(lim int) returns jsonb language plpgsql as $$
declare cur bigint := 0; page jsonb; pages jsonb := '[]'; n int := 0;
begin
  loop
    page := public.sync_pull(cur, lim);
    pages := pages || jsonb_build_array(page);
    cur := (page ->> 'next_seq')::bigint;
    n := n + 1;
    exit when not (page ->> 'has_more')::boolean or n > 200;
  end loop;
  return pages;
end $$;
grant execute on function public.trows(jsonb), public.tseqs(jsonb), public.tpages(int) to public;
create temp table pl (k text primary key, v jsonb);
create temp table cur (k text primary key, v bigint);
grant all on pl, cur to public;

-- guardian A: the first pull, with progress -----------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select public.ingest_progress_events(jsonb_build_array(
  jsonb_build_object('client_event_id', 'e0000000-0000-4000-8000-000000000001', 'child_id', 'ca000001-0000-4000-8000-000000000001',
    'device_id', 'd', 'device_seq', 1, 'unit_id', 'ab000001-0000-4000-8000-000000000001',
    'occurred_at', '2026-10-12T10:00:00Z', 'event_type', 'unit_started', 'payload', '{}'::jsonb),
  jsonb_build_object('client_event_id', 'e0000000-0000-4000-8000-000000000002', 'child_id', 'ca000001-0000-4000-8000-000000000001',
    'device_id', 'd', 'device_seq', 2, 'unit_id', 'ab000001-0000-4000-8000-000000000001',
    'occurred_at', '2026-10-12T10:01:00Z', 'event_type', 'section_completed', 'payload', '{"section_id":"s1"}'::jsonb),
  jsonb_build_object('client_event_id', 'e0000000-0000-4000-8000-000000000003', 'child_id', 'ca000001-0000-4000-8000-000000000001',
    'device_id', 'd', 'device_seq', 3, 'unit_id', 'ab000001-0000-4000-8000-000000000001',
    'occurred_at', '2026-10-12T10:02:00Z', 'event_type', 'mastery_check_completed',
    'payload', '{"score":0.5,"passed":false,"question_count":4,"version_no":1}'::jsonb),
  jsonb_build_object('client_event_id', 'e0000000-0000-4000-8000-000000000004', 'child_id', 'ca000002-0000-4000-8000-000000000002',
    'device_id', 'd', 'device_seq', 4, 'unit_id', 'ab000001-0000-4000-8000-000000000001',
    'occurred_at', '2026-10-12T10:03:00Z', 'event_type', 'unit_started', 'payload', '{}'::jsonb)
));
insert into pl select 'a0', public.sync_pull(0, 500);
insert into cur select 'a0', (v ->> 'next_seq')::bigint from pl where k = 'a0';

select is(
  (select array_agg(f.name order by f.name) from pl cross join lateral jsonb_object_keys(pl.v) as f(name) where pl.k = 'a0'),
  array['children', 'epoch', 'has_more', 'household', 'next_seq', 'published', 'server_time', 'subjects',
        'unit_progress', 'units'],
  'the response has exactly the PullResponse fields'
);
select is(
  (select v -> 'household' from pl where k = 'a0'),
  '{"id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","name":"Household A"}'::jsonb,
  'the household of the caller is sent'
);
select is(
  (select (v ->> 'epoch')::int from pl where k = 'a0'),
  (select membership_epoch from public.households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  'epoch is the household''s membership epoch'
);
select is(
  (select array_agg(obj ->> 'display_alias' order by obj ->> 'display_alias') from pl, public.trows(pl.v) t
    where pl.k = 'a0' and t.src = 'children'),
  array['Ada', 'Bayo'],
  'the children of the caller''s household, and no one else''s'
);
select is(
  (select array_agg(f.name order by f.name) from pl, public.trows(pl.v) t, jsonb_object_keys(t.obj) as f(name)
    where pl.k = 'a0' and t.src = 'children' and t.obj ->> 'display_alias' = 'Ada'),
  array['avatar', 'daily_limit_min', 'deleted_at', 'display_alias', 'household_id', 'id', 'level_code',
        'reading_mode', 'sync_seq'],
  'a child row has exactly the ChildRow fields'
);
select is(
  (select count(*)::int from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'subjects'),
  12, 'all subjects are sent'
);
select results_eq(
  $$select t.obj ->> 'slug', t.obj ->> 'curriculum_source', t.obj ->> 'kind', t.obj ->> 'deleted_at'
      from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'subjects' and t.obj ->> 'slug' = 'mathematics'$$,
  $$values ('mathematics', 'nerdc', 'core', null)$$,
  'a subject row carries its slug, source and kind'
);
select is(
  (select count(*)::int from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'units'),
  1,
  'only units with a built pack are sent (unit 2 is published but its pack is not built; unit 3 is not published)'
);
select results_eq(
  $$select t.obj ->> 'chapter_number', t.obj ->> 'chapter_title', t.obj ->> 'unit_no', t.obj ->> 'week_no',
           t.obj ->> 'kind', t.obj ->> 'title', t.obj ->> 'stage', t.obj ->> 'level_code', t.obj ->> 'term',
           t.obj ->> 'deleted_at', (t.obj ->> 'subject_id')::uuid = (select id from public.subjects where slug = 'mathematics')
      from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'units'$$,
  $$values ('1', 'Chapter 1', '1', null, 'lesson', 'Unit 1', 'absorb', 'P1', '1', null, true)$$,
  'the unit is flattened: chapter number/title, subject, level and term come from the chapter and scheme'
);
select results_eq(
  $$select t.obj ->> 'unit_id', t.obj ->> 'version_no', t.obj ->> 'schema_version', t.obj ->> 'min_app_version',
           t.obj ->> 'content_hash', t.obj ->> 'pack_manifest_path', t.obj ->> 'deleted_at'
      from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'published'$$,
  $$values ('ab000001-0000-4000-8000-000000000001', '1', '1', '1.0.0', repeat('a', 64),
            'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', null)$$,
  'the built pack row is sent with its manifest path and content hash'
);
select results_eq(
  $$select t.obj ->> 'child_id', t.obj ->> 'status', (t.obj ->> 'mastery_score')::numeric, (t.obj ->> 'attempts')::int,
           t.obj ->> 'last_section', t.obj ->> 'updated_at', t.obj ->> 'deleted_at'
      from pl, public.trows(pl.v) t
     where pl.k = 'a0' and t.src = 'unit_progress' and t.obj ->> 'child_id' = 'ca000001-0000-4000-8000-000000000001'$$,
  $$values ('ca000001-0000-4000-8000-000000000001', 'in_progress', 0.5, 1, 's1', '2026-10-12T10:02:00.000Z', null)$$,
  'derived progress is sent with an ISO timestamp'
);
select is(
  (select jsonb_typeof(t.obj -> 'mastery_score') || ',' || jsonb_typeof(t.obj -> 'sync_seq')
     from pl, public.trows(pl.v) t where pl.k = 'a0' and t.src = 'unit_progress' limit 1),
  'number,number',
  'scores and sync_seq are JSON numbers'
);
select is(
  (select count(*)::int from pl, public.trows(pl.v) t, jsonb_each_text(t.obj) f
    where pl.k = 'a0' and f.key in ('deleted_at', 'updated_at') and f.value is not null
      and f.value !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$'),
  0,
  'every timestamp is ISO 8601 UTC with milliseconds'
);
select matches(
  (select v ->> 'server_time' from pl where k = 'a0'),
  '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$',
  'server_time is an ISO timestamp'
);
select is(
  (select (v ->> 'next_seq')::bigint = (select max(s) from unnest(public.tseqs(v)) s) and not (v ->> 'has_more')::boolean
     from pl where k = 'a0'),
  true,
  'a complete page: next_seq is its greatest sync_seq and has_more is false'
);
select is(
  (select count(*)::int from pl, public.trows(pl.v) t where pl.k = 'a0' and t.obj::text like '%cb000001%'),
  0,
  'nothing of household B appears in household A''s pull'
);

-- isolation: other callers ---------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
insert into pl select 'b0', public.sync_pull(0, 500);
select is(
  (select array_agg(obj ->> 'display_alias') from pl, public.trows(pl.v) t where pl.k = 'b0' and t.src = 'children'),
  array['Chidi'],
  'guardian B receives only household B''s child'
);
select is(
  (select v::text !~ 'ca000001|ca000002|Household A' from pl where k = 'b0'),
  true,
  'nothing of household A (children, progress, name) leaks into household B''s pull'
);
select is(
  (select count(*)::int from pl, public.trows(pl.v) t where pl.k = 'b0' and t.src = 'unit_progress'),
  0, 'guardian B receives no progress of household A'
);
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
insert into pl select 'o0', public.sync_pull(0, 500);
select results_eq(
  $$select (v ->> 'epoch')::int, jsonb_typeof(v -> 'household'), jsonb_array_length(v -> 'children'),
           jsonb_array_length(v -> 'unit_progress'), jsonb_array_length(v -> 'subjects'),
           jsonb_array_length(v -> 'units'), jsonb_array_length(v -> 'published')
      from pl where k = 'o0'$$,
  $$values (0, 'null', 0, 0, 12, 1, 1)$$,
  'a caller without a household gets epoch 0, household null and only the global curriculum'
);
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
insert into pl select 't0', public.sync_pull(0, 500);
select results_eq(
  $$select (v ->> 'epoch')::int, jsonb_typeof(v -> 'household'), jsonb_array_length(v -> 'children'),
           jsonb_array_length(v -> 'unit_progress')
      from pl where k = 't0'$$,
  $$values (0, 'null', 0, 0)$$,
  'a tutor (no guardian membership) gets no household data'
);
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select is(
  (select (public.sync_pull(0, 1)) -> 'household' ->> 'name'),
  'Household C',
  'with several households the primary one is the earliest active guardian membership'
);

-- paging ----------------------------------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
insert into pl select 'pages', public.tpages(3);
select cmp_ok(
  (select jsonb_array_length(v) from pl where k = 'pages'), '>=', 6,
  'a small limit splits the pull into several pages'
);
select is(
  (select max(jsonb_array_length(p -> 'children') + jsonb_array_length(p -> 'subjects') + jsonb_array_length(p -> 'units')
              + jsonb_array_length(p -> 'published') + jsonb_array_length(p -> 'unit_progress'))
     from pl, jsonb_array_elements(pl.v) p where pl.k = 'pages'),
  3,
  'no page holds more rows than the limit'
);
select is(
  (select array_agg(s order by s) from pl, jsonb_array_elements(pl.v) p, unnest(public.tseqs(p)) s where pl.k = 'pages'),
  (select public.tseqs(v) from pl where k = 'a0'),
  'following the cursor through small pages yields exactly the rows of one big page, each once'
);
select is(
  (select bool_and((p ->> 'next_seq')::bigint > coalesce(lag_next, 0))
     from (select p, lag((p ->> 'next_seq')::bigint) over (order by o) as lag_next
             from pl, jsonb_array_elements(pl.v) with ordinality as t(p, o) where pl.k = 'pages') x),
  true,
  'next_seq grows with every non-final page (the cursor is monotonic)'
);
select is(
  (select (v -> -1 ->> 'has_more')::boolean from pl where k = 'pages'),
  false, 'the last page says has_more = false'
);
select is(
  (select bool_and((p ->> 'has_more')::boolean) from pl, jsonb_array_elements(pl.v) with ordinality as t(p, o)
    where pl.k = 'pages' and o < jsonb_array_length(pl.v)),
  true, 'every page but the last says has_more = true'
);
select results_eq(
  $$select (public.sync_pull(0, n) ->> 'has_more')::boolean from (select cardinality(public.tseqs(v)) as n from pl where k = 'a0') x$$,
  $$values (false)$$,
  'a limit equal to the number of rows left reports has_more = false'
);
select results_eq(
  $$select (public.sync_pull(0, n - 1) ->> 'has_more')::boolean from (select cardinality(public.tseqs(v)) as n from pl where k = 'a0') x$$,
  $$values (true)$$,
  'one row less than that reports has_more = true'
);
select is(
  cardinality(public.tseqs(public.sync_pull(0, 100000))),
  cardinality(public.tseqs((select v from pl where k = 'a0'))),
  'a huge limit is clamped (no error, at most 500 rows)'
);
select is(
  cardinality(public.tseqs(public.sync_pull(0, 0))), 1,
  'a limit below 1 is raised to 1'
);
select results_eq(
  $$select (v ->> 'next_seq')::bigint = (select v from cur where k = 'a0'),
           (v ->> 'has_more')::boolean, cardinality(public.tseqs(v)), (v ->> 'epoch')::int > 0
      from (select public.sync_pull((select v from cur where k = 'a0'), 500) as v) x$$,
  $$values (true, false, 0, true)$$,
  'at the end of the log the page is empty, next_seq stays and has_more is false ("up to date")'
);
select throws_ok($$select public.sync_pull(-1, 10)$$, '22023', 'invalid_cursor', 'a negative cursor is a clean error');
select throws_ok($$select public.sync_pull(null, 10)$$, '22023', 'invalid_cursor', 'a null cursor is a clean error');

-- tombstones and re-stamping ---------------------------------------------------------------------------------------------------------------
reset role;
-- 1. a child is soft-deleted: it arrives as a tombstone, its progress stops being sent, the epoch changes
update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
insert into pl select 'd1', public.sync_pull((select v from cur where k = 'a0'), 500);
select results_eq(
  $$select t.src, t.obj ->> 'display_alias', t.obj ->> 'deleted_at' is not null
      from pl, public.trows(pl.v) t where pl.k = 'd1'$$,
  $$values ('children', 'Bayo', true)$$,
  'a soft-deleted child is sent as a tombstone (and nothing else changed)'
);
select isnt(
  (select (v ->> 'epoch')::int from pl where k = 'd1'), (select (v ->> 'epoch')::int from pl where k = 'a0'),
  'the epoch changed with the deletion, so a device purges and re-pulls'
);
select is(
  (select count(*)::int from public.sync_pull(0, 500) v, public.trows(v) t
    where t.src = 'unit_progress' and t.obj ->> 'child_id' = 'ca000002-0000-4000-8000-000000000002'),
  0,
  'a full re-pull no longer contains the deleted child''s progress'
);
update cur set v = (select (v ->> 'next_seq')::bigint from pl where k = 'd1') where k = 'a0';

-- 2. a subject is deactivated, a chapter is renamed, a scheme changes term: tombstone / re-stamped units
reset role;
update public.subjects set active = false where slug = 'french';
update public.chapters set title = 'Chapter One' where id = 'c4000001-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
insert into pl select 'd2', public.sync_pull((select v from cur where k = 'a0'), 500);
select results_eq(
  $$select t.src, t.obj ->> 'slug', t.obj ->> 'deleted_at' is not null
      from pl, public.trows(pl.v) t where pl.k = 'd2' and t.src = 'subjects'$$,
  $$values ('subjects', 'french', true)$$,
  'a deactivated subject is sent as a tombstone'
);
select results_eq(
  $$select t.src, t.obj ->> 'chapter_title', t.obj ->> 'deleted_at'
      from pl, public.trows(pl.v) t where pl.k = 'd2' and t.src = 'units'$$,
  $$values ('units', 'Chapter One', null)$$,
  'renaming a chapter re-stamps its units, which are re-sent with the new chapter title'
);
update cur set v = (select (v ->> 'next_seq')::bigint from pl where k = 'd2') where k = 'a0';
reset role;
update public.schemes set term = 2 where id = '5c000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select t.obj ->> 'term', t.obj ->> 'level_code'
      from public.sync_pull((select v from cur where k = 'a0'), 500) v, public.trows(v) t where t.src = 'units'$$,
  $$values ('2', 'P1')$$,
  'changing the scheme re-stamps its units with the new term'
);

-- 3. pack gating and versions: a pack is invisible until built; a superseded version is a tombstone only once its successor is built
reset role;
update cur set v = (select max(sync_seq) from public.published_units) where k = 'a0';
update cur set v = greatest(v, (select max(sync_seq) from public.units)) where k = 'a0';
set local request.jwt.claims = '{"role":"service_role"}';
select private.set_pack_info('9a000002-0000-4000-8000-000000000002',
  'units/ab000002-0000-4000-8000-000000000002/1/manifest.json', repeat('b', 64));
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
set local role authenticated;
select results_eq(
  $$select t.src, t.obj ->> 'deleted_at' is null
      from public.sync_pull((select v from cur where k = 'a0'), 500) v, public.trows(v) t
     where t.src in ('units', 'published') order by t.src$$,
  $$values ('published', true), ('units', true)$$,
  'building the pack of unit 2 makes the unit and its pack row appear'
);
reset role;
-- version 2 of unit 1 is published (v1 stops being current) but not built yet
update cur set v = (select max(sync_seq) from public.published_units) where k = 'a0';
update public.published_units set is_current = false where id = '9a000001-0000-4000-8000-000000000001';
insert into public.published_units (id, unit_id, unit_version_id, version_no, schema_version, content, is_current) values
  ('9a000003-0000-4000-8000-000000000003', 'ab000001-0000-4000-8000-000000000001',
   'f0000003-0000-4000-8000-000000000003', 2, 1, '{"x":3}', true);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select t.obj ->> 'version_no', t.obj ->> 'deleted_at' is null
      from public.sync_pull((select v from cur where k = 'a0'), 500) v, public.trows(v) t where t.src = 'published'$$,
  $$values ('1', true)$$,
  'while version 2 is not built, version 1 keeps serving (still live) and version 2 is invisible'
);
reset role;
update cur set v = (select max(sync_seq) from public.published_units) where k = 'a0';
set local request.jwt.claims = '{"role":"service_role"}';
select private.set_pack_info('9a000003-0000-4000-8000-000000000003',
  'units/ab000001-0000-4000-8000-000000000001/2/manifest.json', repeat('c', 64));
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select t.obj ->> 'version_no', t.obj ->> 'deleted_at' is null
      from public.sync_pull((select v from cur where k = 'a0'), 500) v, public.trows(v) t
     where t.src = 'published' order by (t.obj ->> 'version_no')::int$$,
  $$values ('1', false), ('2', true)$$,
  'once version 2 is built it is sent live and version 1 is sent as a tombstone'
);
reset role;

-- 4. unpublishing: the pack row and the unit become tombstones
update cur set v = (select max(sync_seq) from public.published_units) where k = 'a0';
update public.published_units set is_current = false, deleted_at = now() where unit_id = 'ab000001-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select t.src, count(*)::int, bool_and(t.obj ->> 'deleted_at' is not null)
      from public.sync_pull((select v from cur where k = 'a0'), 500) v, public.trows(v) t
     where t.src in ('published', 'units') group by t.src order by t.src$$,
  $$values ('published', 2, true), ('units', 1, true)$$,
  'unpublishing a unit sends its pack rows and the unit as tombstones'
);
reset role;

-- the ordering assumptions of the cursor, as far as one session can check them ------------------------------------------------------------------
create temp table sq (k text primary key, v bigint not null);
grant all on sq to public;
update public.subjects set sort = sort where slug = 'ict';
insert into sq select 's1', sync_seq from public.subjects where slug = 'ict';
update public.children set display_alias = 'Adaora' where id = 'ca000001-0000-4000-8000-000000000001';
insert into sq select 's2', sync_seq from public.children where id = 'ca000001-0000-4000-8000-000000000001';
update public.chapters set title = 'Chapter 1 again' where id = 'c4000001-0000-4000-8000-000000000001';
insert into sq select 's3', max(sync_seq) from public.units where chapter_id = 'c4000001-0000-4000-8000-000000000001';
update public.household_members set role = role where user_id = 'c1000000-0000-4000-8000-000000000003';
insert into sq select 's4', sync_seq from public.household_members where user_id = 'c1000000-0000-4000-8000-000000000003';
select ok(
  (select (select v from sq where k = 's1') < (select v from sq where k = 's2')
      and (select v from sq where k = 's2') < (select v from sq where k = 's3')
      and (select v from sq where k = 's3') < (select v from sq where k = 's4')),
  'writes to different syncable tables in one transaction draw strictly increasing sync_seq values'
);
select is(
  (select count(*)::int from pg_locks l
    where l.locktype = 'advisory' and l.pid = pg_backend_pid() and l.granted and l.mode = 'ExclusiveLock'
      and (l.classid::bigint << 32) + l.objid::bigint = 1543551832891593539),
  1,
  'a transaction that stamped a sync_seq holds the global sync lock until it ends (draw order = commit order)'
);
select ok(
  (select position('sync_lock' in prosrc) > 0 and position('sync_lock' in prosrc) < position('nextval' in prosrc)
     from pg_proc where oid = 'private.set_sync_seq()'::regprocedure),
  'set_sync_seq takes the lock BEFORE it draws the number'
);
select ok(
  (select position('pg_advisory_xact_lock' in prosrc) > 0 from pg_proc where oid = 'private.sync_lock()'::regprocedure),
  'the sync lock is a transaction-level advisory lock (released at commit or rollback, never earlier)'
);
select is(
  (select count(*)::int from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where p.proname = 'set_sync_seq' and not t.tgisinternal and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2
      and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16),
  9,
  'all nine syncable tables stamp sync_seq in a BEFORE INSERT OR UPDATE trigger'
);
select is(
  (select array_agg(p.provolatile order by p.oid::regprocedure::text)
     from pg_proc p where p.oid in ('private.sync_pull(bigint,int)'::regprocedure, 'public.sync_pull(bigint,int)'::regprocedure)),
  array['s', 's']::"char"[],
  'sync_pull (wrapper and implementation) is STABLE: all its statements read one snapshot'
);
select is(
  (select provolatile from pg_proc where oid = 'private.ingest_progress_events(jsonb)'::regprocedure),
  'v'::"char",
  'ingest_progress_events is VOLATILE (each statement sees the events committed before the sync lock was granted)'
);

select * from finish();
rollback;
