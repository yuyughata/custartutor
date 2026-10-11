-- 08 reference data: levels P1-P6, core subjects and electives, cast stubs.
-- Idempotent (ON CONFLICT DO NOTHING). All of this is editable data; admins change it through the
-- admin app, not by editing this migration.

insert into public.levels (code, name, stage, sort) values
  ('P1', 'Primary 1', 'absorb', 1),
  ('P2', 'Primary 2', 'connect', 2),
  ('P3', 'Primary 3', 'connect', 3),
  ('P4', 'Primary 4', 'connect', 4),
  ('P5', 'Primary 5', 'express', 5),
  ('P6', 'Primary 6', 'express', 6)
on conflict (code) do nothing;

-- icon is a design-system icon key and colour a placeholder accent: both are cosmetic and editable.
-- Electives follow the NERDC basic education curriculum too, so curriculum_source is 'nerdc' for all.
insert into public.subjects (slug, name, kind, curriculum_source, icon, colour, sort) values
  ('english-studies',         'English Studies',              'core',     'nerdc', 'book-open',     '#2563EB', 10),
  ('mathematics',             'Mathematics',                  'core',     'nerdc', 'calculator',    '#7C3AED', 20),
  ('basic-science',           'Basic Science',                'core',     'nerdc', 'flask-conical', '#0D9488', 30),
  ('social-studies',          'Social Studies',               'core',     'nerdc', 'users',         '#EA580C', 40),
  ('civic-education',         'Civic Education',              'core',     'nerdc', 'landmark',      '#B45309', 50),
  ('cultural-creative-arts',  'Cultural and Creative Arts',   'core',     'nerdc', 'palette',       '#DB2777', 60),
  ('nigerian-language',       'Nigerian Language',            'core',     'nerdc', 'languages',     '#16A34A', 70),
  ('physical-health-education', 'Physical and Health Education', 'core',  'nerdc', 'heart-pulse',   '#DC2626', 80),
  ('religion-studies',        'Religion Studies',             'elective', 'nerdc', 'sparkles',      '#4F46E5', 110),
  ('ict',                     'ICT',                          'elective', 'nerdc', 'monitor',       '#0891B2', 120),
  ('pre-vocational-studies',  'Pre-vocational Studies',       'elective', 'nerdc', 'wrench',        '#65A30D', 130),
  ('french',                  'French',                       'elective', 'nerdc', 'message-circle', '#9333EA', 140)
on conflict (slug) do nothing;

-- Cast stubs. The character bible is PENDING: traits and voice stay empty objects until it is
-- supplied. They must not be guessed (see docs/plan.md section 13).
insert into public.characters (slug, name, traits, voice, active) values
  ('zari', 'Zari', '{}'::jsonb, '{}'::jsonb, true),
  ('zuri', 'Zuri', '{}'::jsonb, '{}'::jsonb, true)
on conflict (slug) do nothing;
