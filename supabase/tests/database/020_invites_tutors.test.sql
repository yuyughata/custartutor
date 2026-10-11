-- 020 invites and tutor grants.
--   tokens are single-use, expiring and stored only as a hash; creating an invite needs a grown-up
--   elevation; a tutor loses access immediately after revoke / removal; the last guardian stays.
begin;
create extension if not exists pgtap with schema extensions;
select plan(51);

-- fixtures (as the table owner) -----------------------------------------------------------------------
-- gA a1..01 guardian of hA | gB b1..02 guardian of hB | tU c1..03 invited tutor | gC e1..06 invited guardian
-- out d1..05 outsider
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'gb@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local'),
  ('d1000000-0000-4000-8000-000000000005', 'out@test.local'),
  ('e1000000-0000-4000-8000-000000000006', 'gc@test.local');

insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Household B', 'b1000000-0000-4000-8000-000000000002');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'b1000000-0000-4000-8000-000000000002', 'guardian');
insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1'),
  ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P2'),
  ('cb000001-0000-4000-8000-000000000003', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'Chidi', 'P3');

-- raw tokens are kept here for the test only (the database never stores them)
create temp table tok (label text primary key, token text not null);
grant all on tok to public;

-- guardian A, not yet elevated ---------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
    array['ca000001-0000-4000-8000-000000000001']::uuid[], 24)$$,
  '42501', 'elevation_required', 'creating an invite requires a grown-up elevation'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
    array['ca000001-0000-4000-8000-000000000001']::uuid[], 24)$$,
  '42501', 'not_a_guardian', 'a non-member cannot create invites for someone else''s household'
);

-- guardian A elevates through the real PIN flow ---------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select lives_ok($$select public.set_grownup_pin('2580')$$, 'guardian A sets a grown-up PIN');
select ok(
  public.elevate_grownup('dev-1', '2580') is not null,
  'the correct PIN opens an elevation'
);

select lives_ok(
  $$insert into tok select 'tutor1', token
    from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
      array['ca000001-0000-4000-8000-000000000001']::uuid[], 24)$$,
  'an elevated guardian creates a tutor invite for one child'
);
select lives_ok(
  $$insert into tok select 'guardian1', token
    from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guardian', '{}'::uuid[], 48)$$,
  'an elevated guardian creates a co-guardian invite'
);
select ok(
  (select token ~ '^[0-9a-f]{64}$' from tok where label = 'tutor1'),
  'the raw token is 256 random bits (64 hex characters)'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guardian',
    array['ca000001-0000-4000-8000-000000000001']::uuid[], 24)$$,
  '22023', 'guardian_invite_takes_no_children', 'a guardian invite cannot name children'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor', '{}'::uuid[], 24)$$,
  '22023', 'tutor_invite_needs_children', 'a tutor invite must name at least one child'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
    array['cb000001-0000-4000-8000-000000000003']::uuid[], 24)$$,
  '22023', 'unknown_child', 'a tutor invite cannot name another household''s child'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
    array['ca000001-0000-4000-8000-000000000001']::uuid[], 0)$$,
  '22023', 'invalid_ttl', 'a zero TTL is rejected'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guardian', '{}'::uuid[], 100)$$,
  '22023', 'invalid_ttl', 'a guardian invite lives at most 72 hours (it exposes the whole household)'
);
select throws_ok(
  $$select * from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'admin', '{}'::uuid[], 24)$$,
  '22023', 'invalid_role', 'only guardian and tutor invites exist'
);
select throws_ok(
  $$select * from public.invites$$,
  '42501', null, 'clients cannot read the invites table'
);
select throws_ok(
  $$insert into public.invites (household_id, role, child_ids, token_hash, expires_at)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'guardian', '{}', 'x', now() + interval '1 day')$$,
  '42501', null, 'clients cannot write the invites table'
);

-- what the database actually stored -------------------------------------------------------------------------------
reset role;

select is(
  (select count(*)::int from public.invites where token_hash = (select token from tok where label = 'tutor1')),
  0,
  'the raw token is not stored'
);
select is(
  (select count(*)::int from public.invites
    where token_hash = encode(extensions.digest((select token from tok where label = 'tutor1'), 'sha256'), 'hex')),
  1,
  'only the sha256 hash of the token is stored'
);
select is(
  (select count(*)::int from public.audit_log where action = 'invite_created'),
  2,
  'creating an invite is audited (and failed attempts leave no trace)'
);

-- an already expired invite (fixture)
insert into public.invites (household_id, role, child_ids, token_hash, expires_at, created_by)
values (
  'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor', array['ca000001-0000-4000-8000-000000000001']::uuid[],
  encode(extensions.digest('expired-token-aaaaaaaaaaaaaaaaaaaaaaaa', 'sha256'), 'hex'),
  now() - interval '1 hour', 'a1000000-0000-4000-8000-000000000001'
);

-- tutor accepts ----------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';

select is(
  (select count(*)::int from public.children),
  0,
  'before accepting, the future tutor sees no children'
);
select results_eq(
  $$select role from public.accept_invite((select token from tok where label = 'tutor1'))$$,
  array['tutor'],
  'accept_invite joins the tutor to the household'
);
select results_eq(
  $$select id from public.children$$,
  $$values ('ca000001-0000-4000-8000-000000000001'::uuid)$$,
  'the tutor sees only the child named in the invite'
);
select is(
  (select count(*)::int from public.households),
  1,
  'the tutor sees the household'
);

-- single use, expiry -------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select * from public.accept_invite((select token from tok where label = 'tutor1'))$$,
  '22023', 'invite_used', 'a used token cannot be redeemed by someone else'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select * from public.accept_invite((select token from tok where label = 'tutor1'))$$,
  '22023', 'invite_used', 'a token cannot be redeemed twice, even by the same user'
);

set local request.jwt.claims = '{"sub":"d1000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select * from public.accept_invite('expired-token-aaaaaaaaaaaaaaaaaaaaaaaa')$$,
  '22023', 'invite_expired', 'an expired token is rejected'
);

-- co-guardian ----------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select role from public.accept_invite((select token from tok where label = 'guardian1'))$$,
  array['guardian'],
  'a guardian invite makes the invitee a guardian'
);
select is(
  (select count(*)::int from public.children),
  2,
  'a co-guardian sees all children of the household'
);
select throws_ok(
  $$select public.revoke_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003')$$,
  '42501', 'elevation_required', 'revoking a tutor grant needs the caller''s own grown-up elevation'
);

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$insert into tok select 'tutor2', token
    from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
      array['ca000002-0000-4000-8000-000000000002']::uuid[], 24)$$,
  'guardian A creates a second tutor invite'
);

set local request.jwt.claims = '{"sub":"e1000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select * from public.accept_invite((select token from tok where label = 'tutor2'))$$,
  '22023', 'already_guardian', 'a guardian cannot be downgraded to a tutor by accepting a tutor invite'
);

reset role;
select is(
  (select accepted_at is null from public.invites
    where token_hash = encode(extensions.digest((select token from tok where label = 'tutor2'), 'sha256'), 'hex')),
  true,
  'a rejected acceptance does not consume the invite'
);

-- grants and revocation --------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select ok(
  (select public.grant_child_access('ca000002-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')) is not null,
  'a guardian can grant an existing tutor another child'
);
select ok(
  (select public.grant_child_access('ca000002-0000-4000-8000-000000000002', 'c1000000-0000-4000-8000-000000000003')) is null,
  'granting twice is a no-op (one active grant per child and tutor)'
);
select throws_ok(
  $$select public.grant_child_access('ca000002-0000-4000-8000-000000000002', 'e1000000-0000-4000-8000-000000000006')$$,
  '22023', 'tutor_not_in_household', 'only tutors of the household can be granted a child'
);
select throws_ok(
  $$select public.grant_child_access('cb000001-0000-4000-8000-000000000003', 'c1000000-0000-4000-8000-000000000003')$$,
  '42501', 'not_a_guardian', 'a guardian cannot grant access to another household''s child'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select is(
  (select count(*)::int from public.children),
  2,
  'the tutor now sees both granted children'
);

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is(
  (select public.revoke_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003')),
  1,
  'revoking an active grant reports one grant revoked'
);
select is(
  (select public.revoke_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003')),
  0,
  'revoking again is a no-op'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select id from public.children$$,
  $$values ('ca000002-0000-4000-8000-000000000002'::uuid)$$,
  'the tutor loses access to the revoked child immediately'
);
select is(
  (select count(*)::int from public.child_access where revoked_at is null),
  1,
  'the tutor has exactly one active grant left'
);
select is(
  (select count(*)::int from public.child_access
    where child_id = 'ca000001-0000-4000-8000-000000000001' and revoked_at is not null and deleted_at is not null),
  1,
  'the revoked grant reaches the tutor as a tombstone (revoked_at and deleted_at set)'
);

-- member removal ---------------------------------------------------------------------------------------------------------------
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003')$$,
  'a guardian can remove a tutor'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select is(
  (select (select count(*) from public.children) + (select count(*) from public.households))::int,
  0,
  'a removed tutor sees no children and no household'
);
select results_eq(
  $$select status, deleted_at is not null from public.household_members$$,
  $$values ('removed', true)$$,
  'a removed tutor still receives their own membership tombstone'
);

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select lives_ok(
  $$select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'e1000000-0000-4000-8000-000000000006')$$,
  'a guardian can remove a co-guardian while another guardian remains'
);
select throws_ok(
  $$select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001')$$,
  '22023', 'last_guardian', 'the last guardian cannot be removed'
);
select throws_ok(
  $$select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'd1000000-0000-4000-8000-000000000005')$$,
  'P0002', 'member_not_found', 'removing someone who is not a member fails'
);

-- a removed tutor can be invited again -------------------------------------------------------------------------------------------
select lives_ok(
  $$insert into tok select 'tutor3', token
    from public.create_invite('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'tutor',
      array['ca000001-0000-4000-8000-000000000001']::uuid[], 24)$$,
  'guardian A invites the removed tutor again'
);

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select results_eq(
  $$select role from public.accept_invite((select token from tok where label = 'tutor3'))$$,
  array['tutor'],
  'the removed tutor can accept a fresh invite'
);
select results_eq(
  $$select status from public.household_members where user_id = 'c1000000-0000-4000-8000-000000000003'$$,
  array['active'],
  'the membership is active again'
);
select results_eq(
  $$select id from public.children$$,
  $$values ('ca000001-0000-4000-8000-000000000001'::uuid)$$,
  'only the newly invited child is visible (old grants stay revoked)'
);

reset role;

select * from finish();
rollback;
