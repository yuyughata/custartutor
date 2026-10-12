-- 120 M2.4 unit layout: apply_unit_layout (units added, removed and reordered by hand, 3 to 5 per chapter).
--   * access: super_admin and content_editor at aal2 only
--   * the layout must be complete and current (layout_out_of_date), well formed, 3 to 5 units per chapter
--   * numbering: dense term-wide ordinals; a unit with versions is renumbered only with p_confirm_renumber, is never
--     edited or removed, and a published unit never leaves its chapter
--   * removal archives (the row stays, the number is parked); an unchanged layout writes nothing; atomic; locks the scheme
--   * apply_chapter_plan and publish_unit_version keep working next to it
begin;
create extension if not exists pgtap with schema extensions;
select plan(145);

-- sa f8..01 super_admin | ed ..02 content_editor | rv ..03 reviewer | sup ..04 support | ana ..05 analyst | pl ..06 plain
insert into auth.users (id, email) values
  ('f8000000-0000-4000-8000-000000000001', 'l8sa@test.local'),
  ('f8000000-0000-4000-8000-000000000002', 'l8ed@test.local'),
  ('f8000000-0000-4000-8000-000000000003', 'l8rv@test.local'),
  ('f8000000-0000-4000-8000-000000000004', 'l8sup@test.local'),
  ('f8000000-0000-4000-8000-000000000005', 'l8ana@test.local'),
  ('f8000000-0000-4000-8000-000000000006', 'l8pl@test.local');
insert into public.admin_users (user_id, role) values
  ('f8000000-0000-4000-8000-000000000001', 'super_admin'),
  ('f8000000-0000-4000-8000-000000000002', 'content_editor'),
  ('f8000000-0000-4000-8000-000000000003', 'reviewer'),
  ('f8000000-0000-4000-8000-000000000004', 'support'),
  ('f8000000-0000-4000-8000-000000000005', 'analyst');

create temp table sch (label text primary key, id uuid not null);
grant all on sch to public;
create temp table ids (label text primary key, id uuid not null);
grant all on ids to public;
create temp table res (label text primary key, r jsonb not null);
grant all on res to public;
create temp table errs (label text primary key, msg text, detail text);
grant all on errs to public;
create temp table snap (label text primary key, v text);
grant all on snap to public;

-- helpers: test-only, owned by the test owner and SECURITY DEFINER so a layout can be built while impersonating anybody ---------
create schema t120;
grant usage on schema t120 to public;
create function t120.u(p_label text) returns uuid language sql stable security definer set search_path = public, pg_temp
  as $f$ select id from pg_temp.ids where label = p_label $f$;
create function t120.s(p_label text default 'main') returns uuid language sql stable security definer set search_path = public, pg_temp
  as $f$ select id from pg_temp.sch where label = p_label $f$;
-- the live unit numbers of a scheme in teaching order: "chapter:unit_no/label" (the label only for units known by `ids`)
create function t120.nums(p_scheme uuid) returns text language sql stable security definer set search_path = public, pg_temp as $f$
  select string_agg(c.number || ':' || u.unit_no || coalesce('/' || (select i.label from pg_temp.ids i where i.id = u.id), ''),
                    ' ' order by c.number, u.unit_no)
    from public.units u join public.chapters c on c.id = u.chapter_id
   where c.scheme_id = p_scheme and u.deleted_at is null and u.status <> 'archived';
$f$;
-- a new-unit entry
create function t120.fresh(p_title text, p_extra jsonb default '{}') returns jsonb language sql immutable as $f$
  select jsonb_build_object('new', jsonb_build_object('title', p_title, 'objective', 'Objective for ' || p_title,
                                                      'kind', 'lesson', 'stage', 'absorb') || p_extra)
$f$;
-- A layout document from a spec. A spec is an array of chapters in order; a chapter is an array of unit entries (it
-- refers to the EXISTING chapter at that position) or {"new": "Title", "units": [...]} (a new chapter). A unit entry is
-- a label ("u3"), {"label": "u3", "set": {...}} or {"new": {...}} as the RPC takes it.
create function t120.lay(p_scheme uuid, p_spec jsonb, p_removed jsonb default '[]') returns jsonb
language plpgsql stable security definer set search_path = public, pg_temp as $f$
declare
  v_chapters jsonb := '[]';
  v_ch jsonb;
  v_pos int := 0;
  v_ids uuid[];
  v_units jsonb;
  v_u jsonb;
  v_entry jsonb;
begin
  select array_agg(c.id order by c.number) into v_ids
    from public.chapters c where c.scheme_id = p_scheme and c.deleted_at is null and c.status <> 'archived';
  for v_ch in select e.value from jsonb_array_elements(p_spec) with ordinality e(value, n) order by e.n loop
    v_pos := v_pos + 1;
    v_units := '[]';
    for v_u in
      select e.value from jsonb_array_elements(case when jsonb_typeof(v_ch) = 'array' then v_ch else v_ch -> 'units' end)
             with ordinality e(value, n) order by e.n
    loop
      v_entry := case jsonb_typeof(v_u)
        when 'string' then jsonb_build_object('id', t120.u(v_u #>> '{}'))
        else case when v_u ? 'label' then jsonb_build_object('id', t120.u(v_u ->> 'label')) || (v_u - 'label') else v_u end
      end;
      v_units := v_units || v_entry;
    end loop;
    v_chapters := v_chapters || case
      when jsonb_typeof(v_ch) = 'array' then jsonb_build_object('id', v_ids[v_pos], 'units', v_units)
      else jsonb_build_object('new', jsonb_build_object('title', v_ch ->> 'new'), 'units', v_units)
    end;
  end loop;
  return jsonb_build_object('chapters', v_chapters,
    'removed', (select coalesce(jsonb_agg(t120.u(x)), '[]') from jsonb_array_elements_text(p_removed) x));
end $f$;
-- the current layout, as a spec would give it
create function t120.cur(p_scheme uuid) returns jsonb language sql stable security definer set search_path = public, pg_temp as $f$
  select jsonb_build_object('chapters', coalesce(jsonb_agg(jsonb_build_object('id', c.id, 'units', coalesce((
           select jsonb_agg(jsonb_build_object('id', u.id) order by u.unit_no)
             from public.units u where u.chapter_id = c.id and u.deleted_at is null and u.status <> 'archived'
         ), '[]'::jsonb)) order by c.number), '[]'::jsonb))
    from public.chapters c where c.scheme_id = p_scheme and c.deleted_at is null and c.status <> 'archived';
$f$;

-- fixtures: scheme "main" (8 weeks, approved, planned 4 + 4), a draft scheme ------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
insert into sch select 'main', public.save_scheme_draft(
  (select id from public.subjects where slug = 'mathematics'), 'P3', 2,
  (select jsonb_agg(jsonb_build_object('week_no', g, 'kind', 'teaching', 'topic', 'Topic ' || g, 'subtopics', '[]'::jsonb) order by g)
     from generate_series(1, 8) g),
  'layout test');
insert into sch select 'plan2', public.save_scheme_draft(
  (select id from public.subjects where slug = 'mathematics'), 'P3', 3,
  (select jsonb_agg(jsonb_build_object('week_no', g, 'kind', 'teaching', 'topic', 'Topic ' || g, 'subtopics', '[]'::jsonb) order by g)
     from generate_series(1, 8) g),
  null);
insert into sch select 'draft', public.save_scheme_draft(
  (select id from public.subjects where slug = 'mathematics'), 'P5', 1,
  '[{"week_no":1,"kind":"teaching","topic":"T","subtopics":[]}]'::jsonb, null);
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select public.approve_scheme(t120.s('main'));
select public.approve_scheme(t120.s('plan2'));
reset role;
create temp table plan8 (doc jsonb);
grant all on plan8 to public;
insert into plan8 values (jsonb_build_object('chapters', jsonb_build_array(
  jsonb_build_object('chapter_no', 1, 'title', 'Our Environment', 'theme', jsonb_build_object('title', 'Clean Places', 'lens', 'Observation'),
    'units', (select jsonb_agg(jsonb_build_object('unit_no', g, 'week_no', g, 'kind', 'lesson', 'title', 'Unit ' || g,
                'objective', 'Objective ' || g, 'stage', 'absorb', 'periods', 1) order by g) from generate_series(1, 4) g)),
  jsonb_build_object('chapter_no', 2, 'title', 'Our Homes',
    'units', (select jsonb_agg(jsonb_build_object('unit_no', g, 'week_no', g, 'kind', 'lesson', 'title', 'Unit ' || g,
                'objective', 'Objective ' || g, 'stage', 'connect', 'periods', 1) order by g) from generate_series(5, 8) g))
)));
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select public.apply_chapter_plan(t120.s('main'), (select doc from plan8));
select public.apply_chapter_plan(t120.s('plan2'), (select doc from plan8));
reset role;
insert into ids
  select 'u' || u.unit_no, u.id from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s('main');
insert into ids
  select 'p' || u.unit_no, u.id from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s('plan2');
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8', 'fixture: the plan made 2 chapters of 4 units');

-- versions: u2 gets a version that is approved and PUBLISHED, u6 gets a DRAFT version -----------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
insert into res select 'v2', public.create_unit_version_draft(t120.u('u2'), '{"schema_version":1,"header":{}}', null, 'human', null, null, null);
insert into res select 'v6', public.create_unit_version_draft(t120.u('u6'), '{"schema_version":1,"header":{}}', null, 'human', null, null, null);
select public.set_unit_version_status((select (r ->> 'id')::uuid from res where label = 'v2'), 'in_review');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select public.set_unit_version_status((select (r ->> 'id')::uuid from res where label = 'v2'), 'approved');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select public.publish_unit_version((select (r ->> 'id')::uuid from res where label = 'v2'));
reset role;
select results_eq(
  $$select u.status, (select count(*)::int from public.unit_versions v where v.unit_id = u.id),
           (select count(*)::int from public.published_units p where p.unit_id = u.id)
      from public.units u where u.id in (t120.u('u2'), t120.u('u6')) order by u.unit_no$$,
  $$values ('published', 1, 1), ('draft', 1, 0)$$,
  'fixture: u2 is published, u6 has a draft version'
);
insert into snap select 'published_content', (select content::text from public.published_units where unit_id = t120.u('u2'));
insert into snap select 'versions', (select string_agg(v.id::text || v.status || v.version, ',' order by v.id) from public.unit_versions v where v.unit_id in (t120.u('u2'), t120.u('u6')));

-- A. access ------------------------------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', null, 'anon cannot call apply_unit_layout');
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'an ordinary user is refused');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'a reviewer is refused');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'support is refused');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'an analyst is refused');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'a content_editor at aal1 is refused');
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok($$select public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$, '42501', 'admin_role_required', 'a super_admin at aal1 is refused');
reset role;

-- B. the scheme ----------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout('00000000-0000-4000-8000-0000000000ff', '{"chapters":[]}')$$,
  'P0002', 'scheme_not_found', 'an unknown scheme is a clean error'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s('draft'), '{"chapters":[]}')$$,
  '22023', 'scheme_not_approved', 'a scheme that is not approved has no layout'
);

-- C. a malformed layout is refused before anything is touched ------------------------------------------------------------------------
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$, c.doc),
  '22023', c.msg, 'layout refused: ' || c.label
)
from (values
  ('null layout', null, 'invalid_unit_layout'),
  ('not an object', '[1]', 'invalid_unit_layout'),
  ('no chapters key', '{}', 'invalid_unit_layout'),
  ('chapters not an array', '{"chapters":{}}', 'invalid_unit_layout'),
  ('empty chapters', '{"chapters":[]}', 'invalid_unit_layout'),
  ('removed not an array', '{"chapters":[{"units":[1]}],"removed":5}', 'invalid_unit_layout'),
  ('chapter not an object', '{"chapters":[5]}', 'invalid_unit_layout'),
  ('chapter without units', '{"chapters":[{"id":"00000000-0000-4000-8000-0000000000aa"}]}', 'invalid_unit_layout'),
  ('chapter with 2 units', '{"chapters":[{"units":[{},{}]}]}', 'chapter_unit_count_invalid'),
  ('chapter with 6 units', '{"chapters":[{"units":[{},{},{},{},{},{}]}]}', 'chapter_unit_count_invalid'),
  ('chapter id not a uuid', '{"chapters":[{"id":"x","units":[{},{},{}]}]}', 'invalid_unit_layout'),
  ('chapter neither id nor new', '{"chapters":[{"units":[{},{},{}]}]}', 'invalid_unit_layout'),
  ('new chapter without a title', '{"chapters":[{"new":{},"units":[{},{},{}]}]}', 'invalid_unit_layout')
) as c(label, doc, msg);
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$, jsonb_set(t120.cur(t120.s()), '{chapters,0,id}', '"00000000-0000-4000-8000-0000000000aa"')),
  'P0002', 'chapter_not_in_scheme', 'a chapter that is not in the scheme is refused'
);
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$,
         jsonb_build_object('chapters', jsonb_build_array(t120.cur(t120.s()) #> '{chapters,1}', t120.cur(t120.s()) #> '{chapters,0}'))),
  '22023', 'chapter_order_changed', 'existing chapters keep their order'
);
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$,
         jsonb_set(t120.cur(t120.s()), c.path::text[],
                   replace(replace(c.entry::text, '"X"', to_jsonb(t120.u('u2'))::text), '"Y"', to_jsonb(t120.u('u3'))::text)::jsonb)),
  '22023', c.msg, c.label
)
from (values
  ('a unit id must be a uuid', '{chapters,0,units,0}', '{"id":"nope"}'::jsonb, 'invalid_unit_layout'),
  ('a unit entry must be an object', '{chapters,0,units,0}', '5', 'invalid_unit_layout'),
  ('a unit entry needs an id or a new block', '{chapters,0,units,0}', '{}', 'invalid_unit_layout'),
  ('a unit cannot appear twice', '{chapters,0,units,0}', '{"id":"X"}', 'duplicate_unit_in_layout'),
  ('a new unit needs a title', '{chapters,0,units,0}', '{"new":{"objective":"o","kind":"lesson","stage":"absorb"}}', 'invalid_layout_unit'),
  ('a new unit needs a non-blank title', '{chapters,0,units,0}', '{"new":{"title":"  ","objective":"o","kind":"lesson","stage":"absorb"}}', 'invalid_layout_unit'),
  ('a new unit needs an objective', '{chapters,0,units,0}', '{"new":{"title":"t","kind":"lesson","stage":"absorb"}}', 'invalid_layout_unit'),
  ('a new unit needs a known kind', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"party","stage":"absorb"}}', 'invalid_layout_unit'),
  ('a new unit needs a known stage', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"later"}}', 'invalid_layout_unit'),
  ('periods 0', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","periods":0}}', 'invalid_layout_unit'),
  ('periods 11', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","periods":11}}', 'invalid_layout_unit'),
  ('week_no 16', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","week_no":16}}', 'invalid_layout_unit'),
  ('week_no as text', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","week_no":"3"}}', 'invalid_layout_unit'),
  ('blank lens', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","lens":" "}}', 'invalid_layout_unit'),
  ('a week the scheme does not have', '{chapters,0,units,0}', '{"new":{"title":"t","objective":"o","kind":"lesson","stage":"absorb","week_no":12}}', 'unknown_scheme_week'),
  ('a set block is validated too', '{chapters,0,units,2}', '{"id":"Y","set":{"kind":"party"}}', 'invalid_layout_unit'),
  ('a set block must be an object', '{chapters,0,units,2}', '{"id":"Y","set":5}', 'invalid_layout_unit')
) as c(label, path, entry, msg)
where true;

-- D. the layout must be complete and current -----------------------------------------------------------------------------------------
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$, t120.cur(t120.s()) #- '{chapters,0,units,3}'),
  '22023', 'layout_out_of_date', 'a unit missing from the layout (and not named in removed) is a stale page'
);
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$, jsonb_build_object('chapters', jsonb_build_array(t120.cur(t120.s()) #> '{chapters,0}'))),
  '22023', 'layout_out_of_date', 'a chapter missing from the layout is a stale page'
);
select throws_ok(
  format($q$select public.apply_unit_layout(t120.s(), %L::jsonb)$q$,
         t120.cur(t120.s()) || jsonb_build_object('removed', jsonb_build_array('00000000-0000-4000-8000-0000000000bb'))),
  'P0002', 'unit_not_in_scheme', 'removing a unit that is not in the scheme is refused'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8', 'none of the refused layouts changed anything');

-- E. an unchanged layout writes nothing ------------------------------------------------------------------------------------------------
insert into snap select 'seq_before', (select string_agg(u.id::text || ':' || u.sync_seq, ',' order by u.id) from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s());
insert into snap select 'audit_before', (select count(*)::text from public.audit_log where action = 'unit_layout_applied');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'noop', public.apply_unit_layout(t120.s(), t120.cur(t120.s()))$$,
  'the current layout can be applied (a content_editor at aal2)'
);
reset role;
select results_eq(
  $$select r ->> 'units_created', r ->> 'units_updated', r ->> 'units_moved', r ->> 'units_renumbered', r ->> 'units_archived', r ->> 'chapters_created', r ->> 'chapters', r ->> 'units'
      from res where label = 'noop'$$,
  $$values ('0', '0', '0', '0', '0', '0', '2', '8')$$,
  'an unchanged layout reports nothing changed'
);
select is(
  (select string_agg(u.id::text || ':' || u.sync_seq, ',' order by u.id) from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s()),
  (select v from snap where label = 'seq_before'),
  'idempotent: no unit was stamped (no sync_seq drawn)'
);
select is(
  (select count(*)::text from public.audit_log where action = 'unit_layout_applied'),
  (select v from snap where label = 'audit_before'),
  'idempotent: no audit row for a no-op'
);
select is(jsonb_array_length((select r -> 'layout' from res where label = 'noop')), 2, 'the result always carries the resulting layout');

-- F. locking: the call takes the scheme row FOR UPDATE (its xmax becomes this transaction), units that do not change stay free --------
insert into public.schemes (id, subject_id, level_code, term, status)
  values ('f8000000-0000-4000-8000-0000000000a1', (select id from public.subjects where slug = 'mathematics'), 'P4', 1, 'approved');
insert into sch values ('probe', 'f8000000-0000-4000-8000-0000000000a1');
insert into public.chapters (id, scheme_id, number, title) values ('f8000000-0000-4000-8000-0000000000b1', t120.s('probe'), 1, 'Probe');
insert into public.units (id, chapter_id, unit_no, kind, title, objective, stage) values
  ('f8000000-0000-4000-8000-0000000000c1', 'f8000000-0000-4000-8000-0000000000b1', 1, 'lesson', 'P1', 'o', 'absorb'),
  ('f8000000-0000-4000-8000-0000000000c2', 'f8000000-0000-4000-8000-0000000000b1', 2, 'lesson', 'P2', 'o', 'absorb'),
  ('f8000000-0000-4000-8000-0000000000c3', 'f8000000-0000-4000-8000-0000000000b1', 3, 'lesson', 'P3', 'o', 'absorb');
select is((select s.xmax::text from public.schemes s where s.id = t120.s('probe')), '0', 'before: nothing holds the probe scheme row');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.apply_unit_layout(t120.s('probe'), t120.cur(t120.s('probe')))$$, 'a super_admin at aal2 applies a layout');
reset role;
select is(
  (select s.xmax::text from public.schemes s where s.id = t120.s('probe')),
  (pg_current_xact_id()::xid)::text,
  'the scheme row is locked FOR UPDATE by the call (it serialises with apply_chapter_plan and with other layouts)'
);
select is(
  (select count(*)::int from public.units u where u.chapter_id = 'f8000000-0000-4000-8000-0000000000b1' and u.xmax::text <> '0'),
  0,
  'units that do not change are not locked'
);

-- G. adding a unit: the last chapter takes a fifth unit without renumbering anything that has versions ------------------------------
insert into snap select 'audit_before_add', (select count(*)::text from public.audit_log where action = 'unit_layout_applied');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'add_last', public.apply_unit_layout(t120.s(),
      t120.lay(t120.s(), jsonb_insert('[["u1","u2","u3","u4"],["u5","u6","u7","u8"]]', '{1,-1}',
               t120.fresh('Caring for animals', '{"week_no":4,"periods":2,"stage":"connect"}'), true)))$$,
  'a fifth unit is added to the last chapter by hand'
);
reset role;
select results_eq(
  $$select r ->> 'units_created', r ->> 'units_renumbered', r ->> 'units_moved', r ->> 'units', jsonb_array_length(r -> 'created_unit_ids')::text
      from res where label = 'add_last'$$,
  $$values ('1', '0', '0', '9', '1')$$,
  'one unit created, nothing renumbered, the created id is returned'
);
insert into ids select 'n9', (r -> 'created_unit_ids' ->> 0)::uuid from res where label = 'add_last';
select results_eq(
  $$select u.unit_no, u.kind, u.stage, u.periods, u.week_no, u.status, u.title, u.objective, u.deleted_at is null
      from public.units u where u.id = t120.u('n9')$$,
  $$values (9, 'lesson', 'connect', 2, 4, 'draft', 'Caring for animals', 'Objective for Caring for animals', true)$$,
  'the new unit is a draft with the fields it was given, numbered 9'
);
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8 2:9/n9', 'numbering stays dense and ordered');
select is(
  (select count(*)::text from public.audit_log where action = 'unit_layout_applied'),
  ((select v::int + 1 from snap where label = 'audit_before_add')::text),
  'a real change writes exactly one audit row'
);

-- H. 3 to 5 at both ends -----------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u1","u2","u3","u4"],["u5","u6","u7","u8","n9"]]', '{1,-1}', t120.fresh('A sixth unit'), true)))$$,
  '22023', 'chapter_unit_count_invalid', 'top end: a sixth unit in a chapter is refused'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u1","u2"],["u5","u6","u7","u8","n9"]]', '["u3","u4"]'))$$,
  '22023', 'chapter_unit_count_invalid', 'bottom end: removing two units would leave a chapter of 2'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8 2:9/n9', 'nothing changed after the refused layouts');

-- I. adding in an EARLIER chapter shifts later numbers: units with versions need the explicit confirmation -------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u1","u2","u3","u4"],["u5","u6","u7","u8","n9"]]', '{0,-1}', t120.fresh('Keeping the school clean', '{"lens":"Observation"}'), true)))$$,
  '22023', 'layout_renumbers_versioned_units', 'adding to chapter 1 would renumber u6 (it has a draft version): needs confirmation'
);
do $$
declare v_detail text;
begin
  perform public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u1","u2","u3","u4"],["u5","u6","u7","u8","n9"]]', '{0,-1}', t120.fresh('Keeping the school clean', '{"lens":"Observation"}'), true)));
exception when others then
  get stacked diagnostics v_detail = pg_exception_detail;
  insert into errs values ('renumber', sqlerrm, v_detail);
end $$;
reset role;
select is(
  (select detail::jsonb from errs where label = 'renumber'),
  jsonb_build_array(jsonb_build_object('id', t120.u('u6'), 'title', 'Unit 6', 'from', 6, 'to', 7)),
  'the error DETAIL lists exactly the unit with versions whose number would change'
);
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8 2:9/n9', 'the refused layout changed nothing');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'add_first', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u1","u2","u3","u4"],["u5","u6","u7","u8","n9"]]', '{0,-1}', t120.fresh('Keeping the school clean', '{"lens":"Observation"}'), true)), true)$$,
  'with p_confirm_renumber the same layout is applied'
);
reset role;
insert into ids select 'n5', (r -> 'created_unit_ids' ->> 0)::uuid from res where label = 'add_first';
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u3 1:4/u4 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9', 'the later units moved up by one, still dense');
select results_eq(
  $$select r ->> 'units_created', r ->> 'units_renumbered', r ->> 'units_moved' from res where label = 'add_first'$$,
  $$values ('1', '5', '0')$$,
  'one created, five renumbered (u5 to u8 and n9), none moved'
);
select is(
  (select string_agg(v.id::text || v.status || v.version, ',' order by v.id) from public.unit_versions v where v.unit_id in (t120.u('u2'), t120.u('u6'))),
  (select v from snap where label = 'versions'),
  'the versions themselves are untouched'
);
select is(
  (select content::text from public.published_units where unit_id = t120.u('u2')), (select v from snap where label = 'published_content'),
  'the published snapshot is never touched'
);
select results_eq(
  $$select tu.lens, tu.theme_id = c.theme_id from public.theme_units tu join public.units u on u.id = tu.unit_id
      join public.chapters c on c.id = u.chapter_id where tu.unit_id = t120.u('n5')$$,
  $$values ('Observation', true)$$,
  'a new unit with a lens in a themed chapter is linked to the chapter theme'
);

-- J. reorder inside a chapter: version-less units swap numbers freely -----------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'swap', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u1","u2","u4","u3","n5"],["u5","u6","u7","u8","n9"]]'))$$,
  'two units without versions swap places (the unique constraint is satisfied by the two-pass renumbering)'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u1 1:2/u2 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9', 'u4 and u3 swapped numbers');
select results_eq(
  $$select r ->> 'units_renumbered', r ->> 'units_moved', r ->> 'units_updated' from res where label = 'swap'$$,
  $$values ('2', '0', '0')$$,
  'two renumbered, none moved, none edited'
);

-- K. the published unit may change place inside its chapter, with confirmation, and stays published --------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u1","u4","u3","n5"],["u5","u6","u7","u8","n9"]]'))$$,
  '22023', 'layout_renumbers_versioned_units', 'moving the published u2 to the front needs the confirmation'
);
select lives_ok(
  $$insert into res select 'publ_reorder', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u1","u4","u3","n5"],["u5","u6","u7","u8","n9"]]'), true)$$,
  'confirmed, the published unit takes the first place'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9', 'u2 is Unit 1 now and u1 Unit 2');
select results_eq(
  $$select u.status, (select content::text from public.published_units p where p.unit_id = u.id) = (select v from snap where label = 'published_content')
      from public.units u where u.id = t120.u('u2')$$,
  $$values ('published', true)$$,
  'u2 is still published and its snapshot is byte for byte the same'
);

-- L. removal archives: the row stays, the number is parked, the slot is free --------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'remove_n9', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u1","u4","u3","n5"],["u5","u6","u7","u8"]]', '["n9"]'))$$,
  'a unit without versions is removed'
);
reset role;
select results_eq(
  $$select r ->> 'units_archived', r ->> 'units_renumbered', r ->> 'units' from res where label = 'remove_n9'$$,
  $$values ('1', '0', '9')$$,
  'one archived, nothing renumbered (it was the last), 9 live units'
);
select results_eq(
  $$select u.status, u.deleted_at is not null, u.unit_no >= 10000, u.chapter_id is not null
      from public.units u where u.id = t120.u('n9')$$,
  $$values ('archived', true, true, true)$$,
  'archived, not deleted: the row stays, tombstoned, with a parked number'
);
select is(
  (select count(*)::int from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s()), 10,
  'the scheme still has 10 unit rows (9 live + 1 archived)'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u1","u4","u3","n9"],["u5","u6","u7","u8"]]'))$$,
  'P0002', 'unit_not_in_scheme', 'an archived unit is no longer part of the scheme: a layout that still names it is refused'
);
select throws_ok(
  $$select public.create_unit_version_draft(t120.u('n9'), '{"schema_version":1,"header":{}}', null, 'human', null, null, null)$$,
  '22023', 'unit_not_editable', 'an archived unit cannot get a version'
);
-- the freed slot is reusable: the unit that was 10 is gone, a new fifth unit takes number 10 again
select lives_ok(
  $$insert into res select 'reuse', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u2","u1","u4","u3","n5"],["u5","u6","u7","u8"]]', '{1,-1}', t120.fresh('Reusing the slot'), true)))$$,
  'the number of an archived unit can be given to a new unit'
);
reset role;
insert into ids select 'n10', (r -> 'created_unit_ids' ->> 0)::uuid from res where label = 'reuse';
select is(t120.nums(t120.s()), '1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n10', 'live numbers are dense again');

-- M. moving between chapters ---------------------------------------------------------------------------------------------------------
-- (n10 leaves chapter 2 and n5 moves from chapter 1 to the top of chapter 2: 4 and 5 units)
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'move', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u1","u4","u3","n10"],["n5","u5","u6","u7","u8"]]'))$$,
  'a unit without versions moves to the next chapter (n5) while another takes its place (n10)'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n10 2:6/n5 2:7/u5 2:8/u6 2:9/u7 2:10/u8', 'both chapters keep 5 units and the numbers stay dense');
select results_eq(
  $$select r ->> 'units_moved', r ->> 'units_renumbered' from res where label = 'move'$$,
  $$values ('2', '5')$$,
  'two units changed chapter; five numbers changed'
);
select is(
  (select count(*)::int from public.theme_units tu where tu.unit_id = t120.u('n5')), 0,
  'a unit that leaves a themed chapter loses its link to that theme'
);

-- N. a published unit never leaves its chapter; a draft-versioned unit may, with confirmation --------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["n10","u1","u4","u3"],["u2","n5","u5","u6","u7","u8"]]'))$$,
  '22023', 'chapter_unit_count_invalid', 'swapping u2 into chapter 2 would make that chapter 6: count refused first'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["n5","u1","u4","u3","n10"],["u2","u5","u6","u7","u8"]]'), true)$$,
  '22023', 'published_unit_cannot_move', 'a published unit cannot leave its chapter, even with the confirmation'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]'))$$,
  '22023', 'layout_renumbers_versioned_units', 'a unit with a draft version may move chapter, but only with the confirmation'
);
select lives_ok(
  $$insert into res select 'swap_chapters', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]'), true)$$,
  'confirmed, u6 moves to chapter 1 and u1 to chapter 2'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u2 1:2/u6 1:3/u4 1:4/u3 1:5/n10 2:6/n5 2:7/u5 2:8/u1 2:9/u7 2:10/u8', 'u6 is Unit 2 of chapter 1; u1 is Unit 8 of chapter 2');
select results_eq(
  $$select c.number from public.units u join public.chapters c on c.id = u.chapter_id where u.id in (t120.u('u6'), t120.u('u1')) order by u.unit_no desc$$,
  $$values (2), (1)$$,
  'chapter membership changed in the table, not only in the numbers'
);
select is(
  (select string_agg(v.id::text || v.status || v.version, ',' order by v.id) from public.unit_versions v where v.unit_id in (t120.u('u2'), t120.u('u6'))),
  (select v from snap where label = 'versions'),
  'the versions of the moved unit are untouched'
);

-- O. units with versions are never removed or edited ------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u4","u3","n10"],["n5","u5","u1","u7","u8"]]', '["u6"]'), true)$$,
  '22023', 'unit_has_versions', 'a unit with a draft version cannot be removed, even with the confirmation'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]', '["u2"]'), true)$$,
  '22023', 'unit_has_versions', 'the published unit cannot be removed'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      '[[{"label":"u2","set":{"title":"A new title"}},"u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]'), true)$$,
  '22023', 'unit_has_versions', 'the title of a unit with versions is not edited here (that is what new versions are for)'
);
reset role;
select is(t120.nums(t120.s()), '1:1/u2 1:2/u6 1:3/u4 1:4/u3 1:5/n10 2:6/n5 2:7/u5 2:8/u1 2:9/u7 2:10/u8', 'the refused layouts changed nothing');

-- P. editing the fields of units without versions -------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'edit', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      '[["u2","u6","u4",{"label":"u3","set":{"title":"Counting objects","objective":"Count to ten.","kind":"revision","stage":"connect","periods":3,"week_no":null}},"n10"],["n5","u5","u1","u7","u8"]]'))$$,
  'the fields of a unit without versions are edited'
);
reset role;
select results_eq(
  $$select u.title, u.objective, u.kind, u.stage, u.periods, u.week_no, u.unit_no from public.units u where u.id = t120.u('u3')$$,
  $$values ('Counting objects', 'Count to ten.', 'revision', 'connect', 3, null::int, 4)$$,
  'title, objective, kind, stage, periods and week were set; the number did not move'
);
select results_eq(
  $$select r ->> 'units_updated', r ->> 'units_renumbered', r ->> 'units_moved' from res where label = 'edit'$$,
  $$values ('1', '0', '0')$$,
  'one unit edited, none renumbered'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'edit_again', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      '[["u2","u6","u4",{"label":"u3","set":{"title":"Counting objects","objective":"Count to ten.","kind":"revision"}},"n10"],["n5","u5","u1","u7","u8"]]'))$$,
  'the same edit again'
);
select lives_ok(
  $$insert into res select 'same_on_versioned', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      '[[{"label":"u2","set":{"title":"Unit 2"}},"u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]'), true)$$,
  'values equal to the stored ones are not an edit, even on a unit with versions'
);
reset role;
select results_eq(
  $$select r ->> 'units_updated', r ->> 'units_renumbered', r ->> 'units_moved', r ->> 'units_created' from res where label in ('edit_again', 'same_on_versioned') order by label$$,
  $$values ('0', '0', '0', '0'), ('0', '0', '0', '0')$$,
  'both are no-ops'
);

-- Q. a new chapter ----------------------------------------------------------------------------------------------------------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), jsonb_insert(t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"]]'), '{chapters,0}',
      jsonb_build_object('new', jsonb_build_object('title', 'First'), 'units', jsonb_build_array(t120.fresh('a'), t120.fresh('b'), t120.fresh('c')))))$$,
  '22023', 'chapter_order_changed', 'a new chapter goes after the existing ones'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), jsonb_build_array(
      '["u2","u6","u4","u3","n10"]'::jsonb, '["n5","u5","u1","u7","u8"]'::jsonb,
      jsonb_build_object('new', 'Our Community', 'units', jsonb_build_array(t120.fresh('a'), t120.fresh('b'))))))$$,
  '22023', 'chapter_unit_count_invalid', 'a new chapter also needs at least 3 units'
);
select lives_ok(
  $$insert into res select 'new_chapter', public.apply_unit_layout(t120.s(), t120.lay(t120.s(), jsonb_build_array(
      '["u2","u6","u4","u3","n10"]'::jsonb, '["n5","u5","u1","u7","u8"]'::jsonb,
      jsonb_build_object('new', 'Our Community', 'units', jsonb_build_array(t120.fresh('Neighbours'), t120.fresh('Helpers', '{"lens":"Value"}'), t120.fresh('Safety'))))))$$,
  'a new chapter is added with three new units'
);
reset role;
select results_eq(
  $$select r ->> 'chapters_created', r ->> 'units_created', r ->> 'chapters', r ->> 'units', jsonb_array_length(r -> 'created_chapter_ids')::text
      from res where label = 'new_chapter'$$,
  $$values ('1', '3', '3', '13', '1')$$,
  'one chapter and three units created; 3 chapters and 13 live units'
);
insert into ids select 'q1', (r -> 'created_unit_ids' ->> 0)::uuid from res where label = 'new_chapter';
insert into ids select 'q2', (r -> 'created_unit_ids' ->> 1)::uuid from res where label = 'new_chapter';
insert into ids select 'q3', (r -> 'created_unit_ids' ->> 2)::uuid from res where label = 'new_chapter';
select results_eq(
  $$select c.number, c.title, c.status, c.theme_id is null from public.chapters c where c.id = ((select r -> 'created_chapter_ids' ->> 0 from res where label = 'new_chapter')::uuid)$$,
  $$values (3, 'Our Community', 'draft', true)$$,
  'the new chapter is number 3, a draft, without a theme'
);
select is(t120.nums(t120.s()), '1:1/u2 1:2/u6 1:3/u4 1:4/u3 1:5/n10 2:6/n5 2:7/u5 2:8/u1 2:9/u7 2:10/u8 3:11/q1 3:12/q2 3:13/q3', 'its units continue the term numbering');
select is(
  (select count(*)::int from public.theme_units tu where tu.unit_id = t120.u('q2')), 0,
  'a lens in a chapter without a theme links nothing'
);

-- R. atomic: nothing is half applied --------------------------------------------------------------------------------------------------------
insert into snap select 'before_atomic', t120.nums(t120.s());
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), jsonb_insert(
      '[[{"label":"u2","set":{"title":"Changed"}},"u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3"]]', '{2,-1}',
      t120.fresh('Atomic'), true)))$$,
  '22023', 'unit_has_versions', 'a valid new unit next to an invalid edit: the whole layout is refused'
);
reset role;
select results_eq(
  $$select (select count(*)::int from public.units where title = 'Atomic'), t120.nums(t120.s()) = (select v from snap where label = 'before_atomic')$$,
  $$values (0, true)$$,
  'the valid part was not applied either'
);
-- a failure in the LAST write (the second new unit) undoes the writes before it: the renumbering, the first new unit
create function t120.boom() returns trigger language plpgsql as $f$
begin
  if new.title = 'boom' then raise exception 'boom' using errcode = 'P0001'; end if;
  return new;
end $f$;
create trigger t120_boom before insert on public.units for each row execute function t120.boom();
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), jsonb_insert(jsonb_insert(
      '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3"]]', '{2,-1}', t120.fresh('Fine'), true),
      '{2,-1}', t120.fresh('boom'), true), '["n10"]'), true)$$,
  'P0001', 'boom', 'a late failure (the last insert) is raised'
);
reset role;
select results_eq(
  $$select (select count(*)::int from public.units where title in ('Fine', 'boom')), t120.nums(t120.s()) = (select v from snap where label = 'before_atomic'),
           (select status from public.units where id = t120.u('n10'))$$,
  $$values (0, true, 'draft')$$,
  'atomic: the archive, the renumbering and the first new unit were rolled back with it'
);
alter table public.units disable trigger t120_boom;

-- S. a stale page can never archive or overwrite a colleague's work -----------------------------------------------------------------------------
insert into snap select 'stale', t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3"]]')::text;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into res select 'colleague', public.apply_unit_layout(t120.s(), t120.lay(t120.s(),
      jsonb_insert('[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3"]]', '{2,-1}', t120.fresh('Colleague unit'), true)))$$,
  'a colleague adds a unit to chapter 3'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), (select v::jsonb from snap where label = 'stale'))$$,
  '22023', 'layout_out_of_date', 'the page loaded before that is refused: it would have archived the colleague''s unit'
);
reset role;
insert into ids select 'c1', (r -> 'created_unit_ids' ->> 0)::uuid from res where label = 'colleague';
select is((select status from public.units where id = t120.u('c1')), 'draft', 'the colleague''s unit is still live');
insert into snap select 'stale2', t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3","c1"]]')::text;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.apply_unit_layout(t120.s(), t120.lay(t120.s(), '[["u2","u6","u4","u3","n10"],["n5","u5","u1","u7","u8"],["q1","q2","q3"]]', '["c1"]'))$$,
  'the colleague removes it again'
);
select throws_ok(
  $$select public.apply_unit_layout(t120.s(), (select v::jsonb from snap where label = 'stale2'))$$,
  'P0002', 'unit_not_in_scheme', 'a page that still shows the removed unit is refused too'
);
reset role;

-- T. apply_chapter_plan keeps working: scheme "plan2" (4 + 4, no versions) is laid out by hand and then re-planned ---------------------------
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.apply_unit_layout(t120.s('plan2'), t120.lay(t120.s('plan2'),
      jsonb_insert('[["p1","p2","p4"],["p5","p6","p7","p8"]]', '{1,-1}', t120.fresh('Added by hand'), true), '["p3"]'))$$,
  'plan2: one unit removed and one added by hand'
);
reset role;
select is(t120.nums(t120.s('plan2')), '1:1/p1 1:2/p2 1:3/p4 2:4/p5 2:5/p6 2:6/p7 2:7/p8 2:8', 'plan2 now has 3 + 5 units, numbered 1 to 8');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'chapters', r ->> 'units', r ->> 'units_created', r ->> 'units_updated', r ->> 'units_removed'
      from (select public.apply_chapter_plan(t120.s('plan2'), (select doc from plan8)) as r) x$$,
  $$values ('2', '8', '1', '5', '2')$$,
  'applying the original plan again restores 4 + 4; the archived unit and the surplus one are removed (nothing had versions)'
);
reset role;
select is(t120.nums(t120.s('plan2')), '1:1 1:2 1:3 1:4 2:5 2:6 2:7 2:8', 'plan2 is back to 4 + 4 numbered 1 to 8');
select is(
  (select count(*)::int from public.units u join public.chapters c on c.id = u.chapter_id where c.scheme_id = t120.s('plan2')), 8,
  'no archived leftover: the plan removed the archived row (it had no version)'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan(t120.s(), (select doc from plan8))$$,
  '22023', 'unit_has_versions', 'on "main" the old plan conflicts with units that have versions and were moved: refused, nothing is lost'
);
reset role;

-- U. publish_unit_version still enforces 3 to 5 live units ------------------------------------------------------------------------------------
insert into public.units (id, chapter_id, unit_no, kind, title, objective, stage) values
  ('f8000000-0000-4000-8000-0000000000c4', 'f8000000-0000-4000-8000-0000000000b1', 4, 'lesson', 'P4', 'o', 'absorb'),
  ('f8000000-0000-4000-8000-0000000000c5', 'f8000000-0000-4000-8000-0000000000b1', 5, 'lesson', 'P5', 'o', 'absorb'),
  ('f8000000-0000-4000-8000-0000000000c6', 'f8000000-0000-4000-8000-0000000000b1', 6, 'lesson', 'P6', 'o', 'absorb');
insert into public.unit_versions (id, unit_id, version, schema_version, content, status, generated_by)
  values ('f8000000-0000-4000-8000-0000000000d1', 'f8000000-0000-4000-8000-0000000000c1', 1, 1, '{"schema_version":1,"header":{}}', 'approved', 'human');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f8000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.publish_unit_version('f8000000-0000-4000-8000-0000000000d1')$$,
  '22023', 'chapter_unit_count_invalid', 'a chapter with 6 live units cannot publish'
);
select lives_ok(
  $$select public.apply_unit_layout(t120.s('probe'), (t120.cur(t120.s('probe')) #- '{chapters,0,units,5}')
      || jsonb_build_object('removed', jsonb_build_array('f8000000-0000-4000-8000-0000000000c6')))$$,
  'the layout brings the chapter to 5 (the sixth is archived)'
);
select lives_ok(
  $$select public.publish_unit_version('f8000000-0000-4000-8000-0000000000d1')$$,
  'and then the version publishes'
);
reset role;
select results_eq(
  $$select status from public.units where id in ('f8000000-0000-4000-8000-0000000000c1', 'f8000000-0000-4000-8000-0000000000c6') order by unit_no$$,
  $$values ('published'), ('archived')$$,
  'c1 is published, c6 is archived'
);

-- V. function hygiene ---------------------------------------------------------------------------------------------------------------------------
select results_eq(
  $$select p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'apply_unit_layout'$$,
  $$values (false, true)$$,
  'public.apply_unit_layout is a SECURITY INVOKER wrapper with a pinned search_path'
);
select results_eq(
  $$select p.proname::text, p.prosecdef, coalesce(array_to_string(p.proconfig, ','), '') like '%search_path=%'
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'private' and p.proname in ('apply_unit_layout', 'layout_unit_fields', 'unit_layout_result', 'json_uuid')
     order by p.proname$$,
  $$values ('apply_unit_layout', true, true), ('json_uuid', false, true), ('layout_unit_fields', true, true), ('unit_layout_result', true, true)$$,
  'the implementations pin search_path (the definer ones are the definer ones)'
);
select results_eq(
  $$select has_function_privilege('anon', 'public.apply_unit_layout(uuid, jsonb, boolean)', 'EXECUTE'),
           has_function_privilege('service_role', 'public.apply_unit_layout(uuid, jsonb, boolean)', 'EXECUTE'),
           has_function_privilege('authenticated', 'public.apply_unit_layout(uuid, jsonb, boolean)', 'EXECUTE'),
           has_function_privilege('anon', 'private.apply_unit_layout(uuid, jsonb, boolean)', 'EXECUTE'),
           has_function_privilege('authenticated', 'private.apply_unit_layout(uuid, jsonb, boolean)', 'EXECUTE')$$,
  $$values (false, false, true, false, true)$$,
  'only authenticated may execute the RPC (anon and service_role may not)'
);
select results_eq(
  $$select has_function_privilege('authenticated', 'private.json_uuid(jsonb)', 'EXECUTE'),
           has_function_privilege('authenticated', 'private.layout_unit_fields(jsonb, uuid, boolean)', 'EXECUTE'),
           has_function_privilege('authenticated', 'private.unit_layout_result(uuid, int, int, int, int, int, int, uuid[], uuid[])', 'EXECUTE')$$,
  $$values (false, false, false)$$,
  'the helpers are not callable by any API role'
);

-- W. nothing the layout did touched what is frozen ---------------------------------------------------------------------------------------------------
select is(
  (select string_agg(v.id::text || v.status || v.version, ',' order by v.id) from public.unit_versions v where v.unit_id in (t120.u('u2'), t120.u('u6'))),
  (select v from snap where label = 'versions'),
  'after everything: the versions of u2 and u6 are as they were'
);
select is(
  (select content::text from public.published_units where unit_id = t120.u('u2')), (select v from snap where label = 'published_content'),
  'after everything: the published snapshot is byte for byte the same'
);

select * from finish();
rollback;
