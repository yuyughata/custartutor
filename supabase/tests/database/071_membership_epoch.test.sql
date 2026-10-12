-- 071 membership epoch: households.membership_epoch changes whenever access to the household data changes
-- (member added / removed / role change, tutor grant given / revoked, child soft-deleted / restored), through
-- direct changes AND through the RPCs. The value comes from one global sequence, so it never repeats across
-- households and never moves backwards. Clients cannot touch it.
begin;
create extension if not exists pgtap with schema extensions;
select plan(27);

-- gA a1..01 guardian of hA | gB b1..02 guardian of hB | tU c1..03 tutor of hA | t2 c2..04 (invited later)
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('c2000000-0000-4000-8000-000000000004', 't2@test.local');
insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor');
insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1'),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P1');
insert into public.grownup_elevations (user_id, device_id, expires_at)
values ('a1000000-0000-4000-8000-000000000001', 'test-device', now() + interval '10 minutes');

-- the current epoch, as text so that it can be compared across statements
create function public.tepoch(h uuid) returns int language sql stable as $$
  select membership_epoch from public.households where id = h;
$$;
grant execute on function public.tepoch(uuid) to public;
create temp table ep (k text primary key, v int not null);
grant all on ep to public;

select cmp_ok(
  (select membership_epoch from public.households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  '>=', 1, 'every household starts with an epoch >= 1 (0 is reserved for "no household")'
);
select isnt(
  public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), public.tepoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  'two households never share an epoch'
);

-- changes that do NOT alter access leave the epoch alone ---------------------------------------------------------------
insert into ep values ('a0', public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
update public.households set name = 'Household A renamed' where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
update public.children set display_alias = 'Adaora', daily_limit_min = 30 where id = 'ca000001-0000-4000-8000-000000000001';
update public.household_members set created_at = created_at where user_id = 'c1000000-0000-4000-8000-000000000003';
select is(
  public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), (select v from ep where k = 'a0'),
  'renaming the household, editing a child profile or touching a membership without changing it do not bump the epoch'
);

-- membership -------------------------------------------------------------------------------------------------------------------
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c2000000-0000-4000-8000-000000000004', 'tutor');
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'adding a member bumps the epoch');

update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.household_members set role = 'guardian'
 where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and user_id = 'c2000000-0000-4000-8000-000000000004';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'changing a member''s role bumps the epoch');

update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.household_members set status = 'removed', deleted_at = now()
 where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and user_id = 'c2000000-0000-4000-8000-000000000004';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'removing a member (tombstone) bumps the epoch');

update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.household_members set status = 'active', deleted_at = null
 where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' and user_id = 'c2000000-0000-4000-8000-000000000004';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  're-activating a removed member bumps the epoch');

update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
with d as (delete from public.household_members
            where household_id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
              and user_id = 'c2000000-0000-4000-8000-000000000004' returning 1)
select count(*) from d;
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'hard-deleting a membership (account deletion cascade) bumps the epoch');

-- tutor grants -------------------------------------------------------------------------------------------------------------------
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'granting a tutor access to a child bumps the epoch');

update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.child_access set granted_by = granted_by where child_id = 'ca000001-0000-4000-8000-000000000001';
select is(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), (select v from ep where k = 'a0'),
  'touching a grant without changing it does not bump the epoch');

update public.child_access set revoked_at = now(), deleted_at = now()
 where child_id = 'ca000001-0000-4000-8000-000000000001';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'revoking a grant bumps the epoch');

-- children ---------------------------------------------------------------------------------------------------------------------------
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'soft-deleting a child bumps the epoch');
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'a0';
update public.children set deleted_at = null where id = 'ca000002-0000-4000-8000-000000000002';
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'a0'),
  'restoring a child bumps the epoch');

-- a change in household A never moves household B ---------------------------------------------------------------------------------------
insert into ep values ('b0', public.tepoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'));
update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002';
update public.children set deleted_at = null where id = 'ca000002-0000-4000-8000-000000000002';
select is(public.tepoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), (select v from ep where k = 'b0'),
  'changes in household A do not change the epoch of household B');
insert into public.children (id, household_id, display_alias, level_code) values
  ('cb000001-0000-4000-8000-000000000001', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P1');
select is(public.tepoch('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), (select v from ep where k = 'b0'),
  'adding a child does not bump the epoch (it arrives as a normal row)');

-- the same bumps through the RPCs, as a guardian with an elevation --------------------------------------------------------------------------
insert into ep values ('r0', public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'));
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.grant_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003')$$,
  'grant_child_access works for the guardian'
);
reset role;
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'r0'),
  'grant_child_access (RPC) bumps the epoch');
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'r0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.revoke_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003')$$,
  'revoke_child_access works for the guardian'
);
reset role;
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'r0'),
  'revoke_child_access (RPC) bumps the epoch');
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'r0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003')$$,
  'remove_member works for the guardian'
);
reset role;
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'r0'),
  'remove_member (RPC) bumps the epoch');
update ep set v = public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') where k = 'r0';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$update public.children set deleted_at = now() where id = 'ca000002-0000-4000-8000-000000000002'$$,
  'the guardian soft-deletes a child (with an elevation)'
);
reset role;
select cmp_ok(public.tepoch('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), '>', (select v from ep where k = 'r0'),
  'a client soft-delete of a child bumps the epoch');

-- clients cannot touch the epoch --------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$update public.households set membership_epoch = 1 where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'$$,
  '42501', null, 'a guardian cannot write membership_epoch'
);
select is(
  (select membership_epoch from public.households where id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') > 0,
  true,
  'a guardian can read the epoch of their own household'
);
reset role;
select is(
  (select has_sequence_privilege('authenticated', 'public.membership_epoch_seq', 'USAGE')
       or has_sequence_privilege('anon', 'public.membership_epoch_seq', 'USAGE')),
  false,
  'no client role has any privilege on the epoch sequence'
);
select is(
  (select count(*)::int from pg_trigger t
    where t.tgrelid in ('public.household_members'::regclass, 'public.child_access'::regclass,
                        'public.children'::regclass)
      and t.tgname in ('household_members_epoch', 'child_access_epoch', 'children_epoch')),
  3,
  'the three epoch triggers exist'
);

select * from finish();
rollback;
