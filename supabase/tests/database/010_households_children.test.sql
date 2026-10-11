-- 010 households, members, children, tutors, profiles.
--   guardian A cannot read household B; a tutor sees only granted children; nobody can self-join or
--   write household_members; profiles are not readable across members (member_display only).
begin;
create extension if not exists pgtap with schema extensions;
select plan(46);

-- fixtures (as the table owner) -----------------------------------------------------------------------
-- gA a1..01 guardian of hA | gB b1..02 guardian of hB | tU c1..03 tutor (child Ada) | t2 c2..04 tutor (child Bayo)
-- out d1..05 belongs to no household
insert into auth.users (id, email, raw_user_meta_data) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local', '{"display_name":"Guardian A"}'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local', '{"display_name":"Guardian B"}'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local', '{"display_name":"Tutor T"}'),
  ('c2000000-0000-4000-8000-000000000004', 't2@test.local', '{"display_name":"Tutor 2"}'),
  ('d1000000-0000-4000-8000-000000000005', 'out@test.local', null);

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002');

insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c2000000-0000-4000-8000-000000000004', 'tutor');

insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1'),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P2'),
  ('cb000001-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P3');

insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001'),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c2000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001');

-- the auth.users trigger created the profiles
select is(
  (select display_name from public.profiles where id = 'a1000000-0000-4000-8000-000000000001'),
  'Guardian A',
  'signing up creates a profile (display name from user metadata)'
);

-- guardian A: reads ---------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select results_eq(
  $$select display_alias from public.children order by display_alias$$,
  $$values ('Ada'), ('Bayo')$$,
  'guardian A sees exactly the children of household A'
);
select is_empty(
  $$select 1 from public.children where id = 'cb000001-0000-4000-8000-000000000003'$$,
  'guardian A cannot read household B''s child by id'
);
select results_eq(
  $$select name from public.households$$,
  array['Household A'],
  'guardian A sees only household A'
);
select is(
  (select count(*)::int from public.household_members where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  3,
  'guardian A sees all three members of household A (guardian and both tutors)'
);
select is(
  (select count(*)::int from public.household_members where household_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'guardian A sees no member of household B'
);
select is(
  (select count(*)::int from public.child_access),
  2,
  'guardian A sees the tutor grants of household A only'
);
select is(
  (select count(*)::int from public.profiles),
  1,
  'guardian A can read only their own profile, not the profiles of fellow members'
);
select results_eq(
  $$select display_name from public.member_display where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
    order by display_name collate "C"$$,
  array['Guardian A', 'Tutor 2', 'Tutor T'],
  'member_display gives guardian A the display names of household A members'
);
select is(
  (select count(*)::int from public.member_display where household_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  0,
  'member_display shows nothing about household B to guardian A'
);

-- guardian A: forbidden writes ------------------------------------------------------------------------
select throws_ok(
  $$insert into public.children (household_id, display_alias, level_code)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Intruder', 'P1')$$,
  '42501', null, 'guardian A cannot add a child to household B'
);
select is_empty(
  $$update public.children set display_alias = 'Hacked'
    where id = 'cb000001-0000-4000-8000-000000000003' returning 1$$,
  'guardian A cannot update household B''s child'
);
select throws_ok(
  $$update public.children set household_id = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    where id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', null, 'a child cannot be moved to another household (household_id is not updatable)'
);
select throws_ok(
  $$insert into public.household_members (household_id, user_id, role)
    values ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'a1000000-0000-4000-8000-000000000001', 'guardian')$$,
  '42501', null, 'no self-join: clients cannot insert household_members'
);
select throws_ok(
  $$update public.household_members set role = 'guardian'
    where user_id = 'c1000000-0000-4000-8000-000000000003'$$,
  '42501', null, 'clients cannot update household_members (no role escalation)'
);
select throws_ok(
  $$delete from public.household_members where user_id = 'c1000000-0000-4000-8000-000000000003'$$,
  '42501', null, 'clients cannot delete household_members'
);
select throws_ok(
  $$insert into public.child_access (child_id, household_id, tutor_user_id, granted_by)
    values ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
            'c2000000-0000-4000-8000-000000000004', 'a1000000-0000-4000-8000-000000000001')$$,
  '42501', null, 'clients cannot write child_access directly'
);
select is_empty(
  $$update public.profiles set display_name = 'Pwned'
    where id = 'c1000000-0000-4000-8000-000000000003' returning 1$$,
  'guardian A cannot rename another user''s profile'
);
select throws_ok(
  $$select * from public.child_secrets$$,
  '42501', null, 'child_secrets is not readable by clients'
);

-- tutor tU: only granted children -------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';

select results_eq(
  $$select id from public.children$$,
  $$values ('ca000001-0000-4000-8000-000000000001'::uuid)$$,
  'tutor sees only the child they were granted'
);
select throws_ok(
  $$insert into public.children (household_id, display_alias, level_code)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'TutorMade', 'P1')$$,
  '42501', null, 'a tutor cannot create children'
);
select is_empty(
  $$update public.children set display_alias = 'Changed'
    where id = 'ca000001-0000-4000-8000-000000000001' returning 1$$,
  'a tutor cannot edit even a granted child'
);
select is(
  (select count(*)::int from public.households),
  1,
  'a tutor can see the household they belong to'
);
select results_eq(
  $$select user_id from public.household_members order by user_id$$,
  $$values ('a1000000-0000-4000-8000-000000000001'::uuid), ('c1000000-0000-4000-8000-000000000003'::uuid)$$,
  'a tutor sees their own membership and the guardians, not the other tutors'
);
select is(
  (select count(*)::int from public.child_access),
  1,
  'a tutor sees only their own grant'
);
select is(
  (select count(*)::int from public.profiles),
  1,
  'a tutor cannot read other members'' profiles'
);
select results_eq(
  $$select display_name from public.member_display order by display_name collate "C"$$,
  array['Guardian A', 'Tutor T'],
  'member_display shows a tutor the guardians and themselves, not other tutors'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
    array['ca000001-0000-4000-8000-000000000001'::uuid], 24)$$,
  '42501', 'not_a_guardian', 'a tutor cannot create invites'
);

-- a signed-in user with no household ---------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';

select is(
  (select (select count(*) from public.children) + (select count(*) from public.households)
        + (select count(*) from public.household_members) + (select count(*) from public.child_access)
        + (select count(*) from public.member_display))::int,
  0,
  'a user outside every household sees no household data at all'
);
select throws_ok(
  $$select * from public.accept_invite('not-a-real-token-0000000000000000')$$,
  '22023', 'invite_invalid', 'accepting a made-up token does not join anything'
);
select throws_ok(
  $$insert into public.children (household_id, display_alias, level_code)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Intruder', 'P1')$$,
  '42501', null, 'an outsider cannot add a child to household A'
);

-- guardian B: symmetric isolation ----------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';

select results_eq(
  $$select id from public.children$$,
  $$values ('cb000001-0000-4000-8000-000000000003'::uuid)$$,
  'guardian B sees only household B''s child'
);
select is_empty(
  $$select 1 from public.child_access$$,
  'guardian B sees no tutor grants of household A'
);

-- guardian A: allowed writes, and the parental-control guard --------------------------------------------------
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$insert into public.children (household_id, display_alias, level_code, reading_mode)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Dayo', 'P1', 'pre_reader')$$,
  'guardian A can add a child to their household'
);
select results_eq(
  $$with u as (update public.children set display_alias = 'Adaora'
               where id = 'ca000001-0000-4000-8000-000000000001' returning 1)
    select count(*)::int from u$$,
  array[1],
  'guardian A can edit a child profile'
);
select throws_ok(
  $$update public.children set daily_limit_min = 600 where id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', 'elevation_required', 'changing the daily limit needs a grown-up elevation'
);
select throws_ok(
  $$update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002'$$,
  '42501', 'elevation_required', 'deleting a child needs a grown-up elevation'
);
select throws_ok(
  $$delete from public.children where id = 'ca000002-0000-4000-8000-000000000002'$$,
  '42501', null, 'children cannot be hard-deleted by clients (tombstone only)'
);

-- give guardian A a live elevation (as the owner; the real path is covered in 030) --------------------------------
reset role;
insert into public.grownup_elevations (user_id, device_id, expires_at)
values ('a1000000-0000-4000-8000-000000000001', 'test-device', now() + interval '10 minutes');
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select lives_ok(
  $$update public.children set daily_limit_min = 45 where id = 'ca000001-0000-4000-8000-000000000001'$$,
  'with an elevation guardian A can set the daily limit'
);
select lives_ok(
  $$update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002'$$,
  'with an elevation guardian A can soft-delete a child'
);
select is(
  (select count(*)::int from public.children
    where id = 'ca000002-0000-4000-8000-000000000002' and deleted_at is not null),
  1,
  'the soft-deleted child stays visible as a tombstone for sync'
);

-- create_household RPC ----------------------------------------------------------------------------------------
select lives_ok(
  $$select public.create_household('Second Home')$$,
  'create_household creates a household for the caller'
);
select is(
  (select count(*)::int from public.household_members
    where user_id = 'a1000000-0000-4000-8000-000000000001' and role = 'guardian'),
  2,
  'the caller becomes guardian of the new household'
);
select throws_ok(
  $$select public.create_household('   ')$$,
  '22023', 'invalid_household_name', 'create_household rejects an empty name'
);
select lives_ok(
  $q$select public.create_household('Extra ' || g) from generate_series(1, 3) g$q$,
  'a user can be guardian of up to 5 households'
);
select throws_ok(
  $$select public.create_household('One too many')$$,
  '53400', 'household_limit_reached', 'the 6th household is refused'
);

reset role;

select * from finish();
rollback;
