-- 050 curriculum, drafts and publishing.
--   drafts (unit_versions) are invisible to non-admins and to admins at aal1; the review workflow is
--   enforced below RLS; publish_unit_version needs an admin at aal2 and an approved version in a
--   chapter of 3-5 units; snapshots are immutable and exactly one is current per unit.
begin;
create extension if not exists pgtap with schema extensions;
select plan(64);

-- plain d1..05 | sa e1..05 super_admin | ed e2..06 content_editor | rv e3..07 reviewer | sup e4..08 | ana e5..09
insert into auth.users (id, email) values
  ('d1000000-0000-4000-8000-000000000005', 'plain@test.local'),
  ('e1000000-0000-4000-8000-000000000005', 'sa@test.local'),
  ('e2000000-0000-4000-8000-000000000006', 'ed@test.local'),
  ('e3000000-0000-4000-8000-000000000007', 'rv@test.local'),
  ('e4000000-0000-4000-8000-000000000008', 'sup@test.local'),
  ('e5000000-0000-4000-8000-000000000009', 'ana@test.local');
insert into public.admin_users (user_id, role) values
  ('e1000000-0000-4000-8000-000000000005', 'super_admin'),
  ('e2000000-0000-4000-8000-000000000006', 'content_editor'),
  ('e3000000-0000-4000-8000-000000000007', 'reviewer'),
  ('e4000000-0000-4000-8000-000000000008', 'support'),
  ('e5000000-0000-4000-8000-000000000009', 'analyst');

-- one scheme, three chapters: ch1 has 3 units (valid), ch2 has 2 (too few), ch3 has 6 (too many)
insert into public.schemes (id, subject_id, level_code, term)
select '5c000000-0000-4000-8000-000000000001', s.id, 'P1', 1 from public.subjects s where s.slug = 'mathematics';
insert into public.chapters (id, scheme_id, number, title) values
  ('c4000001-0000-4000-8000-000000000001', '5c000000-0000-4000-8000-000000000001', 1, 'Chapter 1'),
  ('c4000002-0000-4000-8000-000000000002', '5c000000-0000-4000-8000-000000000001', 2, 'Chapter 2'),
  ('c4000003-0000-4000-8000-000000000003', '5c000000-0000-4000-8000-000000000001', 3, 'Chapter 3');
insert into public.units (id, chapter_id, unit_no, kind, title, stage) values
  ('ab000001-0000-4000-8000-000000000001', 'c4000001-0000-4000-8000-000000000001', 1, 'lesson', 'Unit 1', 'absorb'),
  ('ab000002-0000-4000-8000-000000000002', 'c4000001-0000-4000-8000-000000000001', 2, 'lesson', 'Unit 2', 'absorb'),
  ('ab000003-0000-4000-8000-000000000003', 'c4000001-0000-4000-8000-000000000001', 3, 'lesson', 'Unit 3', 'absorb'),
  ('ab000004-0000-4000-8000-000000000004', 'c4000002-0000-4000-8000-000000000002', 1, 'lesson', 'Unit 4', 'absorb'),
  ('ab000005-0000-4000-8000-000000000005', 'c4000002-0000-4000-8000-000000000002', 2, 'lesson', 'Unit 5', 'absorb');
insert into public.units (id, chapter_id, unit_no, kind, title, stage)
select ('ab0000' || lpad((10 + g)::text, 2, '0') || '-0000-4000-8000-0000000000' || lpad((10 + g)::text, 2, '0'))::uuid,
       'c4000003-0000-4000-8000-000000000003', g, 'lesson', 'Unit 6.' || g, 'absorb'
  from generate_series(1, 6) g;

insert into public.unit_versions (id, unit_id, version, schema_version, content, status, generated_by, lint_report) values
  ('f0000001-0000-4000-8000-000000000001', 'ab000001-0000-4000-8000-000000000001', 1, 1, '{"title":"U1 v1"}', 'approved', 'ai', '{"errors":[]}'),
  ('f0000002-0000-4000-8000-000000000002', 'ab000001-0000-4000-8000-000000000001', 2, 1, '{"title":"U1 v2"}', 'approved', 'ai', '{"errors":[]}'),
  ('f0000003-0000-4000-8000-000000000003', 'ab000002-0000-4000-8000-000000000002', 1, 1, '{"secret":"draft-only"}', 'draft', 'ai', '{"errors":["x"]}'),
  ('f0000004-0000-4000-8000-000000000004', 'ab000003-0000-4000-8000-000000000003', 1, 1, '{"x":1}', 'draft', 'ai', null),
  ('f0000005-0000-4000-8000-000000000005', 'ab000003-0000-4000-8000-000000000003', 2, 1, '{}', 'approved', 'ai', null),
  ('f0000006-0000-4000-8000-000000000006', 'ab000004-0000-4000-8000-000000000004', 1, 1, '{"title":"U4"}', 'approved', 'ai', null),
  ('f0000007-0000-4000-8000-000000000007', 'ab000011-0000-4000-8000-000000000011', 1, 1, '{"title":"U6.1"}', 'approved', 'ai', null);

create temp table pub (label text primary key, id uuid not null);
grant all on pub to public;

-- visibility of drafts and planning data ------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.unit_versions), 0, 'an ordinary user cannot read drafts or lint reports');

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.unit_versions), 0, 'a content_editor at aal1 cannot read drafts');

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.unit_versions), 7, 'a content_editor at aal2 reads drafts');

set local request.jwt.claims = '{"sub":"e3000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.unit_versions), 7, 'a reviewer at aal2 reads drafts');

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.unit_versions), 0, 'support (aal2) cannot read drafts');

set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.unit_versions), 0, 'analyst (aal2) cannot read drafts');

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is(
  (select (select count(*) from public.schemes) + (select count(*) from public.scheme_weeks)
        + (select count(*) from public.themes) + (select count(*) from public.theme_units)
        + (select count(*) from public.chapters) + (select count(*) from public.units))::int,
  0,
  'an ordinary user sees no schemes, themes or unpublished chapters and units'
);
select results_eq(
  $$select (select count(*)::int from public.levels), (select count(*)::int from public.subjects),
           (select count(*)::int from public.characters)$$,
  $$values (6, 12, 2)$$,
  'an ordinary user reads the reference data (levels, subjects, characters)'
);

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is(
  (select (select count(*) from public.schemes) + (select count(*) from public.chapters)
        + (select count(*) from public.units))::int,
  0,
  'support (aal2) sees no schemes or unpublished curriculum'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.units), 11, 'a content_editor at aal2 sees every unit, drafts included');

-- the review workflow, enforced below RLS ---------------------------------------------------------------------------------
select lives_ok(
  $$insert into public.unit_versions (id, unit_id, version, schema_version, content, generated_by, created_by)
    values ('f0000008-0000-4000-8000-000000000008', 'ab000002-0000-4000-8000-000000000002', 2, 1,
            '{"a":1}', 'human', 'e2000000-0000-4000-8000-000000000006')$$,
  'a content_editor can create a draft version'
);
select throws_ok(
  $$insert into public.unit_versions (unit_id, version, schema_version, content, generated_by, created_by)
    values ('ab000002-0000-4000-8000-000000000002', 3, 1, '{"a":1}', 'human', 'e1000000-0000-4000-8000-000000000005')$$,
  '42501', null, 'a draft cannot be created in someone else''s name'
);
select throws_ok(
  $$insert into public.unit_versions (unit_id, version, schema_version, content, status, generated_by, created_by)
    values ('ab000002-0000-4000-8000-000000000002', 3, 1, '{"a":1}', 'approved', 'human', 'e2000000-0000-4000-8000-000000000006')$$,
  '42501', 'unit_version_must_start_as_draft', 'a version cannot be created already approved'
);
select results_eq(
  $$with u as (update public.unit_versions set status = 'in_review'
               where id = 'f0000003-0000-4000-8000-000000000003' returning 1)
    select count(*)::int from u$$,
  array[1],
  'an editor can submit a draft for review'
);
select throws_ok(
  $$update public.unit_versions set status = 'approved' where id = 'f0000003-0000-4000-8000-000000000003'$$,
  '42501', 'reviewer_required', 'an editor cannot approve (only reviewer or super_admin)'
);

set local request.jwt.claims = '{"sub":"e3000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$with u as (update public.unit_versions set status = 'approved'
               where id = 'f0000003-0000-4000-8000-000000000003' returning 1)
    select count(*)::int from u$$,
  array[1],
  'a reviewer can approve a version in review'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$update public.unit_versions set content = '{"x":2}' where id = 'f0000003-0000-4000-8000-000000000003'$$,
  '42501', 'approved_version_is_frozen', 'the content of an approved version is frozen'
);
select throws_ok(
  $$update public.unit_versions set status = 'published' where id = 'f0000003-0000-4000-8000-000000000003'$$,
  '42501', 'use_publish_unit_version', 'clients cannot mark a version published directly'
);
select throws_ok(
  $$update public.unit_versions set generated_by = 'human' where id = 'f0000003-0000-4000-8000-000000000003'$$,
  '42501', 'unit_version_provenance_immutable', 'provenance columns never change'
);
select throws_ok(
  $$delete from public.unit_versions where id = 'f0000004-0000-4000-8000-000000000004'$$,
  '42501', null, 'version history cannot be deleted'
);
select throws_ok(
  $$update public.units set status = 'published' where id = 'ab000002-0000-4000-8000-000000000002'$$,
  '42501', 'use_publish_unit_version', 'a unit cannot be marked published directly'
);
select throws_ok(
  $$update public.chapters set status = 'published' where id = 'c4000002-0000-4000-8000-000000000002'$$,
  '42501', 'use_publish_unit_version', 'a chapter cannot be marked published directly'
);

set local request.jwt.claims = '{"sub":"e3000000-0000-4000-8000-000000000007","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$insert into public.schemes (subject_id, level_code, term)
    values ((select id from public.subjects where slug = 'mathematics'), 'P3', 1)$$,
  '42501', null, 'a reviewer cannot write schemes'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into public.schemes (subject_id, level_code, term)
    values ((select id from public.subjects where slug = 'mathematics'), 'P2', 1)$$,
  'a content_editor can write schemes'
);
select throws_ok(
  $$insert into public.levels (code, name, stage, sort) values ('P1', 'Primary 1', 'absorb', 1)$$,
  '42501', null, 'only a super_admin can change levels'
);

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$insert into public.schemes (subject_id, level_code, term)
    values ((select id from public.subjects where slug = 'mathematics'), 'P4', 1)$$,
  '42501', null, 'support cannot write schemes'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is_empty(
  $$update public.subjects set name = 'Hacked' where slug = 'ict' returning 1$$,
  'an ordinary user cannot change subjects'
);

-- the publish gate ----------------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.publish_unit_version('f0000001-0000-4000-8000-000000000001')$$,
  '42501', 'admin_role_required', 'an ordinary user cannot publish'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.publish_unit_version('f0000001-0000-4000-8000-000000000001')$$,
  '42501', 'admin_role_required', 'an admin at aal1 cannot publish (aal2 required)'
);

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.publish_unit_version('f0000001-0000-4000-8000-000000000001')$$,
  '42501', 'admin_role_required', 'support (aal2) cannot publish'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.publish_unit_version('f0000004-0000-4000-8000-000000000004')$$,
  '22023', 'unit_version_not_approved', 'a draft cannot be published'
);
select throws_ok(
  $$select public.publish_unit_version('f0000005-0000-4000-8000-000000000005')$$,
  '22023', 'unit_version_content_empty', 'an approved version with empty content cannot be published'
);
select throws_ok(
  $$select public.publish_unit_version('f0000006-0000-4000-8000-000000000006')$$,
  '22023', 'chapter_unit_count_invalid', 'a chapter with only 2 units cannot be published'
);
select throws_ok(
  $$select public.publish_unit_version('f0000007-0000-4000-8000-000000000007')$$,
  '22023', 'chapter_unit_count_invalid', 'a chapter with 6 units cannot be published'
);
select throws_ok(
  $$select public.publish_unit_version('00000000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'unit_version_not_found', 'publishing an unknown version fails'
);

reset role;
select is(
  private.chapter_unit_count_ok('c4000001-0000-4000-8000-000000000001'),
  true,
  'chapter_unit_count_ok accepts 3 units'
);
select is(
  private.chapter_unit_count_ok('c4000002-0000-4000-8000-000000000002'),
  false,
  'chapter_unit_count_ok rejects 2 units'
);

-- publishing --------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into pub select 'v1', public.publish_unit_version('f0000001-0000-4000-8000-000000000001')$$,
  'an admin at aal2 publishes an approved version'
);

reset role;
select results_eq(
  $$select version_no, is_current from public.published_units where unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  $$values (1, true)$$,
  'a current snapshot now exists for the unit'
);
select results_eq(
  $$select v.status, u.status, c.status
      from public.unit_versions v
      join public.units u on u.id = v.unit_id
      join public.chapters c on c.id = u.chapter_id
     where v.id = 'f0000001-0000-4000-8000-000000000001'$$,
  $$values ('published', 'published', 'published')$$,
  'the version, its unit and its chapter are marked published'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select content ->> 'title' from public.published_units$$,
  array['U1 v1'],
  'any signed-in user reads the current snapshot'
);
select results_eq(
  $$select (select count(*)::int from public.chapters), (select count(*)::int from public.units)$$,
  $$values (1, 1)$$,
  'learners now see the published chapter and unit, but not the unpublished siblings'
);
select is((select count(*)::int from public.unit_versions), 0, 'drafts stay invisible after publishing');

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is(
  (select public.publish_unit_version('f0000001-0000-4000-8000-000000000001')),
  (select id from pub where label = 'v1'),
  'publishing an already-published version is idempotent (same snapshot id)'
);
reset role;
select is(
  (select count(*)::int from public.published_units where unit_id = 'ab000001-0000-4000-8000-000000000001'),
  1,
  'idempotent publish did not create a second snapshot'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into pub select 'v2', public.publish_unit_version('f0000002-0000-4000-8000-000000000002')$$,
  'publishing a newer version succeeds'
);
reset role;
select results_eq(
  $$select version_no, is_current from public.published_units
     where unit_id = 'ab000001-0000-4000-8000-000000000001' order by version_no$$,
  $$values (1, false), (2, true)$$,
  'the pointer flipped: exactly one current snapshot per unit'
);
select results_eq(
  $$select status from public.unit_versions
     where unit_id = 'ab000001-0000-4000-8000-000000000001' order by version$$,
  array['superseded', 'published'],
  'the previous version is superseded'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select version_no from public.published_units$$,
  array[2],
  'learners read only the current snapshot'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.publish_unit_version('f0000001-0000-4000-8000-000000000001')$$,
  '22023', 'unit_version_superseded', 'a superseded version cannot be published again'
);

-- an older version cannot overwrite a newer snapshot
reset role;
update public.unit_versions set status = 'approved' where id = 'f0000008-0000-4000-8000-000000000008';
set local role authenticated;
set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.publish_unit_version('f0000008-0000-4000-8000-000000000008')$$,
  'version 2 of another unit publishes'
);
select throws_ok(
  $$select public.publish_unit_version('f0000003-0000-4000-8000-000000000003')$$,
  '22023', 'unit_version_older_than_current', 'an older approved version cannot replace a newer snapshot'
);

-- immutability --------------------------------------------------------------------------------------------------------------------------
select throws_ok(
  $$update public.published_units set content = '{}'$$,
  '42501', null, 'clients cannot update snapshots'
);
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$update public.published_units set is_current = true$$,
  '42501', null, 'not even a super_admin can flip the pointer directly'
);
select throws_ok(
  $$insert into public.published_units (unit_id, unit_version_id, version_no, schema_version, content, is_current)
    values ('ab000002-0000-4000-8000-000000000002', 'f0000003-0000-4000-8000-000000000003', 9, 1, '{"a":1}', true)$$,
  '42501', null, 'snapshots cannot be inserted except through publish_unit_version'
);
select throws_ok(
  $$delete from public.published_units$$,
  '42501', null, 'snapshots cannot be deleted by clients'
);

reset role;
select throws_ok(
  $$update public.published_units set content = '{"tampered":true}' where unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  '42501', 'published_units_are_immutable', 'even the owner cannot rewrite a snapshot (trigger)'
);
select throws_ok(
  $$delete from public.published_units where unit_id = 'ab000001-0000-4000-8000-000000000001'$$,
  '42501', 'published_units_are_immutable', 'even the owner cannot delete a snapshot (trigger)'
);
select lives_ok(
  $$update public.published_units set is_current = false
     where unit_id = 'ab000001-0000-4000-8000-000000000001' and version_no = 1$$,
  'the pointer and tombstone columns remain writable by the publishing code path'
);

-- history is for content staff only ----------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.published_units), 2, 'support sees only current snapshots');

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.published_units), 3, 'content staff also see superseded snapshots');

reset role;
update public.published_units set deleted_at = now()
 where unit_id = 'ab000002-0000-4000-8000-000000000002' and is_current;
set local role authenticated;
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from public.published_units),
  1,
  'a tombstoned snapshot disappears from learners'' view'
);

-- audit -------------------------------------------------------------------------------------------------------------------------------------------
reset role;
select is(
  (select count(*)::int from public.audit_log where entity = 'published_units' and action = 'insert'),
  3,
  'each published snapshot was audited'
);
select ok(
  (select count(*) from public.audit_log
    where entity = 'unit_versions' and action = 'update' and detail -> 'new' ->> 'status' = 'approved') >= 1,
  'approvals of unit versions are audited'
);

select * from finish();
rollback;
