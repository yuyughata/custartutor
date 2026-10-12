-- 18 M2 content engine, part 5: the owner's cast facts (OWNER_CAST_FACTS in packages/authoring-core/src/contract.ts).
--
-- The owner gave exactly these facts on 2026-10-12 and nothing else:
--   Zari  age 7,              female, she/her
--   Zuri  age 4 ("almost 5"), male,   he/him
-- Everything else about the characters is UNKNOWN and stays unset: no relationship (relationship_note is not written,
-- so the generator never calls them siblings or friends), no personality (`personality` is an empty list until the
-- owner supplies one). `derived_guidance` is writing guidance derived from AGE ONLY, worded as such, generic, and
-- editable in the characters editor.
--
-- Merge, never replace: traits = defaults || existing traits || owner facts (jsonb `||`; the right side wins). Keys the
-- admins already added survive, a `personality` or `derived_guidance` they edited is not overwritten, and the owner's
-- facts always hold. Idempotent: a second run produces the same traits.

update public.characters c
   set traits =
         jsonb_build_object(
           'personality', '[]'::jsonb,
           'derived_guidance',
           'Derived from age only (7), editable. These are not facts about her personality. Write for a Primary 1 reader: short sentences, concrete everyday words, one idea at a time. A seven-year-old can follow a few steps in a row and can give a simple reason for an answer.'
         )
         || c.traits
         || jsonb_build_object('age_years', 7, 'gender', 'female', 'pronouns', 'she/her')
 where c.slug = 'zari';

update public.characters c
   set traits =
         jsonb_build_object(
           'personality', '[]'::jsonb,
           'derived_guidance',
           'Derived from age only (almost 5), editable. These are not facts about his personality. Use very short sentences and everyday words, one idea at a time, and no more than one or two simple steps in any instruction. Learning at this age is concrete and hands-on, with familiar things.'
         )
         || c.traits
         || jsonb_build_object('age_years', 4, 'age_note', 'almost 5', 'gender', 'male', 'pronouns', 'he/him')
 where c.slug = 'zuri';

comment on table public.characters is
  'Cast bible. traits hold only what the owner supplied (age, gender, pronouns) plus age-derived writing guidance (editable); personality and relationships stay empty until supplied. Never guess them (docs/plan.md section 13).';
