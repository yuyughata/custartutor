# @custar/content-schema

Zod schemas, publish-gate lint, offline grading, scheme helpers and `schema_version` migrations for CUSTAR
Tutor unit content. Pure TypeScript: no React Native, no Node APIs, no I/O. It runs in the learner app, the
admin app, and (bundled by `npm run vendor`) in Supabase Edge Functions.

Source-first: the entry is `src/index.ts`, there is no build step. Fixtures are a separate entry,
`@custar/content-schema/fixtures`, and are deliberately not part of the public index (they would bloat the
vendored edge bundle).

## Usage

```ts
import {
  parseUnit, // strict: migrate, normalise, validate. Throws UnitParseError / SchemaVersionError
  parseUnitLenient, // for readers: unknown block types degrade instead of failing
  lintUnit, // publish gate: { errors, warnings, ok }
  lintVersionIds, // stable-ID rule between two versions of a unit
  gradeQuestion, // deterministic offline grading
  groupIntoChapters, // propose 3-5 unit chapters from a scheme of work
} from '@custar/content-schema';

const unit = parseUnit(JSON.parse(text)); // typed UnitContent
const report = lintUnit(unit, {
  previousEnrichment: ['story_opener', 'remember', 'do_and_discover'],
});
if (!report.ok) console.error(report.errors);

const question = unit.kind === 'lesson' ? unit.questions['qf_gutter'] : undefined;
if (question) {
  gradeQuestion(question, { kind: 'mcq', selected_index: 1 }); // { result: 'correct', detail: {...} }
}
```

All schemas are exported with their inferred types under the same name (`Question`, `Section`, `LessonUnit`,
`UnitContent`, ...). The schemas contain no transforms, so `z.toJSONSchema(...)` works on them (for example to
build per-section structured-output schemas for Claude).

## The unit

`UnitContent` is discriminated on `kind`:

| kind                           | What it holds                                                                                           |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `lesson`                       | header, `sections[]`, `questions` map, `session_plan`, `workbook`, `teacher_manual`                     |
| `mini_project`, `term_project` | brief, numbered steps, local materials, rubric, evidence options, reflection prompts, optional sections |
| `revision`, `assessment`       | header, `sections[]`, `questions` map, `scoring`                                                        |

A lesson yields three deliverables from one record: the textbook (sections), the workbook (`workbook`) and
the teacher's manual (`teacher_manual`). Brief section 7 is encoded in `sections.ts`: `ALWAYS_PRESENT_TYPES`,
`ENRICHMENT_MENU` and `LAYER_FOR_TYPE`.

Conventions:

- **Inline markup.** Text fields may contain `**bold**` spans and nothing else. Use `stripInlineMarkup` for
  speech and analysis.
- **Blocks.** Sections hold `AnyBlock[]`: the ten known block types plus the degraded `unknown` stand-in
  (`{ type: 'unknown', original_type, raw }`). Renderers must handle `unknown` by skipping it. `lintUnit`
  reports it as an error, so it can never be published.
- **Unknown fields are stripped** on parse, so content from a newer pack still opens in an older build.
- **Unicode.** `parseUnit` normalises every string and object key to NFC (Yoruba, Igbo and Hausa letters can
  arrive composed or decomposed).
- **Numbers.** `unit_no` is the 1-based ordinal of the unit within its term; `week_no` is the scheme week.

## The stable-ID rule

Section ids, question ids, tutor node ids, hotspot ids and practice-variant ids are assigned once and **never
change or disappear across versions of a unit**. Everything downstream keys on them: `unit_questions` (the
read model projected from published JSON), spaced practice, item analysis, mastery history, tutor scripts and
ID-addressed revision patches.

- Revise content by changing the text of a section or question, never its id.
- Adding new ids is always fine. Removing or regenerating one is an error:
  `lintVersionIds(previous, next)` returns `section_id_dropped` / `question_id_dropped` for each missing id.
  Run it on every new draft version against the version it was based on.
- The `questions` map key must equal the question's own `id` (`question_key_mismatch`).

## Grading (deterministic, offline)

`gradeQuestion(question, response)` returns `{ result: 'correct' | 'incorrect' | 'partial' | 'ungraded', detail }`.
Only `correct` results from deterministic kinds may count towards mastery.

| Kind                  | Graded                     | Response shape                                         |
| --------------------- | -------------------------- | ------------------------------------------------------ |
| `mcq`                 | offline                    | `{ kind: 'mcq', selected_index }`                      |
| `fill_blank`          | offline, per blank         | `{ kind: 'fill_blank', answers: string[] }`            |
| `match`               | offline, per pair          | `{ kind: 'match', pairs: { left, right }[] }`          |
| `circle`              | offline, set               | `{ kind: 'circle', selected: string[] }`               |
| `sort`                | offline, per item          | `{ kind: 'sort', placements: Record<item, category> }` |
| `tap_image`           | offline, set               | `{ kind: 'tap_image', hotspot_ids: string[] }`         |
| `speak`               | offline, on the transcript | `{ kind: 'speak', transcript }`                        |
| `draw`                | self-check, `ungraded`     | n/a                                                    |
| `free_text`, `spoken` | online only, `ungraded`    | n/a (rubric is for Claude or a human)                  |

Matching rules:

- Text: NFC, trim, collapse whitespace, lowercase, ignore trailing punctuation and surrounding quotes.
  Diacritics are kept ("ọkọ" is not "oko").
- Numeric blanks (`numeric: true`): exact value comparison on rationals. `1/2` = `0.5` = `½` = `2/4`;
  `1,000` = `1000`; optional `units` such as `["₦", "naira"]` may surround the number. **No edit distance is
  ever applied to numbers**: `12` never matches `21`, and `10` never matches `100`.
- Typo tolerance: at most one edit, only for non-numeric accepted answers of 6 or more characters, never for
  anything containing a digit. Switch it off per blank with `exact: true` or per call with
  `{ typoTolerance: false }`.
- A blank in a `fill_blank` prompt is a run of three or more underscores. The number of blanks must equal
  `answer.blanks.length`.

## Lint (the publish gate)

`lintUnit(unit, ctx?)` is pure. Errors block publishing; warnings go to the human reviewer (a human always
approves).

Errors: `missing_section` (the six always-present types), `enrichment_count` (exactly 2 or 3 sections from
the menu), `enrichment_duplicate`, `objective_empty`, `workbook_tiers` (three tiers, each with questions),
`workbook_application_task`, `workbook_drill`, `answer_spec_missing`, `answer_spec_invalid`, `rubric_missing`,
`teacher_manual_missing` / `_script` / `_materials` / `_mastery`, `mastery_no_gradable`, `dangling_ref`,
`duplicate_id`, `question_key_mismatch`, `unknown_block`.

Warnings: `think_deeper_rung` and `think_deeper_too_hard` (keyword heuristic against the reasoning rung of
`stage_to ?? stage`), `enrichment_not_rotated` (needs `ctx.previousEnrichment`), `no_global_window`,
`session_minutes` (a period should total 50 to 70 minutes), `reading_level` (average sentence over 12 words in
absorb and connect stage sections), `layer_mismatch`, `religious_term` (whole-word screen: church, mosque,
pray, god, allah, jesus, christ, bible, quran, koran and plurals or forms; for human review only),
`helper_script_empty`.

## Schemes and chapters

`Scheme` models a NERDC scheme of work for one subject, level and term (13 weeks, each `teaching`,
`mid_term_exam`, `break`, `revision`, `exam` or `closing`). `groupIntoChapters(scheme, { min: 3, max: 5 })`
proposes chapters of consecutive teaching weeks; see its doc comment for the algorithm (greedy chunks of 4,
short tail merged or rebalanced). P1 Basic Science Term 1 gives 4 + 4.

## Migrations

`migrateToCurrent(raw)` upgrades by applying `MIGRATIONS[n]` (`vN -> vN+1`, pure functions) until
`CURRENT_SCHEMA_VERSION`, and returns `{ unit, from, to }`. A missing `schema_version` counts as 0. Content
newer than this build throws `SchemaVersionError` (`code: 'newer_than_supported'`).

To change the schema:

1. Bump `CURRENT_SCHEMA_VERSION` in `common.ts`.
2. Add `MIGRATIONS[oldVersion]` in `migrate.ts` (never edit an existing migration).
3. Add a golden before/after pair to `migrate.test.ts`.
4. Run `npm run vendor` and commit the regenerated edge bundle.

v0 to v1 (shipped): `header.nerdc_objective` became `header.objective`, and `questions` changed from an array
to a map keyed by question id.

## Fixtures

`@custar/content-schema/fixtures` exports:

- `goldenUnit2`: P1 Basic Science T1 Unit 2, transcribed from the template PDF (see the comment at the top of
  the file for the enrichment-count decision and what was added beyond the PDF);
- `marketDayMathsUnit`: an illustrative P1 Mathematics unit (not from a verified NERDC scheme);
- `colourChartProject`: a mini project for T1 week 4;
- `p1BasicScienceSchemes` (and `p1BasicScienceTerm1/2/3`): the full P1 Basic Science scheme of work.

The freeze test for this schema is that all of them parse and lint.
