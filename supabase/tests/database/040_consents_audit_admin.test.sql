-- 040 consents (append-only), audit log, admin_users, and the support/analyst boundary.
--   consents: guardians insert and read their own rows, nobody updates or deletes (not even service_role);
--   audit_log: written by triggers/functions, readable only by super_admin at aal2;
--   support / analyst (and every other admin role) have no path into household data.
begin;
create extension if not exists pgtap with schema extensions;
select plan(40);

-- gA a1..01 guardian hA | gB b1..02 guardian hB | tU c1..03 tutor (hA, child Ada) | plain d1..05
-- sa e1..05 super_admin | ed e2..06 content_editor | sup e4..08 support | ana e5..09 analyst | newadm f1..10
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('d1000000-0000-4000-8000-000000000005', 'plain@test.local'),
  ('e1000000-0000-4000-8000-000000000005', 'sa@test.local'),
  ('e2000000-0000-4000-8000-000000000006', 'ed@test.local'),
  ('e4000000-0000-4000-8000-000000000008', 'sup@test.local'),
  ('e5000000-0000-4000-8000-000000000009', 'ana@test.local'),
  ('f1000000-0000-4000-8000-000000000010', 'newadm@test.local');

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor');
insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1'),
  ('cb000001-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P3');
insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');
insert into public.admin_users (user_id, role) values
  ('e1000000-0000-4000-8000-000000000005', 'super_admin'),
  ('e2000000-0000-4000-8000-000000000006', 'content_editor'),
  ('e4000000-0000-4000-8000-000000000008', 'support'),
  ('e5000000-0000-4000-8000-000000000009', 'analyst');

-- triggers audited the fixture inserts above
select results_eq(
  $$select entity, count(*)::int from public.audit_log group by entity order by entity$$,
  $$values ('admin_users', 4), ('child_access', 1), ('household_members', 3)$$,
  'membership, tutor-grant and admin-role changes are audited by triggers'
);

-- consents: guardian A -----------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'withdraw')$$,
  'a guardian can withdraw consent without an elevation'
);
select throws_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'grant')$$,
  '42501', null, 'granting consent needs a grown-up elevation (a child cannot consent on the parent''s behalf)'
);

reset role;
insert into public.grownup_elevations (user_id, device_id, expires_at)
values ('a1000000-0000-4000-8000-000000000001', 'test-device', now() + interval '10 minutes');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'grant')$$,
  'with an elevation a guardian can grant consent'
);
select lives_ok(
  $$insert into public.consents (user_id, household_id, child_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'ca000001-0000-4000-8000-000000000001', 'tutor_ai', 'v1', 'grant')$$,
  'consent can be recorded for a specific child of the household'
);
select throws_ok(
  $$insert into public.consents (user_id, household_id, child_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'cb000001-0000-4000-8000-000000000003', 'tutor_ai', 'v1', 'grant')$$,
  '23503', null, 'a consent row cannot name a child of a different household'
);
select throws_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('b1000000-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'withdraw')$$,
  '42501', null, 'a consent row cannot be written in someone else''s name'
);
select throws_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('a1000000-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'tutor_ai', 'v1', 'withdraw')$$,
  '42501', null, 'a guardian cannot record consent for a household they do not belong to'
);
select is(
  (select count(*)::int from public.consents),
  3,
  'a guardian reads back their own consent rows'
);
select throws_ok(
  $$update public.consents set action = 'withdraw'$$,
  '42501', null, 'consents cannot be updated (withdrawal is a new row)'
);
select throws_ok(
  $$delete from public.consents$$,
  '42501', null, 'consents cannot be deleted'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('c1000000-0000-4000-8000-000000000003', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'withdraw')$$,
  '42501', null, 'a tutor cannot record consent for the household'
);
select is(
  (select count(*)::int from public.consents),
  0,
  'a tutor cannot read the household''s consent rows'
);

set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from public.consents),
  0,
  'another household''s guardian reads none of them'
);

reset role;
set local role service_role;
select throws_ok(
  $$update public.consents set action = 'withdraw'$$,
  '42501', null, 'even service_role cannot update consents'
);
select throws_ok(
  $$delete from public.consents$$,
  '42501', null, 'even service_role cannot delete consents'
);
reset role;

-- support / analyst / super_admin have no household access --------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is(
  (select (select count(*) from public.children) + (select count(*) from public.households)
        + (select count(*) from public.household_members) + (select count(*) from public.child_access)
        + (select count(*) from public.consents) + (select count(*) from public.member_display)
        + (select count(*) from public.profiles where id <> 'e4000000-0000-4000-8000-000000000008'))::int,
  0,
  'support (aal2) sees no children, households, members, grants, consents or other users'' profiles'
);
select throws_ok(
  $$insert into public.consents (user_id, household_id, scope, version, action)
    values ('e4000000-0000-4000-8000-000000000008', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor_ai', 'v1', 'withdraw')$$,
  '42501', null, 'support cannot write consents'
);

set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}';
select is(
  (select (select count(*) from public.children) + (select count(*) from public.households)
        + (select count(*) from public.household_members) + (select count(*) from public.child_access)
        + (select count(*) from public.consents) + (select count(*) from public.member_display)
        + (select count(*) from public.profiles where id <> 'e5000000-0000-4000-8000-000000000009'))::int,
  0,
  'analyst (aal2) sees no children, households, members, grants, consents or other users'' profiles'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select is(
  (select (select count(*) from public.children) + (select count(*) from public.households)
        + (select count(*) from public.household_members) + (select count(*) from public.child_access)
        + (select count(*) from public.consents) + (select count(*) from public.member_display))::int,
  0,
  'even a super_admin (aal2) has no automatic access to household data'
);

-- audit_log visibility ---------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.audit_log), 0, 'an ordinary user reads no audit rows');

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.audit_log), 0, 'a guardian reads no audit rows');

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.audit_log), 0, 'support (aal2) reads no audit rows');

set local request.jwt.claims = '{"sub":"e5000000-0000-4000-8000-000000000009","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.audit_log), 0, 'analyst (aal2) reads no audit rows');

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select is((select count(*)::int from public.audit_log), 0, 'content_editor (aal2) reads no audit rows');

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is((select count(*)::int from public.audit_log), 0, 'super_admin at aal1 reads no audit rows (aal2 required)');

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select ok((select count(*) from public.audit_log) > 0, 'super_admin at aal2 reads the audit log');
select throws_ok(
  $$insert into public.audit_log (action, entity) values ('forged', 'x')$$,
  '42501', null, 'nobody can write the audit log through the API'
);
select throws_ok(
  $$update public.audit_log set action = 'edited'$$,
  '42501', null, 'the audit log cannot be updated'
);
select throws_ok(
  $$delete from public.audit_log$$,
  '42501', null, 'the audit log cannot be deleted'
);

-- admin_users -------------------------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$insert into public.admin_users (user_id, role) values ('d1000000-0000-4000-8000-000000000005', 'super_admin')$$,
  '42501', null, 'an ordinary user cannot make themselves an admin'
);

set local request.jwt.claims = '{"sub":"e2000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$insert into public.admin_users (user_id, role) values ('f1000000-0000-4000-8000-000000000010', 'content_editor')$$,
  '42501', null, 'a content_editor cannot create admins'
);
select is_empty(
  $$update public.admin_users set role = 'super_admin'
    where user_id = 'e2000000-0000-4000-8000-000000000006' returning 1$$,
  'a content_editor cannot promote themselves'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$insert into public.admin_users (user_id, role) values ('f1000000-0000-4000-8000-000000000010', 'reviewer')$$,
  '42501', null, 'a super_admin at aal1 cannot create admins'
);
select is(
  (select count(*)::int from public.admin_users),
  1,
  'a super_admin at aal1 sees only their own admin row'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into public.admin_users (user_id, role) values ('f1000000-0000-4000-8000-000000000010', 'reviewer')$$,
  'a super_admin at aal2 can create an admin'
);
select is(
  (select count(*)::int from public.admin_users),
  5,
  'a super_admin at aal2 sees every admin row'
);

set local request.jwt.claims = '{"sub":"e4000000-0000-4000-8000-000000000008","role":"authenticated","aal":"aal2"}';
select is(
  (select count(*)::int from public.admin_users),
  1,
  'support sees only their own admin row'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from public.admin_users),
  0,
  'an ordinary user sees no admin rows'
);

reset role;
select is(
  (select actor from public.audit_log
    where entity = 'admin_users' and action = 'insert' and entity_id = 'f1000000-0000-4000-8000-000000000010'),
  'e1000000-0000-4000-8000-000000000005'::uuid,
  'the audit row records the acting admin from the JWT'
);

select * from finish();
rollback;
