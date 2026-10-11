-- 060 sync support: sync_seq is a server-stamped global cursor, removal is a tombstone.
--   The client pull cursor is sync_seq (not updated_at). Rows are never hard-deleted on syncable
--   tables, so offline clients can purge. Clients can neither set nor read the sequence.
begin;
create extension if not exists pgtap with schema extensions;
select plan(13);

-- gA a1..01 guardian | tU c1..03 tutor of child Ada
insert into auth.users (id, email) values
  ('a1000000-0000-4000-8000-000000000001', 'ga@test.local'),
  ('c1000000-0000-4000-8000-000000000003', 'tu@test.local');
insert into public.households (id, name, created_by) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Household A', 'a1000000-0000-4000-8000-000000000001');
insert into public.household_members (household_id, user_id, role) values
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'a1000000-0000-4000-8000-000000000001', 'guardian'),
  ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003', 'tutor');
insert into public.children (id, household_id, display_alias, level_code) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Ada', 'P1');
insert into public.child_access (child_id, household_id, tutor_user_id, granted_by) values
  ('ca000001-0000-4000-8000-000000000001', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
   'c1000000-0000-4000-8000-000000000003', 'a1000000-0000-4000-8000-000000000001');
insert into public.grownup_elevations (user_id, device_id, expires_at)
values ('a1000000-0000-4000-8000-000000000001', 'test-device', now() + interval '10 minutes');

-- remembered cursor values
create temp table sq (k text primary key, v bigint not null);
grant all on sq to public;
insert into sq select 'child', sync_seq from public.children where id = 'ca000001-0000-4000-8000-000000000001';
insert into sq select 'access', sync_seq from public.child_access
 where child_id = 'ca000001-0000-4000-8000-000000000001';
insert into sq select 'member', sync_seq from public.household_members
 where user_id = 'c1000000-0000-4000-8000-000000000003';

-- the cursor is stamped by the server --------------------------------------------------------------------------------
select is(
  (select count(*)::int from public.levels where sync_seq = 0),
  0,
  'seeded levels carry a server-assigned sync_seq'
);
select is(
  (select count(*)::int from public.subjects where sync_seq = 0),
  0,
  'seeded subjects carry a server-assigned sync_seq'
);

insert into public.children (id, household_id, display_alias, level_code, sync_seq)
values ('ca000002-0000-4000-8000-000000000002', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'Bayo', 'P1', 1);
select cmp_ok(
  (select sync_seq from public.children where id = 'ca000002-0000-4000-8000-000000000002'),
  '>',
  1::bigint,
  'a sync_seq supplied on insert is overwritten by the trigger'
);

update public.children set display_alias = 'Ada R' where id = 'ca000001-0000-4000-8000-000000000001';
select cmp_ok(
  (select sync_seq from public.children where id = 'ca000001-0000-4000-8000-000000000001'),
  '>',
  (select v from sq where k = 'child'),
  'every update moves the row''s sync_seq forward'
);

insert into public.subjects (slug, name, kind, curriculum_source) values ('sync-test', 'Sync Test', 'extracurricular', 'global');
select cmp_ok(
  (select sync_seq from public.subjects where slug = 'sync-test'),
  '>',
  (select max(sync_seq) from public.children),
  'the sequence is global across tables'
);

-- clients cannot touch the cursor --------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"a1000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';

select throws_ok(
  $$insert into public.children (household_id, display_alias, level_code, sync_seq)
    values ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'X', 'P1', 99)$$,
  '42501', null, 'clients cannot set sync_seq on insert'
);
select throws_ok(
  $$update public.children set sync_seq = 1 where id = 'ca000001-0000-4000-8000-000000000001'$$,
  '42501', null, 'clients cannot set sync_seq on update'
);

-- tombstones --------------------------------------------------------------------------------------------------------------------
insert into sq select 'child2', sync_seq from public.children where id = 'ca000001-0000-4000-8000-000000000001';
update public.children set deleted_at = now() where id = 'ca000001-0000-4000-8000-000000000001';
select results_eq(
  $$select deleted_at is not null, sync_seq > (select v from sq where k = 'child2')
      from public.children where id = 'ca000001-0000-4000-8000-000000000001'$$,
  $$values (true, true)$$,
  'a soft-deleted child stays selectable with a newer sync_seq (tombstone)'
);

select public.revoke_child_access('ca000001-0000-4000-8000-000000000001', 'c1000000-0000-4000-8000-000000000003');
select results_eq(
  $$select revoked_at is not null, deleted_at is not null, sync_seq > (select v from sq where k = 'access')
      from public.child_access where child_id = 'ca000001-0000-4000-8000-000000000001'$$,
  $$values (true, true, true)$$,
  'a revoked tutor grant is a tombstone with a newer sync_seq'
);

select public.remove_member('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'c1000000-0000-4000-8000-000000000003');
select results_eq(
  $$select status, deleted_at is not null, sync_seq > (select v from sq where k = 'member')
      from public.household_members where user_id = 'c1000000-0000-4000-8000-000000000003'$$,
  $$values ('removed', true, true)$$,
  'a removed member is a tombstone with a newer sync_seq'
);

reset role;

-- structure -------------------------------------------------------------------------------------------------------------------------
select is(
  (select count(*)::int from pg_indexes
    where schemaname = 'public'
      and tablename in ('children', 'household_members', 'child_access', 'levels', 'subjects',
                        'chapters', 'units', 'published_units')
      and indexdef ~ '\(sync_seq\)$'),
  8,
  'all eight syncable tables have an index on sync_seq'
);
select is(
  (select count(*)::int
     from unnest(array['children', 'household_members', 'child_access', 'levels', 'subjects',
                       'chapters', 'units', 'published_units']) as t(name)
    where exists (select 1 from information_schema.columns c
                   where c.table_schema = 'public' and c.table_name = t.name
                     and c.column_name = 'sync_seq' and c.data_type = 'bigint' and c.is_nullable = 'NO')
      and exists (select 1 from information_schema.columns c
                   where c.table_schema = 'public' and c.table_name = t.name
                     and c.column_name = 'deleted_at' and c.data_type = 'timestamp with time zone')),
  8,
  'all eight syncable tables have sync_seq (bigint, not null) and a deleted_at tombstone column'
);
select is(
  has_sequence_privilege('authenticated', 'public.sync_seq_global', 'USAGE'),
  false,
  'clients have no privilege on the sync sequence (the trigger is SECURITY DEFINER)'
);

select * from finish();
rollback;
