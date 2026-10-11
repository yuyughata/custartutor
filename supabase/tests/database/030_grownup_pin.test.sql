-- 030 grown-up PIN and elevation.
--   the PIN hash is never client-readable; wrong guesses are rate limited with exponential back-off;
--   a locked account refuses even the correct PIN; elevation is per user, expires, and can be ended.
-- Note: now() is frozen for the whole test transaction, so lock windows are asserted as exact offsets
-- and "time passing" is simulated by moving locked_until / expires_at into the past as the owner.
begin;
create extension if not exists pgtap with schema extensions;
select plan(49);

-- u1 a1..01 (PIN user) | u2 b1..02 (independent user) | u3 c1..03 (never sets a PIN)
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'u1@test.local'),
  ('b1000000-0000-4000-8000-000000000002', 'u2@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'u3@test.local');

set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- setting a PIN ---------------------------------------------------------------------------------------------
select results_eq(
  $$select has_pin, failed_attempts from public.get_grownup_pin_status()$$,
  $$values (false, 0)$$,
  'before a PIN is set, the status reports no PIN'
);
select throws_ok(
  $$select public.elevate_grownup('dev-1', '2580')$$,
  'P0002', 'pin_not_set', 'elevating without a PIN fails'
);
select throws_ok(
  $$select public.set_grownup_pin('abc')$$,
  '22023', 'invalid_pin_format', 'a PIN must be digits'
);
select throws_ok(
  $$select public.set_grownup_pin('12345678')$$,
  '22023', 'invalid_pin_format', 'a PIN has at most 6 digits'
);
select throws_ok(
  $$select public.set_grownup_pin('1111')$$,
  '22023', 'weak_pin', 'repeated-digit PINs are refused'
);
select throws_ok(
  $$select public.set_grownup_pin('1234')$$,
  '22023', 'weak_pin', 'sequential PINs are refused'
);
select lives_ok($$select public.set_grownup_pin('2580')$$, 'a first PIN needs no elevation');
select results_eq(
  $$select has_pin, failed_attempts from public.get_grownup_pin_status()$$,
  $$values (true, 0)$$,
  'the status now reports a PIN'
);

reset role;
select ok(
  (select pin_hash ~ '^\$2[abxy]\$10\$' and pin_hash <> '2580'
     from public.grownup_pins where user_id = 'a1000000-0000-4000-8000-000000000001'),
  'the PIN is stored only as a bcrypt hash (cost 10)'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- the secret tables are closed to clients -----------------------------------------------------------------------
select throws_ok(
  $$select pin_hash from public.grownup_pins$$,
  '42501', null, 'the PIN hash is never selectable by clients'
);
select throws_ok(
  $$update public.grownup_pins set failed_attempts = 0$$,
  '42501', null, 'clients cannot reset their own lockout counter'
);
select throws_ok(
  $$select * from public.grownup_elevations$$,
  '42501', null, 'elevation rows are not readable by clients'
);
select throws_ok(
  $$insert into public.grownup_elevations (user_id, device_id, expires_at)
    values ('a1000000-0000-4000-8000-000000000001', 'forged', now() + interval '1 day')$$,
  '42501', null, 'clients cannot mint an elevation'
);
select throws_ok(
  $$select public.set_grownup_pin('2468')$$,
  '42501', 'elevation_required', 'changing an existing PIN needs a live elevation'
);

-- wrong guesses and back-off ------------------------------------------------------------------------------------------
select ok(
  (select public.elevate_grownup('dev-1', '0000')) is null,
  'a wrong PIN returns NULL instead of raising (so the attempt counter persists)'
);
select results_eq(
  $$select failed_attempts from public.get_grownup_pin_status()$$,
  array[1],
  'the failed attempt was counted'
);
select is(
  (select private.has_grownup_elevation()),
  false,
  'a wrong PIN grants no elevation'
);
select is(
  (select count(*)::int from generate_series(1, 3) g where public.elevate_grownup('dev-1', '1212') is null),
  3,
  'three more wrong guesses are refused'
);
select results_eq(
  $$select failed_attempts, locked_until is null from public.get_grownup_pin_status()$$,
  $$values (4, true)$$,
  'four failures: counted, not yet locked'
);
select ok(
  (select public.elevate_grownup('dev-1', '3434')) is null,
  'the 5th wrong guess is refused'
);
select is(
  (select locked_until from public.get_grownup_pin_status()),
  now() + interval '30 seconds',
  'the 5th failure locks the PIN for 30 seconds'
);
select ok(
  (select public.elevate_grownup('dev-1', '2580')) is null,
  'while locked even the correct PIN is refused'
);
select results_eq(
  $$select failed_attempts from public.get_grownup_pin_status()$$,
  array[5],
  'attempts made while locked do not change the counter'
);

-- another user is not affected by u1's lockout
set local request.jwt.claims = '{"sub":"b1000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select lives_ok($$select public.set_grownup_pin('1357')$$, 'a second user sets their own PIN while the first is locked');
select ok(
  (select public.elevate_grownup('phone-2', '1357')) is not null,
  'the second user elevates normally: lockout is per user'
);

-- back-off doubles ---------------------------------------------------------------------------------------------------------
reset role;
update public.grownup_pins set locked_until = now() - interval '1 second'
 where user_id = 'a1000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select ok(
  (select public.elevate_grownup('dev-1', '5656')) is null,
  'after the lock expires, a 6th wrong guess is refused'
);
select is(
  (select locked_until from public.get_grownup_pin_status()),
  now() + interval '60 seconds',
  'the 6th failure doubles the lock to 60 seconds'
);

reset role;
update public.grownup_pins set locked_until = now() - interval '1 second'
 where user_id = 'a1000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select ok(
  (select public.elevate_grownup('dev-1', '7878')) is null,
  'a 7th wrong guess is refused'
);
select is(
  (select locked_until from public.get_grownup_pin_status()),
  now() + interval '120 seconds',
  'the 7th failure doubles the lock again to 120 seconds'
);

-- success -----------------------------------------------------------------------------------------------------------------------
reset role;
update public.grownup_pins set locked_until = now() - interval '1 second'
 where user_id = 'a1000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select is(
  (select public.elevate_grownup('dev-1', '2580')),
  now() + interval '10 minutes',
  'the correct PIN after the lock expires opens a 10 minute elevation'
);
select results_eq(
  $$select failed_attempts, locked_until is null from public.get_grownup_pin_status()$$,
  $$values (0, true)$$,
  'success resets the failure counter and the lock'
);
select is((select private.has_grownup_elevation()), true, 'the caller now holds an elevation');

set local request.jwt.claims = '{"sub":"c1000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select is(
  (select private.has_grownup_elevation()),
  false,
  'another user does not inherit the elevation'
);

set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select ok(
  (select public.elevate_grownup('dev-1', '2580')) is not null,
  'elevating again on the same device re-arms it'
);
reset role;
select is(
  (select count(*)::int from public.grownup_elevations where user_id = 'a1000000-0000-4000-8000-000000000001'),
  1,
  'one elevation row per user and device (no unbounded growth)'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select ok(
  (select public.elevate_grownup('dev-2', '2580')) is not null,
  'a second device can elevate too'
);
reset role;
select is(
  (select count(*)::int from public.grownup_elevations where user_id = 'a1000000-0000-4000-8000-000000000001'),
  2,
  'now two elevation rows, one per device'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

-- changing the PIN ---------------------------------------------------------------------------------------------------------------------
select lives_ok($$select public.set_grownup_pin('3690')$$, 'with an elevation the PIN can be changed');
select ok(
  (select public.elevate_grownup('dev-1', '2580')) is null,
  'the old PIN no longer works'
);
select ok(
  (select public.elevate_grownup('dev-1', '3690')) is not null,
  'the new PIN works'
);

-- ending and expiry -------------------------------------------------------------------------------------------------------------------------
select lives_ok($$select public.end_grownup_elevation()$$, 'the caller can end their elevation (back to child mode)');
select is((select private.has_grownup_elevation()), false, 'ending the elevation takes effect immediately');

select ok(
  (select public.elevate_grownup('dev-1', '3690')) is not null,
  'elevating again after ending works'
);
reset role;
update public.grownup_elevations set expires_at = now() - interval '1 second'
 where user_id = 'a1000000-0000-4000-8000-000000000001';
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select is((select private.has_grownup_elevation()), false, 'an expired elevation grants nothing');

-- input validation ---------------------------------------------------------------------------------------------------------------------------------
select throws_ok(
  $$select public.elevate_grownup('', '3690')$$,
  '22023', 'invalid_device_id', 'an empty device id is rejected'
);
select ok(
  (select public.elevate_grownup('dev-1', 'abcd')) is null,
  'a malformed PIN guess is just a failed attempt (no error oracle)'
);

-- audit trail ------------------------------------------------------------------------------------------------------------------------------------------
reset role;
select is((select count(*)::int from public.audit_log where action = 'pin_locked'), 3, 'each lockout was audited');
select is((select count(*)::int from public.audit_log where action = 'pin_set'), 3, 'each PIN set/change was audited');
select is((select count(*)::int from public.audit_log where action = 'elevation_granted'), 6, 'each successful elevation was audited');

select * from finish();
rollback;
