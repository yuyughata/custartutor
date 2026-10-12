-- 073 pack publishing: write-once pack info on published_units, the admin RPCs the publish-pack edge function
-- uses, authorize_pack_download for the get-pack-download edge function, the "serving" rule between versions, and
-- the private `packs` bucket (no client policy on storage.objects).
begin;
create extension if not exists pgtap with schema extensions;
select plan(55);

-- sa e1..05 super_admin | ed e2..06 content_editor | sup e4..08 support | gA a1..01 guardian | tU c1..03 tutor of hA
-- plain d1..05 belongs to no household
insert into auth.users (id, email) values
  ('e1000000-0000-4000-8000-000000000005', 'sa@test.local'),
  ('e2000000-0000-4000-8000-000000000006', 'ed@test.local'),
  ('e4000000-0000-4000-8000-000000000008', 'sup@test.local'),
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('d1000000-0000-4000-8000-000000000005', 'plain@test.local');
insert into public.admin_users (user_id, role) values
  ('e1000000-0000-4000-8000-000000000005', 'super_admin'),
  ('e2000000-0000-4000-8000-000000000006', 'content_editor'),
  ('e4000000-0000-4000-8000-000000000008', 'support');
insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor');
insert into public.schemes (id, subject_id, level_code, term)
select '5c000000-0000-4000-8000-000000000001', s.id, 'P1', 1 from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4000001-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, kind, title, stage) values
  ('ab000001-0000-4000-8000-000000000001', 'c4000001-0000-4000-8000-000000000001', 1, 'lesson', 'Unit 1', 'absorb'),
  ('ab000002-0000-4000-8000-000000000002', 'c4000001-0000-4000-8000-000000000001', 2, 'lesson', 'Unit 2', 'absorb'),
  ('ab000003-0000-4000-8000-000000000003', 'c4000001-0000-4000-8000-000000000001', 3, 'lesson', 'Unit 3', 'absorb');
insert into public.unit_versions (id, unit_id, version, schema_version, content, status, generated_by) values
  ('f0000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 1, 1, '{"title":"U1 v1"}', 'approved', 'human'),
  ('f0000002-0000-4000-8000-000000000002', 'ab000002-0000-4000-8000-000000000002', 1, 1, '{"title":"U2 v1"}', 'approved', 'human');

create temp table pub (label text primary key, id uuid not null);
grant all on pub to public;

-- publish through the real RPC, as a content editor at aal2 --------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
insert into pub select 'u1v1', public.publish_unit_version('f0000001-0000-4000-8000-000000000001');
insert into pub select 'u2v1', public.publish_unit_version('f0000002-0000-4000-8000-000000000002');
reset role;

select results_eq(
  $$select pack_manifest_path, content_hash, pack_built_at, min_app_version
      from public.published_units where id = (select id from pub where label = 'u1v1')$$,
  $$values (null::text, null::text, null::timestamptz, '1.0.0')$$,
  'a fresh snapshot has no pack info and the default min_app_version'
);

-- get_pack_source: admins at aal2 only -------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select s ->> 'unit_id', (s ->> 'version_no')::int, s -> 'content' ->> 'title', s ->> 'min_app_version',
           (s -> 'pack_manifest_path') = 'null'::jsonb
      from (select public.get_pack_source((select id from pub where label = 'u1v1')) as s) x$$,
  $$values ('ab000001-0000-4000-8000-000000000001', 1, 'U1 v1', '1.0.0', true)$$,
  'a content editor at aal2 reads the snapshot to build a pack from'
);
select throws_ok(
  $$select public.get_pack_source('00000000-0000-4000-8000-000000000000')$$,
  'P0002', 'published_unit_not_found', 'an unknown snapshot is a clean error'
);
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.get_pack_source((select id from pub where label = 'u1v1'))$$,
  '42501', 'admin_role_required', 'a content editor at aal1 cannot read pack sources'
);
set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_pack_source((select id from pub where label = 'u1v1'))$$,
  '42501', 'admin_role_required', 'support cannot read pack sources'
);
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.get_pack_source((select id from pub where label = 'u1v1'))$$,
  '42501', 'admin_role_required', 'a guardian cannot read pack sources'
);

-- nothing is offered before the pack is built ---------------------------------------------------------------------------------------
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  'P0002', 'pack_not_found', 'a published unit without pack info cannot be downloaded'
);
select results_eq(
  $$select jsonb_array_length(v -> 'units'), jsonb_array_length(v -> 'published')
      from (select public.sync_pull(0, 500) as v) x$$,
  $$values (0, 0)$$,
  'a published unit without pack info is invisible to sync_pull'
);

-- set_pack_info: who may call it and what it checks ----------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64))$$,
  '42501', 'admin_role_required', 'an ordinary user cannot set pack info'
);
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64))$$,
  '42501', 'admin_role_required', 'an admin at aal1 cannot set pack info'
);
set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64))$$,
  '42501', 'admin_role_required', 'support cannot set pack info'
);
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000002-0000-4000-8000-000000000002/1/manifest.json', repeat('a', 64))$$,
  '22023', 'invalid_pack_path', 'a manifest path pointing at another unit''s folder is refused'
);
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/../2/manifest.json', repeat('a', 64))$$,
  '22023', 'invalid_pack_path', 'a path with .. is refused'
);
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', 'not-a-hash')$$,
  '22023', 'invalid_content_hash', 'a malformed content hash is refused'
);
select throws_ok(
  $$select public.set_pack_info('00000000-0000-4000-8000-000000000000',
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64))$$,
  'P0002', 'published_unit_not_found', 'an unknown snapshot is a clean error'
);
select results_eq(
  $$select s ->> 'manifest_path', s ->> 'content_hash', (s ->> 'already_set')::boolean
      from (select public.set_pack_info((select id from pub where label = 'u1v1'),
              'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64)) as s) x$$,
  $$values ('units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64), false)$$,
  'a content editor at aal2 switches a built pack on'
);
reset role;
select is(
  (select pack_built_at is not null from public.published_units where id = (select id from pub where label = 'u1v1')),
  true, 'pack_built_at is stamped'
);
create temp table built as
  select pack_built_at from public.published_units where id = (select id from pub where label = 'u1v1');
grant all on built to public;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select (s ->> 'already_set')::boolean, (s ->> 'pack_built_at')::timestamptz = (select pack_built_at from built)
      from (select public.set_pack_info((select id from pub where label = 'u1v1'),
              'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64)) as s) x$$,
  $$values (true, true)$$,
  'repeating the call with the same values is a no-op that reports the original build time'
);
select throws_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v1'),
      'units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('b', 64))$$,
  '22023', 'pack_info_already_set', 'pack info is write-once: a different hash is refused'
);
select throws_ok(
  $$update public.published_units set pack_manifest_path = null$$,
  '42501', null, 'an admin has no UPDATE privilege on published_units'
);
reset role;

-- immutability below the API: even the owner cannot rewrite a snapshot or its pack info ----------------------------------------------------------
select throws_ok(
  $$update public.published_units set content_hash = repeat('f', 64)
     where id = (select id from pub where label = 'u1v1')$$,
  '42501', 'published_units_are_immutable', 'pack info cannot be changed once set, not even by the owner'
);
select throws_ok(
  $$update public.published_units set pack_manifest_path = null, content_hash = null, pack_built_at = null
     where id = (select id from pub where label = 'u1v1')$$,
  '42501', 'published_units_are_immutable', 'pack info cannot be cleared once set'
);
select throws_ok(
  $$update public.published_units set min_app_version = '9.9.9' where id = (select id from pub where label = 'u2v1')$$,
  '42501', 'published_units_are_immutable', 'min_app_version is part of the immutable snapshot'
);
select throws_ok(
  $$update public.published_units set content = '{"title":"rewritten"}' where id = (select id from pub where label = 'u2v1')$$,
  '42501', 'published_units_are_immutable', 'the snapshot content is still immutable'
);
select throws_ok(
  $$update public.published_units set pack_manifest_path = 'units/other/1/manifest.json', content_hash = repeat('a', 64),
           pack_built_at = now() where id = (select id from pub where label = 'u2v1')$$,
  '23514', null, 'the table itself only accepts the canonical manifest path of the row'
);
select throws_ok(
  $$update public.published_units set pack_manifest_path = 'units/ab000002-0000-4000-8000-000000000002/1/manifest.json'
     where id = (select id from pub where label = 'u2v1')$$,
  '23514', null, 'pack info is all-or-nothing (path, hash and build time together)'
);
select throws_ok(
  $$update public.published_units set content_hash = 'ABC', pack_manifest_path = 'units/ab000002-0000-4000-8000-000000000002/1/manifest.json',
           pack_built_at = now() where id = (select id from pub where label = 'u2v1')$$,
  '23514', null, 'the content hash must be a lowercase sha256 hex digest'
);

-- the service role (a CI pack job) may set pack info too ----------------------------------------------------------------------------------------------
set local role service_role;
set local request.jwt.claims = '{"role":"service_role"}';
select lives_ok(
  $$select public.set_pack_info((select id from pub where label = 'u2v1'),
      'units/ab000002-0000-4000-8000-000000000002/1/manifest.json', repeat('d', 64))$$,
  'the service role can switch a pack on'
);
select throws_ok(
  $$update public.published_units set deleted_at = now()$$,
  '42501', null, 'the service role still cannot update published_units directly'
);
reset role;

-- authorize_pack_download ---------------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select s ->> 'manifest_path', s ->> 'content_hash'
      from (select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1) as s) x$$,
  $$values ('units/ab000001-0000-4000-8000-000000000001/1/manifest.json', repeat('a', 64))$$,
  'a guardian gets the manifest path and hash of a built pack'
);
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 2)$$,
  'P0002', 'pack_not_found', 'an unknown version is a clean error'
);
select throws_ok(
  $$select public.authorize_pack_download('ab0000ff-0000-4000-8000-0000000000ff', 1)$$,
  'P0002', 'pack_not_found', 'an unknown unit is a clean error'
);
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 0)$$,
  '22023', 'invalid_pack_request', 'a version below 1 is refused'
);
select throws_ok(
  $$select public.authorize_pack_download(null, 1)$$,
  '22023', 'invalid_pack_request', 'a null unit is refused'
);
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  'a tutor member of a household may download too'
);
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  '42501', 'not_a_household_member', 'a signed-in user outside every household is refused'
);
set local request.jwt.claims = '{}';
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  '42501', 'not_authenticated', 'a call without a session is refused'
);
reset role;
set local role anon;
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  '42501', null, 'anon cannot call authorize_pack_download'
);
reset role;

-- built packs are visible to sync_pull ------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select jsonb_array_length(v -> 'units'), jsonb_array_length(v -> 'published')
      from (select public.sync_pull(0, 500) as v) x$$,
  $$values (2, 2)$$,
  'once built, both units and their pack rows are sent'
);
reset role;

-- a new version: the built one keeps serving until the new pack exists ----------------------------------------------------------------------------------------
insert into public.unit_versions (id, unit_id, version, schema_version, content, status, generated_by) values
  ('f0000003-0000-4000-8000-000000000003', 'ab000001-0000-4000-8000-000000000001', 2, 1, '{"title":"U1 v2"}', 'approved', 'human');
create temp table cur (v bigint);
grant all on cur to public;
insert into cur select max(sync_seq) from public.published_units;
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
insert into pub select 'u1v2', public.publish_unit_version('f0000003-0000-4000-8000-000000000003');
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  'version 1 still serves while version 2 has no pack'
);
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 2)$$,
  'P0002', 'pack_not_found', 'version 2 cannot be downloaded before its pack is built'
);
select results_eq(
  $$select t.obj ->> 'version_no', t.obj ->> 'deleted_at' is null
      from public.sync_pull((select v from cur), 500) p,
           lateral jsonb_array_elements(p -> 'published') as t(obj)$$,
  $$values ('1', true)$$,
  'no tombstone for version 1 and no row for version 2 while version 2 is not built'
);
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.set_pack_info((select id from pub where label = 'u1v2'),
      'units/ab000001-0000-4000-8000-000000000001/2/manifest.json', repeat('e', 64))$$,
  'version 2 is built'
);
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 2)$$,
  'version 2 can be downloaded once built'
);
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 1)$$,
  'P0002', 'pack_not_found', 'version 1 no longer serves once version 2 is built'
);
select results_eq(
  $$select t.obj ->> 'version_no', t.obj ->> 'deleted_at' is null
      from public.sync_pull((select v from cur), 500) p,
           lateral jsonb_array_elements(p -> 'published') as t(obj) order by (t.obj ->> 'version_no')::int$$,
  $$values ('1', false), ('2', true)$$,
  'sync_pull sends version 2 live and version 1 as a tombstone'
);
reset role;
update public.published_units set is_current = false, deleted_at = now() where unit_id = 'ab000001-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.authorize_pack_download('ab000001-0000-4000-8000-000000000001', 2)$$,
  'P0002', 'pack_not_found', 'an unpublished (tombstoned) version cannot be downloaded'
);
reset role;

-- the private bucket ------------------------------------------------------------------------------------------------------------------------------------------------------
select ok(
  coalesce((select not public from storage.buckets where id = 'packs'), true),
  'the packs bucket is private (when the storage service has created it)'
);
select ok(
  coalesce((select file_size_limit between 1 and 52428800 from storage.buckets where id = 'packs'), true),
  'the packs bucket has a file size limit of at most 50 MB'
);
select ok(
  coalesce((select 'application/json' = any (allowed_mime_types) and not ('text/html' = any (allowed_mime_types))
              from storage.buckets where id = 'packs'), true),
  'the packs bucket only allows JSON, images and audio'
);
select is(
  (select relrowsecurity from pg_class where oid = 'storage.objects'::regclass),
  true, 'row level security is on for storage.objects'
);
select is(
  (select count(*)::int from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and (roles && array['public', 'anon', 'authenticated']::name[])
      and (coalesce(qual, '') || ' ' || coalesce(with_check, '') ~ 'packs'
           or coalesce(qual, '') || ' ' || coalesce(with_check, '') !~ 'bucket_id')),
  0,
  'no client policy on storage.objects touches the packs bucket (and none is unscoped): only the service role reads or writes it'
);
insert into storage.objects (bucket_id, name)
select 'packs', 'units/ab000001-0000-4000-8000-000000000001/1/manifest.json'
 where exists (select 1 from storage.buckets where id = 'packs');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from storage.objects where bucket_id = 'packs'),
  0,
  'a guardian cannot list or read objects of the packs bucket'
);
select throws_ok(
  $$insert into storage.objects (bucket_id, name) values ('packs', 'units/evil/1/manifest.json')$$,
  '42501', null, 'a guardian cannot upload to the packs bucket'
);
reset role;
set local role anon;
select is(
  (select count(*)::int from storage.objects where bucket_id = 'packs'),
  0,
  'anon cannot read objects of the packs bucket'
);
reset role;

select * from finish();
rollback;
