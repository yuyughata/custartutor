-- 000 hardening: structural security posture of the whole schema.
-- Catches the failure modes that RLS policy tests cannot: a table without RLS, a function open to
-- anon, an `authenticated` grant that crept in, a SECURITY DEFINER function without a pinned
-- search_path, append-only tables that regained UPDATE/DELETE.
begin;
create extension if not exists pgtap with schema extensions;
select plan(24);

-- RLS everywhere ------------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind in ('r', 'p') and not c.relrowsecurity),
  0,
  'every table in public has row level security enabled'
);

-- anon gets nothing ---------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private')
      and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and case when c.relkind in ('r', 'p', 'v', 'm', 'f')
               then has_any_column_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
               else false end),
  0,
  'anon has no privilege on any table or view in public/private'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and has_function_privilege('anon', p.oid, 'EXECUTE')),
  0,
  'anon cannot execute any function in public/private'
);

select is(
  (select count(*)::int
     from pg_class c
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname in ('public', 'private')
      and c.relkind = 'S'
      and case when c.relkind = 'S'
               then has_sequence_privilege('anon', c.oid, 'USAGE,SELECT,UPDATE')
               else false end),
  0,
  'anon has no privilege on any sequence'
);

-- authenticated gets only the helpers, wrappers and RPCs that are meant to be callable -------------
-- (tripwire: a new private function that authenticated can execute must be added here on purpose)
select is(
  (select array_agg(p.proname order by p.proname)
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private'
      and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  array[
    'accept_invite', 'can_access_child', 'create_household', 'create_invite',
    'elevate_grownup', 'end_grownup_elevation', 'get_grownup_pin_status', 'grant_child_access',
    'has_admin_role', 'has_grownup_elevation', 'is_granted_tutor', 'is_household_member',
    'member_display_name', 'publish_unit_version', 'remove_member', 'revoke_child_access',
    'set_grownup_pin'
  ]::name[],
  'authenticated can execute exactly the intended private helpers and RPC implementations'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname in ('public', 'private')
      and p.prosecdef
      and coalesce(array_to_string(p.proconfig, ','), '') not like '%search_path=%'),
  0,
  'every SECURITY DEFINER function pins search_path'
);

select is(
  (select count(*)::int
     from pg_proc p
     join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef),
  0,
  'the exposed schema contains no SECURITY DEFINER function (wrappers are SECURITY INVOKER)'
);

-- secret tables: no client privilege of any kind -----------------------------------------------------
select is(
  (select count(*)::int
     from unnest(array['child_secrets', 'invites', 'grownup_pins', 'grownup_elevations']) as t(name)
    where has_any_column_privilege('authenticated', 'public.' || t.name, 'SELECT,INSERT,UPDATE,REFERENCES')
       or has_table_privilege('authenticated', 'public.' || t.name, 'DELETE,TRUNCATE')),
  0,
  'child_secrets, invites, grownup_pins and grownup_elevations have no client privileges'
);

-- append-only tables ---------------------------------------------------------------------------------
select is(
  (select count(*)::int
     from unnest(array['anon', 'authenticated', 'service_role']) as r(role_name)
    cross join unnest(array['public.consents', 'public.audit_log', 'public.published_units']) as t(tbl)
    cross join unnest(array['UPDATE', 'DELETE', 'TRUNCATE']) as p(priv)
    where has_table_privilege(r.role_name, t.tbl, p.priv)),
  0,
  'consents, audit_log and published_units cannot be UPDATEd, DELETEd or TRUNCATEd by any API role'
);

select is(
  (select count(*)::int
     from (values
       ('children', 'DELETE'),
       ('households', 'INSERT'), ('households', 'DELETE'),
       ('household_members', 'INSERT'), ('household_members', 'UPDATE'), ('household_members', 'DELETE'),
       ('child_access', 'INSERT'), ('child_access', 'UPDATE'), ('child_access', 'DELETE'),
       ('published_units', 'INSERT'),
       ('unit_versions', 'DELETE'),
       ('audit_log', 'INSERT'),
       ('consents', 'UPDATE')
     ) as m(tbl, priv)
    where has_table_privilege('authenticated', 'public.' || m.tbl, m.priv)),
  0,
  'authenticated lacks the table privileges that must only be reachable through RPCs'
);

select ok(
  (select coalesce(c.reloptions @> array['security_invoker=true'], false)
     from pg_class c where c.oid = 'public.member_display'::regclass),
  'member_display is a security_invoker view'
);

-- reference data -------------------------------------------------------------------------------------
select results_eq(
  $$select code, stage from public.levels order by sort$$,
  $$values ('P1', 'absorb'), ('P2', 'connect'), ('P3', 'connect'), ('P4', 'connect'),
           ('P5', 'express'), ('P6', 'express')$$,
  'levels P1-P6 are seeded with their stages'
);

select is(
  (select count(*)::int from public.subjects where kind = 'core'),
  8,
  '8 core subjects are seeded'
);

select is(
  (select array_agg(slug order by slug) from public.subjects where kind = 'elective'),
  array['french', 'ict', 'pre-vocational-studies', 'religion-studies'],
  'the 4 electives are seeded'
);

select is(
  (select count(*)::int from public.subjects
    where slug in ('english-studies', 'mathematics', 'basic-science', 'social-studies',
                   'civic-education', 'cultural-creative-arts', 'nigerian-language',
                   'physical-health-education') and kind = 'core'),
  8,
  'core subject slugs match the plan'
);

select is(
  (select count(*)::int from public.characters
    where slug in ('zari', 'zuri') and traits = '{}'::jsonb and voice = '{}'::jsonb),
  2,
  'Zari and Zuri are seeded as empty stubs (character bible pending)'
);

-- anon is rejected at the door ------------------------------------------------------------------------
set local role anon;

select throws_ok($$select * from public.children$$, '42501', null, 'anon cannot read children');
select throws_ok($$select * from public.levels$$, '42501', null, 'anon cannot even read reference data');
select throws_ok($$select * from public.published_units$$, '42501', null, 'anon cannot read published units');
select throws_ok($$select * from public.member_display$$, '42501', null, 'anon cannot read member_display');
select throws_ok($$select public.create_household('x')$$, '42501', null, 'anon cannot call create_household');
select throws_ok($$select public.elevate_grownup('device-1', '2580')$$, '42501', null, 'anon cannot call elevate_grownup');
select throws_ok(
  $$select public.publish_unit_version('00000000-0000-4000-8000-000000000000')$$,
  '42501', null, 'anon cannot call publish_unit_version'
);

reset role;

-- a signed-in role without a user id is not a user ---------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.create_household('x')$$,
  '42501', 'not_authenticated', 'RPCs reject a JWT without sub'
);
reset role;

select * from finish();
rollback;
