-- 081 M2 content engine, content RPCs: save_scheme_draft, approve_scheme, apply_chapter_plan,
-- create_unit_version_draft, set_unit_version_status.
--   * every RPC needs an admin role at aal2 (anon, plain users, support, analyst and aal1 sessions are refused)
--   * scheme: draft -> approved state machine; an approved scheme is never rewritten
--   * plan: 3 to 5 units per chapter, draft rows only, idempotent, never touches a unit that has a version
--   * versions: numbered under a row lock, stale_base, AI drafts are always drafts, the guard trigger stays in force
--   * status moves: draft -> in_review (any staff), in_review -> approved | draft (reviewer, super_admin), nothing else
begin;
create extension if not exists pgtap with schema extensions;
select plan(159);

-- sa f3..01 super_admin | ed ..02 content_editor | rv ..03 reviewer | sup ..04 support | ana ..05 analyst | pl ..06 plain
insert into auth.users (id, email) values
  ('f3000000-0000-4000-8000-000000000001', 'c3sa@test.local'),
  ('f3000000-0000-4000-8000-000000000002', 'c3ed@test.local'),
  ('f3000000-0000-4000-8000-000000000003', 'c3rv@test.local'),
  ('f3000000-0000-4000-8000-000000000004', 'c3sup@test.local'),
  ('f3000000-0000-4000-8000-000000000005', 'c3ana@test.local'),
  ('f3000000-0000-4000-8000-000000000006', 'c3pl@test.local');
insert into public.admin_users (user_id, role) values
  ('f3000000-0000-4000-8000-000000000001', 'super_admin'),
  ('f3000000-0000-4000-8000-000000000002', 'content_editor'),
  ('f3000000-0000-4000-8000-000000000003', 'reviewer'),
  ('f3000000-0000-4000-8000-000000000004', 'support'),
  ('f3000000-0000-4000-8000-000000000005', 'analyst');

create temp table fx as
select (select id from public.subjects where slug = 'mathematics') as subject_id,
       (select jsonb_agg(jsonb_build_object('week_no', g, 'kind', 'teaching', 'topic', 'Topic ' || g,
                                            'subtopics', jsonb_build_array('Sub ' || g || 'a', 'Sub ' || g || 'b')) order by g)
          from generate_series(1, 8) g) as weeks8;
grant all on fx to public;
create temp table sch (label text primary key, id uuid not null);
grant all on sch to public;
create temp table plans (label text primary key, plan jsonb not null);
grant all on plans to public;
create temp table vers (label text primary key, id uuid not null);
grant all on vers to public;

-- A. save_scheme_draft -----------------------------------------------------------------------------------------------------
set local role anon;
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', null, 'anon cannot call save_scheme_draft'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', 'admin_role_required', 'an ordinary user cannot save a scheme'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', 'admin_role_required', 'a reviewer cannot save a scheme'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', 'admin_role_required', 'support cannot save a scheme'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', 'admin_role_required', 'an analyst cannot save a scheme'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), null)$$,
  '42501', 'admin_role_required', 'a content_editor at aal1 cannot save a scheme'
);

set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 0, (select weeks8 from fx), null)$$,
  '22023', 'invalid_term', 'term 0 is refused'
);
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', null, (select weeks8 from fx), null)$$,
  '22023', 'invalid_term', 'a null term is refused'
);
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P9', 1, (select weeks8 from fx), null)$$,
  '22023', 'invalid_level', 'an unknown level is refused'
);
select throws_ok(
  $$select public.save_scheme_draft('00000000-0000-4000-8000-0000000000ff', 'P2', 1, (select weeks8 from fx), null)$$,
  'P0002', 'subject_not_found', 'an unknown subject is a clean error'
);
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), repeat('x', 2001))$$,
  '22023', 'invalid_source_note', 'a source note over 2000 characters is refused'
);
select throws_ok(
  format($q$select public.save_scheme_draft(%L, 'P2', 1, %L::jsonb, null)$q$, (select subject_id from fx), c.w),
  '22023', 'invalid_scheme_weeks', 'weeks rejected: ' || c.label
)
from (values
  ('null', null),
  ('not an array', '{"week_no":1}'),
  ('empty', '[]'),
  ('duplicate week_no', '[{"week_no":1,"kind":"teaching","topic":"a","subtopics":[]},{"week_no":1,"kind":"teaching","topic":"b","subtopics":[]}]'),
  ('week_no 0', '[{"week_no":0,"kind":"teaching","topic":"a","subtopics":[]}]'),
  ('week_no 21', '[{"week_no":21,"kind":"teaching","topic":"a","subtopics":[]}]'),
  ('week_no 1.5', '[{"week_no":1.5,"kind":"teaching","topic":"a","subtopics":[]}]'),
  ('week_no as text', '[{"week_no":"1","kind":"teaching","topic":"a","subtopics":[]}]'),
  ('unknown kind', '[{"week_no":1,"kind":"party","topic":"a","subtopics":[]}]'),
  ('blank topic', '[{"week_no":1,"kind":"teaching","topic":"   ","subtopics":[]}]'),
  ('missing topic', '[{"week_no":1,"kind":"teaching","subtopics":[]}]'),
  ('subtopics not an array', '[{"week_no":1,"kind":"teaching","topic":"a","subtopics":"x"}]'),
  ('blank subtopic', '[{"week_no":1,"kind":"teaching","topic":"a","subtopics":["ok"," "]}]'),
  ('element not an object', '[5]')
) as c(label, w);
reset role;
select is(
  (select count(*)::int from public.schemes s
    where s.subject_id = (select subject_id from fx) and s.level_code = 'P2' and s.term = 1),
  0,
  'none of the refused saves created a scheme'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into sch select 'main', public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), 'NERDC P2 Maths T1')$$,
  'a content_editor at aal2 saves a scheme draft'
);
reset role;
select results_eq(
  $$select status, source_note, (select count(*)::int from public.scheme_weeks w where w.scheme_id = s.id)
      from public.schemes s where s.id = (select id from sch where label = 'main')$$,
  $$values ('draft', 'NERDC P2 Maths T1', 8)$$,
  'the scheme is a draft with its note and 8 weeks'
);
select results_eq(
  $$select week_no, kind, topic, subtopics from public.scheme_weeks
     where scheme_id = (select id from sch where label = 'main') and week_no in (1, 8) order by week_no$$,
  $$values (1, 'teaching', 'Topic 1', array['Sub 1a', 'Sub 1b']), (8, 'teaching', 'Topic 8', array['Sub 8a', 'Sub 8b'])$$,
  'weeks keep their kind, topic and the order of their subtopics'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select is(
  public.save_scheme_draft((select subject_id from fx), 'P2', 1,
    '[{"week_no":1,"kind":"teaching","topic":"Only topic","subtopics":["x"]},{"week_no":2,"kind":"exam","topic":"Test"}]'::jsonb, null),
  (select id from sch where label = 'main'),
  'saving again replaces the same draft (same id), as a super_admin'
);
reset role;
select results_eq(
  $$select s.source_note, (select count(*)::int from public.scheme_weeks w where w.scheme_id = s.id),
           (select topic from public.scheme_weeks w where w.scheme_id = s.id and w.week_no = 1),
           (select subtopics from public.scheme_weeks w where w.scheme_id = s.id and w.week_no = 2)
      from public.schemes s where s.id = (select id from sch where label = 'main')$$,
  $$values (null, 2, 'Only topic', '{}'::text[])$$,
  'the old weeks are gone, the note was cleared and a missing subtopics list is empty'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select is(
  public.save_scheme_draft((select subject_id from fx), 'P2', 1, (select weeks8 from fx), 'back to eight weeks'),
  (select id from sch where label = 'main'),
  'and again with the full 8 weeks'
);

-- B. approve_scheme ---------------------------------------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  '42501', null, 'anon cannot call approve_scheme'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  '42501', 'admin_role_required', 'a content_editor cannot approve a scheme (reviewer or super_admin only)'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  '42501', 'admin_role_required', 'an ordinary user cannot approve'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  '42501', 'admin_role_required', 'support cannot approve'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  '42501', 'admin_role_required', 'a reviewer at aal1 cannot approve'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme('00000000-0000-4000-8000-0000000000ff')$$,
  'P0002', 'scheme_not_found', 'approving an unknown scheme is a clean error'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into sch select 'exam', public.save_scheme_draft((select subject_id from fx), 'P3', 1,
      '[{"week_no":1,"kind":"exam","topic":"Exam week","subtopics":[]}]'::jsonb, null)$$,
  'a scheme with no teaching week can be saved as a draft'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'exam'))$$,
  '22023', 'scheme_has_no_teaching_weeks', 'but it cannot be approved'
);
select lives_ok($$select public.approve_scheme((select id from sch where label = 'main'))$$, 'a reviewer approves a draft scheme');
select lives_ok(
  $$select public.approve_scheme((select id from sch where label = 'main'))$$,
  'approving an approved scheme is a no-op'
);
reset role;
select results_eq(
  $$select s.status, (select count(*)::int from public.audit_log a where a.entity = 'schemes' and a.action = 'scheme_approved'
                         and a.entity_id = s.id::text and a.actor = 'f3000000-0000-4000-8000-000000000003')
      from public.schemes s where s.id = (select id from sch where label = 'main')$$,
  $$values ('approved', 1)$$,
  'the scheme is approved and the approval was audited once, with the reviewer as actor'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P2', 1, '[{"week_no":1,"kind":"teaching","topic":"changed","subtopics":[]}]'::jsonb, null)$$,
  '22023', 'scheme_not_draft', 'an approved scheme is never rewritten'
);
reset role;
select is(
  (select count(*)::int from public.scheme_weeks where scheme_id = (select id from sch where label = 'main')),
  8,
  'and its weeks are untouched'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into sch select 'arch', public.save_scheme_draft((select subject_id from fx), 'P5', 1, (select weeks8 from fx), null)$$,
  'a third scheme (to be archived)'
);
reset role;
update public.schemes set status = 'archived' where id = (select id from sch where label = 'arch');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.approve_scheme((select id from sch where label = 'arch'))$$,
  '22023', 'scheme_not_draft', 'an archived scheme cannot be approved'
);
select throws_ok(
  $$select public.save_scheme_draft((select subject_id from fx), 'P5', 1, (select weeks8 from fx), null)$$,
  '22023', 'scheme_not_draft', 'nor rewritten'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into sch select 'draft', public.save_scheme_draft((select subject_id from fx), 'P6', 1, (select weeks8 from fx), null)$$,
  'a fourth scheme stays a draft'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok($$select public.approve_scheme((select id from sch where label = 'draft'))$$, 'a super_admin can approve too');
reset role;
update public.schemes set status = 'draft' where id = (select id from sch where label = 'draft');

-- C. apply_chapter_plan -----------------------------------------------------------------------------------------------------
insert into plans values ('ok', jsonb_build_object('chapters', jsonb_build_array(
  jsonb_build_object('chapter_no', 1, 'title', 'Our World', 'theme', jsonb_build_object('title', 'Market Day', 'lens', 'Counting'),
    'units', (select jsonb_agg(jsonb_build_object('unit_no', g, 'week_no', g, 'kind', 'lesson', 'title', 'Unit ' || g,
                'objective', 'Objective ' || g, 'stage', 'absorb', 'stage_to', 'connect', 'periods', 2) order by g)
                from generate_series(1, 4) g)),
  jsonb_build_object('chapter_no', 2, 'title', 'Our Homes',
    'units', (select jsonb_agg(jsonb_build_object('unit_no', g, 'week_no', g, 'kind', 'lesson', 'title', 'Unit ' || g,
                'objective', 'Objective ' || g, 'stage', 'connect', 'periods', 1) order by g)
                from generate_series(5, 8) g))
)));

set local role anon;
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok'))$$,
  '42501', null, 'anon cannot call apply_chapter_plan'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok'))$$,
  '42501', 'admin_role_required', 'a reviewer cannot apply a plan'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok'))$$,
  '42501', 'admin_role_required', 'an ordinary user cannot apply a plan'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok'))$$,
  '42501', 'admin_role_required', 'an editor at aal1 cannot apply a plan'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan('00000000-0000-4000-8000-0000000000ff', (select plan from plans where label = 'ok'))$$,
  'P0002', 'scheme_not_found', 'an unknown scheme is a clean error'
);
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'draft'), (select plan from plans where label = 'ok'))$$,
  '22023', 'scheme_not_approved', 'a plan needs an approved scheme'
);
select throws_ok(
  format($q$select public.apply_chapter_plan(%L, %L::jsonb)$q$, (select id from sch where label = 'main'), c.p),
  '22023', c.msg, 'plan rejected: ' || c.label
)
from (select plan as p from plans where label = 'ok') o,
lateral (values
  ('null plan', null::jsonb, 'invalid_chapter_plan'),
  ('empty object', '{}'::jsonb, 'invalid_chapter_plan'),
  ('chapters not an array', '{"chapters":1}'::jsonb, 'invalid_chapter_plan'),
  ('no chapters', '{"chapters":[]}'::jsonb, 'invalid_chapter_plan'),
  ('2 units in a chapter', jsonb_set(o.p, '{chapters,0,units}', (o.p #> '{chapters,0,units}') - 3 - 2), 'chapter_unit_count_invalid'),
  ('6 units in a chapter', jsonb_set(o.p, '{chapters,0,units}', (o.p #> '{chapters,0,units}') ||
      '[{"unit_no":9,"week_no":1,"kind":"lesson","title":"x","objective":"y","stage":"absorb","periods":1},
        {"unit_no":10,"week_no":1,"kind":"lesson","title":"x","objective":"y","stage":"absorb","periods":1}]'::jsonb), 'chapter_unit_count_invalid'),
  ('duplicate chapter_no', jsonb_set(o.p, '{chapters,1,chapter_no}', '1'), 'duplicate_chapter_no'),
  ('duplicate unit_no', jsonb_set(o.p, '{chapters,1,units,0,unit_no}', '1'), 'duplicate_unit_no'),
  ('a week the scheme does not have', jsonb_set(o.p, '{chapters,0,units,0,week_no}', '12'), 'unknown_scheme_week'),
  ('week 16', jsonb_set(o.p, '{chapters,0,units,0,week_no}', '16'), 'invalid_chapter_plan'),
  ('unknown kind', jsonb_set(o.p, '{chapters,0,units,0,kind}', '"party"'), 'invalid_chapter_plan'),
  ('unknown stage', jsonb_set(o.p, '{chapters,0,units,0,stage}', '"nope"'), 'invalid_chapter_plan'),
  ('stage_to before stage', jsonb_set(jsonb_set(o.p, '{chapters,0,units,0,stage}', '"connect"'), '{chapters,0,units,0,stage_to}', '"absorb"'), 'invalid_chapter_plan'),
  ('periods 11', jsonb_set(o.p, '{chapters,0,units,0,periods}', '11'), 'invalid_chapter_plan'),
  ('blank unit title', jsonb_set(o.p, '{chapters,0,units,0,title}', '"  "'), 'invalid_chapter_plan'),
  ('missing objective', o.p #- '{chapters,0,units,0,objective}', 'invalid_chapter_plan'),
  ('blank chapter title', jsonb_set(o.p, '{chapters,0,title}', '""'), 'invalid_chapter_plan'),
  ('chapter_no 0', jsonb_set(o.p, '{chapters,0,chapter_no}', '0'), 'invalid_chapter_plan'),
  ('theme without a lens', o.p #- '{chapters,0,theme,lens}', 'invalid_chapter_plan'),
  ('unit not an object', jsonb_set(o.p, '{chapters,0,units,0}', '5'), 'invalid_chapter_plan')
) as c(label, p, msg);
reset role;
select is(
  (select count(*)::int from public.chapters where scheme_id = (select id from sch where label = 'main')),
  0,
  'none of the refused plans created a chapter'
);

set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'chapters', r ->> 'units', r ->> 'chapters_created', r ->> 'units_created', r ->> 'units_updated',
           r ->> 'units_removed', r ->> 'chapters_removed'
      from (select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok')) as r) x$$,
  $$values ('2', '8', '2', '8', '0', '0', '0')$$,
  'a content_editor applies a plan: 2 chapters and 8 units created'
);
reset role;
select results_eq(
  $$select c.number, c.title, c.status, c.theme_id is not null, (select count(*)::int from public.units u where u.chapter_id = c.id)
      from public.chapters c where c.scheme_id = (select id from sch where label = 'main') order by c.number$$,
  $$values (1, 'Our World', 'draft', true, 4), (2, 'Our Homes', 'draft', false, 4)$$,
  'chapters are created as drafts with their units; only chapter 1 has a theme'
);
select results_eq(
  $$select u.unit_no, u.week_no, u.kind, u.title, u.objective, u.stage, u.periods, u.status
      from public.units u join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = (select id from sch where label = 'main') and u.unit_no in (1, 8) order by u.unit_no$$,
  $$values (1, 1, 'lesson', 'Unit 1', 'Objective 1', 'absorb', 2, 'draft'), (8, 8, 'lesson', 'Unit 8', 'Objective 8', 'connect', 1, 'draft')$$,
  'units carry their week, kind, title, objective, stage and periods, and start as drafts'
);
select results_eq(
  $$select (select count(*)::int from public.themes where term = 1 and title = 'Market Day'),
           (select count(*)::int from public.theme_units tu join public.themes t on t.id = tu.theme_id
              where t.title = 'Market Day' and tu.lens = 'Counting'),
           (select count(*)::int from public.chapters c where c.scheme_id = (select id from sch where label = 'main') and c.status <> 'draft'),
           (select count(*)::int from public.units u join public.chapters c on c.id = u.chapter_id
              where c.scheme_id = (select id from sch where label = 'main') and u.status <> 'draft')$$,
  $$values (1, 4, 0, 0)$$,
  'the theme exists once and links the 4 units of chapter 1 with its lens; nothing is published'
);
select is(
  (select count(*)::int from public.audit_log where action = 'chapter_plan_applied' and entity_id = (select id::text from sch where label = 'main')),
  1,
  'the apply was audited'
);

-- idempotent: an unchanged plan touches nothing
create temp table seqs as
select (select max(sync_seq) from public.units) as units_seq, (select max(sync_seq) from public.chapters) as chapters_seq,
       (select count(*)::int from public.themes) as themes, (select count(*)::int from public.theme_units) as theme_units;
grant all on seqs to public;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'chapters_created', r ->> 'units_created', r ->> 'units_updated', r ->> 'units_removed', r ->> 'chapters_removed'
      from (select public.apply_chapter_plan((select id from sch where label = 'main'), (select plan from plans where label = 'ok')) as r) x$$,
  $$values ('0', '0', '0', '0', '0')$$,
  'applying the same plan again (as a super_admin) creates, updates and removes nothing'
);
reset role;
select results_eq(
  $$select (select max(sync_seq) from public.units) = units_seq, (select max(sync_seq) from public.chapters) = chapters_seq,
           (select count(*)::int from public.themes) = themes, (select count(*)::int from public.theme_units) = theme_units
      from seqs$$,
  $$values (true, true, true, true)$$,
  'and no row was written: no new sync_seq, no duplicate theme or theme link'
);

-- changes to units without a version are applied
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'units_updated', r ->> 'units_created'
      from (select public.apply_chapter_plan((select id from sch where label = 'main'),
              jsonb_set(jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units,1,title}', '"Unit 2 renamed"'),
                        '{chapters,1,units,0,objective}', '"New objective 5"')) as r) x$$,
  $$values ('2', '0')$$,
  're-applying with a new title and a new objective updates those two units in place'
);
reset role;
select results_eq(
  $$select u.title, u.objective from public.units u join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = (select id from sch where label = 'main') and u.unit_no in (2, 5) order by u.unit_no$$,
  $$values ('Unit 2 renamed', 'Objective 2'), ('Unit 5', 'New objective 5')$$,
  'the rows carry the new values'
);

-- a unit with a version is never touched
insert into public.unit_versions (id, unit_id, version, schema_version, content, generated_by)
select 'f3a00000-0000-4000-8000-000000000004', u.id, 1, 1, '{"header":{}}', 'ai'
  from public.units u join public.chapters c on c.id = u.chapter_id
 where c.scheme_id = (select id from sch where label = 'main') and u.unit_no = 4;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'),
      jsonb_set(jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units,1,title}', '"Unit 2 renamed twice"'),
                '{chapters,0,units,3,title}', '"Unit 4 renamed"'))$$,
  '22023', 'unit_has_versions', 'changing a unit that has a version is refused'
);
reset role;
select results_eq(
  $$select u.title from public.units u join public.chapters c on c.id = u.chapter_id
     where c.scheme_id = (select id from sch where label = 'main') and u.unit_no in (2, 4) order by u.unit_no$$,
  $$values ('Unit 2 renamed'), ('Unit 4')$$,
  'the refusal is atomic: the versioned unit is unchanged'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'),
      jsonb_set(jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units,1,title}', '"Unit 2 renamed"'),
                '{chapters,0,units,0,title}', '"Unit 1 renamed again"') #- '{chapters,0,units,3}')$$,
  '22023', 'unit_has_versions', 'dropping a unit that has a version from the plan is refused too'
);
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'),
      jsonb_build_object('chapters', jsonb_build_array((select plan #> '{chapters,1}' from plans where label = 'ok'))))$$,
  '22023', 'unit_has_versions', 'so is dropping the whole chapter that holds it'
);
select lives_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'),
      jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units,1,title}', '"Unit 2 renamed"'))$$,
  'an unchanged versioned unit is fine (the apply stays idempotent)'
);

-- units and chapters without a version can leave the plan
select results_eq(
  $$select r ->> 'units_removed', r ->> 'chapters_removed', r ->> 'units'
      from (select public.apply_chapter_plan((select id from sch where label = 'main'),
              jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units}',
                        ((select plan from plans where label = 'ok') #> '{chapters,0,units}') - 2)) as r) x$$,
  $$values ('1', '0', '7')$$,
  'a unit without a version that the plan no longer contains is removed'
);
reset role;
select is(
  (select count(*)::int from public.units u join public.chapters c on c.id = u.chapter_id
    where c.scheme_id = (select id from sch where label = 'main')),
  7,
  'seven units remain'
);
update public.chapters set status = 'published'
 where scheme_id = (select id from sch where label = 'main') and number = 2;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.apply_chapter_plan((select id from sch where label = 'main'),
      jsonb_set(jsonb_set((select plan from plans where label = 'ok'), '{chapters,0,units}',
                ((select plan from plans where label = 'ok') #> '{chapters,0,units}') - 2),
                '{chapters,1,title}', '"Renamed after publishing"'))$$,
  '22023', 'chapter_not_draft', 'the title of a chapter that is no longer a draft is not rewritten'
);
reset role;
update public.chapters set status = 'draft'
 where scheme_id = (select id from sch where label = 'main') and number = 2;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select results_eq(
  $$select r ->> 'chapters_removed', r ->> 'units_removed', r ->> 'chapters'
      from (select public.apply_chapter_plan((select id from sch where label = 'main'),
              jsonb_build_object('chapters', jsonb_build_array(
                jsonb_set((select plan #> '{chapters,0}' from plans where label = 'ok'), '{units}',
                          ((select plan #> '{chapters,0,units}' from plans where label = 'ok') - 2) ) #- '{theme}'))) as r) x$$,
  $$values ('1', '4', '1')$$,
  'a chapter without any version that the plan no longer contains is removed with its units'
);
reset role;
select results_eq(
  $$select c.number, c.theme_id is null,
           (select count(*)::int from public.theme_units tu join public.units u on u.id = tu.unit_id where u.chapter_id = c.id),
           (select count(*)::int from public.themes where title = 'Market Day')
      from public.chapters c where c.scheme_id = (select id from sch where label = 'main')$$,
  $$values (1, true, 0, 1)$$,
  'a plan without a theme unlinks it (the theme row itself stays)'
);

-- D. create_unit_version_draft ------------------------------------------------------------------------------------------------
insert into public.schemes (id, subject_id, level_code, term, status)
select '5c300000-0000-4000-8000-000000000001', subject_id, 'P1', 3, 'approved' from fx;
insert into public.chapters (id, scheme_id, number, title) values
  ('c4300000-0000-4000-8000-000000000001', '5c300000-0000-4000-8000-000000000001', 1, 'Chapter 1');
insert into public.units (id, chapter_id, unit_no, week_no, kind, title, objective, stage, status, deleted_at) values
  ('ab300000-0000-4000-8000-000000000001', 'c4300000-0000-4000-8000-000000000001', 1, 1, 'lesson', 'Unit 1', 'O1', 'absorb', 'draft', null),
  ('ab300000-0000-4000-8000-000000000002', 'c4300000-0000-4000-8000-000000000001', 2, 2, 'lesson', 'Unit 2', 'O2', 'absorb', 'draft', null),
  ('ab300000-0000-4000-8000-000000000003', 'c4300000-0000-4000-8000-000000000001', 3, 3, 'lesson', 'Unit 3', 'O3', 'absorb', 'archived', null);

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname in ('create_unit_version_draft', 'set_unit_version_status') and p.prosecdef),
  0,
  'the two unit_versions writers are SECURITY INVOKER: RLS and the guard trigger stay in force'
);

set local role anon;
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', null, 'anon cannot call create_unit_version_draft'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', 'admin_role_required', 'a reviewer cannot create versions'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', 'admin_role_required', 'an ordinary user cannot create versions'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', 'admin_role_required', 'support cannot create versions'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', 'admin_role_required', 'an analyst cannot create versions'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '42501', 'admin_role_required', 'a super_admin at aal1 cannot create versions'
);

set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'robot', null, null, null)$$,
  '22023', 'invalid_generated_by', 'generated_by must be ai or human'
);
select throws_ok(
  format($q$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', %L::jsonb, null, 'human', null, null, null)$q$, c.w),
  '22023', 'invalid_unit_content', 'content rejected: ' || c.label
)
from (values
  ('null', null),
  ('an array', '[]'),
  ('no header', '{"schema_version":1}'),
  ('header not an object', '{"schema_version":1,"header":[]}'),
  ('no schema_version', '{"header":{}}'),
  ('schema_version 0', '{"schema_version":0,"header":{}}'),
  ('schema_version as text', '{"schema_version":"1","header":{}}'),
  ('schema_version 1.5', '{"schema_version":1.5,"header":{}}')
) as c(label, w);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, '[]'::jsonb, 'human', null, null, null)$$,
  '22023', 'invalid_lint_report', 'the lint report must be an object'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'ai', null, 'm2-v1', null)$$,
  '22023', 'invalid_ai_provenance', 'an AI draft must name its model'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'ai', 'claude-opus-5-5', '  ', null)$$,
  '22023', 'invalid_ai_provenance', 'and its prompt version'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab3000ff-0000-4000-8000-0000000000ff', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  'P0002', 'unit_not_found', 'an unknown unit is a clean error'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000003', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '22023', 'unit_not_editable', 'an archived unit takes no new version'
);

select lives_ok(
  $$insert into vers select 'v1', (r ->> 'id')::uuid
      from (select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{"title":"U1"},"kind":"lesson"}'::jsonb,
              '{"errors":[],"warnings":[],"ok":true,"review":[]}'::jsonb, 'ai', 'claude-opus-5-5', 'm2-v1', null) as r) x$$,
  'the first AI draft is saved with a null base'
);
reset role;
select results_eq(
  $$select version, schema_version, status, generated_by, model, prompt_version, lint_report ->> 'ok', base_version_id is null,
           created_by::text, content #>> '{header,title}'
      from public.unit_versions where id = (select id from vers where label = 'v1')$$,
  $$values (1, 1, 'draft', 'ai', 'claude-opus-5-5', 'm2-v1', 'true', true, 'f3000000-0000-4000-8000-000000000002', 'U1')$$,
  'version 1 is a draft with its provenance, lint report and creator'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, null)$$,
  '22023', 'stale_base', 'no base while versions exist is stale'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null, gen_random_uuid())$$,
  '22023', 'stale_base', 'an unknown base is stale'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000002', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null,
      (select id from vers where label = 'v1'))$$,
  '22023', 'stale_base', 'a base from another unit is stale (and a first version takes no base)'
);
select lives_ok(
  $$insert into vers select 'v2', (public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{"title":"U1 v2"}}'::jsonb,
      null, 'ai', 'claude-opus-5-5', 'm2-v1', (select id from vers where label = 'v1')) ->> 'id')::uuid$$,
  'the next draft names the latest version as its base'
);
select throws_ok(
  $$select public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{}}'::jsonb, null, 'human', null, null,
      (select id from vers where label = 'v1'))$$,
  '22023', 'stale_base', 'an older base is stale once a newer version exists'
);
select lives_ok(
  $$insert into vers select 'v3', (public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{"title":"by hand"}}'::jsonb,
      null, 'human', null, null, (select id from vers where label = 'v2')) ->> 'id')::uuid$$,
  'a human edit needs no model or prompt version'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$insert into vers select 'v4', (public.create_unit_version_draft('ab300000-0000-4000-8000-000000000001', '{"schema_version":1,"header":{"title":"sa"}}'::jsonb,
      null, 'ai', 'claude-sonnet-5-5', 'm2-v1', (select id from vers where label = 'v3')) ->> 'id')::uuid$$,
  'a super_admin can save a version too'
);
reset role;
select results_eq(
  $$select version, status, generated_by, model, base_version_id = (select id from vers where label = 'v' || (version - 1)) as based_on_previous,
           created_by::text
      from public.unit_versions where unit_id = 'ab300000-0000-4000-8000-000000000001' and version > 1 order by version$$,
  $$values (2, 'draft', 'ai', 'claude-opus-5-5', true, 'f3000000-0000-4000-8000-000000000002'),
           (3, 'draft', 'human', null, true, 'f3000000-0000-4000-8000-000000000002'),
           (4, 'draft', 'ai', 'claude-sonnet-5-5', true, 'f3000000-0000-4000-8000-000000000001')$$,
  'versions are numbered 2, 3, 4 in order, every one a draft based on its predecessor'
);
select is(
  (select count(*)::int from public.unit_versions where generated_by = 'ai' and status <> 'draft'
      and unit_id = 'ab300000-0000-4000-8000-000000000001'),
  0,
  'an AI draft never starts in any other state'
);
select ok(
  (select count(*) from public.audit_log where entity = 'unit_versions' and action = 'insert'
      and entity_id in (select id::text from vers)) = 4,
  'each saved version was audited'
);
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$insert into public.unit_versions (unit_id, version, schema_version, content, status, generated_by, created_by)
    values ('ab300000-0000-4000-8000-000000000002', 1, 1, '{"a":1}', 'approved', 'ai', 'f3000000-0000-4000-8000-000000000002')$$,
  '42501', 'unit_version_must_start_as_draft', 'the guard trigger still refuses a version that starts as anything but a draft'
);

-- E. set_unit_version_status -----------------------------------------------------------------------------------------------------
reset role;
set local role anon;
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '42501', null, 'anon cannot call set_unit_version_status'
);
reset role;
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000006","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '42501', 'admin_role_required', 'an ordinary user cannot move a version'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000004","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '42501', 'admin_role_required', 'support cannot move a version'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000005","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '42501', 'admin_role_required', 'an analyst cannot move a version'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal1"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '42501', 'admin_role_required', 'a reviewer at aal1 cannot move a version'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000002","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'bogus')$$,
  '22023', 'invalid_status', 'an unknown status is refused'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), null)$$,
  '22023', 'invalid_status', 'a null status is refused'
);
select throws_ok(
  $$select public.set_unit_version_status('f3a000ff-0000-4000-8000-0000000000ff', 'in_review')$$,
  'P0002', 'unit_version_not_found', 'an unknown version is a clean error'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'approved')$$,
  '22023', 'illegal_status_move', 'a draft cannot jump to approved'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'draft')$$,
  '22023', 'illegal_status_move', 'a draft cannot "move" to draft'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'published')$$,
  '22023', 'illegal_status_move', 'a draft cannot be marked published'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'superseded')$$,
  '22023', 'illegal_status_move', 'a draft cannot be marked superseded'
);
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  'a content_editor submits a draft for review'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '22023', 'illegal_status_move', 'submitting twice is an illegal move, not a silent no-op'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'approved')$$,
  '42501', 'reviewer_required', 'a content_editor cannot approve'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'draft')$$,
  '42501', 'reviewer_required', 'a content_editor cannot send a version back either'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'published')$$,
  '22023', 'illegal_status_move', 'in_review cannot be marked published'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'draft')$$,
  'a reviewer sends a version in review back to draft'
);
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  'a reviewer may submit for review too'
);
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'approved')$$,
  'a reviewer approves a version in review'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'draft')$$,
  '22023', 'illegal_status_move', 'an approved version cannot be sent back'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'in_review')$$,
  '22023', 'illegal_status_move', 'nor re-opened for review'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'approved')$$,
  '22023', 'illegal_status_move', 'nor approved twice'
);
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000001","role":"authenticated","aal":"aal2"}';
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v2'), 'in_review')$$,
  'a super_admin submits a draft'
);
select lives_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v2'), 'approved')$$,
  'and approves it'
);
reset role;
select results_eq(
  $$select version, status from public.unit_versions where unit_id = 'ab300000-0000-4000-8000-000000000001' order by version$$,
  $$values (1, 'approved'), (2, 'approved'), (3, 'draft'), (4, 'draft')$$,
  'the versions carry the statuses they were moved to'
);
select ok(
  (select count(*) from public.audit_log where entity = 'unit_versions' and action = 'update'
      and detail -> 'new' ->> 'status' = 'approved' and entity_id in (select id::text from vers)) = 2,
  'both approvals were audited'
);
update public.unit_versions set status = 'published' where id = (select id from vers where label = 'v1');
update public.unit_versions set status = 'superseded' where id = (select id from vers where label = 'v2');
set local role authenticated;
set local request.jwt.claims = '{"sub":"f3000000-0000-4000-8000-000000000003","role":"authenticated","aal":"aal2"}';
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v1'), 'draft')$$,
  '22023', 'illegal_status_move', 'a published version cannot move'
);
select throws_ok(
  $$select public.set_unit_version_status((select id from vers where label = 'v2'), 'in_review')$$,
  '22023', 'illegal_status_move', 'nor can a superseded one'
);
reset role;

select * from finish();
rollback;
