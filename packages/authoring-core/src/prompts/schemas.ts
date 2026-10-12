// Authoring-time schemas: what the MODEL writes for each step.
//
// These are deliberately smaller and flatter than the final Zod unit schemas of @custar/content-schema.
// The engine maps them to the final shapes in code (see engine/mapping.ts) and validates the result with the
// real schemas, so nothing here is trusted for correctness.
//
// Rules these schemas follow, because they are sent as structured-output JSON Schema:
//   - every property is required (the model writes "" or [] when a field does not apply): the API caps the
//     number of optional properties per request, and an absent key is a common source of bad replies;
//   - no unions (`oneOf`/`anyOf`): blocks and questions are ONE flat shape with a `type` / `kind` field that says
//     which of the other fields are meaningful (the guide in schemaGuide.ts explains the mapping);
//   - no `.int()`, `.min()`, `.max()`, `.regex()`, `.length()`: the API ignores them (or the adapter folds them
//     into the description). Counts, ranges and patterns are re-checked in code (engine/mapping.ts);
//   - no transforms, records, tuples or recursion.
// `engine/schemas.test.ts` converts every exported schema with z.toJSONSchema and fails on `pattern`, `oneOf`,
// `minimum`/`maximum`, `minLength`/`maxLength` or recursion.
import { z } from 'zod';
import { ENRICHMENT_MENU, WEEK_KINDS } from '@custar/content-schema';

const str = z.string();
const strs = z.array(str);

// ---------------------------------------------------------------------------------------------
// Shared parts
// ---------------------------------------------------------------------------------------------

export const AUTHOR_BLOCK_TYPES = [
  'paragraph',
  'bullets',
  'definition',
  'example',
  'dialogue',
  'illustration',
  'callout',
  'activity_steps',
  'table',
  'question',
] as const;
export type AuthorBlockType = (typeof AUTHOR_BLOCK_TYPES)[number];

export const AUTHOR_TONES = ['info', 'tip', 'not_yet', 'none'] as const;

/** One content block. Which fields matter depends on `type` (see the schema guide). */
export const AuthorBlock = z.object({
  type: z.enum(AUTHOR_BLOCK_TYPES),
  /** paragraph text; callout text; example body; definition meaning; (alt text for an illustration is `alt`). */
  text: str,
  /** definition: the word; example: its label ("Example 1 - Places"). */
  label: str,
  /** illustration: what an illustrator should draw. */
  brief: str,
  /** illustration: one sentence for a child who cannot see the picture. */
  alt: str,
  /** callout: info | tip | not_yet. "none" for every other block. */
  tone: z.enum(AUTHOR_TONES),
  /** bullets: {head: bold lead-in or "", text}; dialogue: {head: speaker, text}; activity_steps: {head: LABEL, text}. */
  items: z.array(z.object({ head: str, text: str })),
  /** table column headings. */
  headers: strs,
  /** table rows (same length as headers). */
  rows: z.array(strs),
  /** question: the `ref` of one of this section's questions. */
  question_ref: str,
});
export type AuthorBlock = z.infer<typeof AuthorBlock>;

export const AUTHOR_QUESTION_KINDS = [
  'mcq',
  'fill_blank',
  'match',
  'circle',
  'sort',
  'free_text',
  'draw',
] as const;
export type AuthorQuestionKind = (typeof AUTHOR_QUESTION_KINDS)[number];

/** One question. Which fields matter depends on `kind` (see the schema guide). */
export const AuthorQuestion = z.object({
  /** A short name, unique inside the section, that blocks and tutor lines use to point at this question. */
  ref: str,
  kind: z.enum(AUTHOR_QUESTION_KINDS),
  /** 1 supported, 2 now you try, 3 stretch. */
  tier: z.literal([1, 2, 3]),
  prompt: str,
  hint: str,
  explanation: str,
  skill_tag: str,
  /** mcq / circle: the choices. */
  options: strs,
  /** mcq: exactly one entry, the text of the correct option. circle: the text of every correct option. */
  answers: strs,
  /** fill_blank: for each blank in the prompt, every accepted answer. */
  blanks: z.array(strs),
  /** fill_blank: true when the blanks hold numbers. */
  numeric: z.boolean(),
  /** fill_blank (numeric): unit words or symbols a child may write with the number. */
  units: strs,
  /** match: {left, right} pairs. sort: {left: item, right: category}. */
  pairs: z.array(z.object({ left: str, right: str })),
  /** free_text: rubric criteria. draw: things the child ticks to check their own work. */
  checks: strs,
  /** free_text: a model answer. */
  exemplar: str,
});
export type AuthorQuestion = z.infer<typeof AuthorQuestion>;

/** One line of the offline tutor dialogue. */
export const AuthorTutorLine = z.object({
  say: str,
  /** Short answers the child might say (lowercase, with natural variants). Empty when `question_ref` is used or nothing is asked. */
  accepted: strs,
  /** Or: the `ref` of one of this section's questions, which grades the reply. */
  question_ref: str,
  on_correct: strs,
  on_incorrect: strs,
  hint: strs,
});
export type AuthorTutorLine = z.infer<typeof AuthorTutorLine>;

/** What one section step returns: the section body, the questions it owns, its tutor dialogue. */
export const AuthorSectionBody = z.object({
  blocks: z.array(AuthorBlock),
  questions: z.array(AuthorQuestion),
  tutor_script: z.array(AuthorTutorLine),
});
export type AuthorSectionBody = z.infer<typeof AuthorSectionBody>;

// ---------------------------------------------------------------------------------------------
// scheme_ingest
// ---------------------------------------------------------------------------------------------

export const SchemeExtractOutput = z.object({
  /** The heading of the document as printed: subject, class, term. "" when not printed. */
  document_says: z.object({ subject: str, class_level: str, term: str }),
  weeks: z.array(
    z.object({
      week_no: z.number(),
      kind: z.enum(WEEK_KINDS),
      /** Copied exactly as printed. */
      topic: str,
      /** Copied exactly as printed, one entry per printed bullet or line. */
      subtopics: strs,
    }),
  ),
  /** Anything the reader could not read or had to guess (illegible, merged cells, page cut off). */
  notes: strs,
});
export type SchemeExtractOutput = z.infer<typeof SchemeExtractOutput>;

// ---------------------------------------------------------------------------------------------
// chapter_plan
// ---------------------------------------------------------------------------------------------

export const STAGE_VALUES = ['absorb', 'connect', 'express'] as const;

export const ChapterTitlesOutput = z.object({
  chapters: z.array(
    z.object({
      chapter_no: z.number(),
      title: str,
      /** A cross-subject theme for the chapter. All three "" when there is no honest theme. */
      theme_slug: str,
      theme_title: str,
      theme_lens: str,
      units: z.array(
        z.object({
          week_no: z.number(),
          title: str,
          objective: str,
          stage: z.enum(STAGE_VALUES),
          /** The higher stage when the unit moves from one stage to the next; "none" otherwise. */
          stage_to: z.enum([...STAGE_VALUES, 'none']),
        }),
      ),
    }),
  ),
});
export type ChapterTitlesOutput = z.infer<typeof ChapterTitlesOutput>;

// ---------------------------------------------------------------------------------------------
// unit_generate: outline
// ---------------------------------------------------------------------------------------------

const SectionPlan = z.object({ heading: str, plan: str });

export const OutlineOutput = z.object({
  /** 2 to 5 enrichment sections, each type once, in any order (the code puts them in unit order). */
  enrichment: z.array(z.object({ type: z.enum(ENRICHMENT_MENU), heading: str, plan: str })),
  /** 1 to 4 concept sections. They become concept_1, concept_2, ... in this order. */
  concepts: z.array(
    z.object({
      heading: str,
      plan: str,
      /** Numbers of the scheme subtopics (1-based, as listed) this concept teaches. */
      covers: z.array(z.number()),
    }),
  ),
  worked_examples: SectionPlan,
  practice: SectionPlan,
  think_deeper: SectionPlan,
  quick_fire: SectionPlan,
  mastery_check: SectionPlan,
  /** One entry per period. `sections` are section ids: concept_1.., or the section type name. */
  periods: z.array(
    z.object({
      sections: strs,
      start: z.number(),
      teach: z.number(),
      move_and_do: z.number(),
      practice: z.number(),
      close: z.number(),
    }),
  ),
});
export type OutlineOutput = z.infer<typeof OutlineOutput>;

// ---------------------------------------------------------------------------------------------
// unit_generate: workbook and manual
// ---------------------------------------------------------------------------------------------

export const WorkbookOutput = z.object({
  tier1_title: str,
  tier2_title: str,
  tier3_title: str,
  /** 4 to 6 very short recall questions, tier 1, auto-graded kinds. */
  drill: z.array(AuthorQuestion),
  drill_seconds: z.number(),
  take_it_home: str,
  /** The everyday-life task: kind "draw" or "free_text", tier 3. */
  application: AuthorQuestion,
  not_yet: str,
  /** Two pools of three extra practice questions. */
  variants: z.array(z.object({ questions: z.array(AuthorQuestion) })),
});
export type WorkbookOutput = z.infer<typeof WorkbookOutput>;

export const ManualOutput = z.object({
  /** One entry per section, in unit order. */
  script: z.array(z.object({ section_id: str, say: str, ask: str, watch_for: str })),
  /** Subjects that meet the unit's theme. Empty when the unit has no theme. */
  theme_lenses: z.array(z.object({ subject: str, lens: str, what_child_does: str })),
  connection_moment: str,
  materials: strs,
  got_it: strs,
  not_yet_guidance: str,
  /** For the human helper who sits with a child who cannot read yet. */
  helper_script: z.array(z.object({ section_id: str, steps: strs })),
});
export type ManualOutput = z.infer<typeof ManualOutput>;

// ---------------------------------------------------------------------------------------------
// unit_generate: review, repair, other kinds
// ---------------------------------------------------------------------------------------------

export const REVIEW_CODES = [
  'neutrality',
  'reading_level',
  'facts',
  'cast',
  'safety',
  'other',
] as const;

export const ReviewOutput = z.object({
  flags: z.array(
    z.object({
      code: z.enum(REVIEW_CODES),
      severity: z.enum(['note', 'concern']),
      /** The section id the flag is about, or "" for the whole unit. */
      section_id: str,
      message: str,
    }),
  ),
});
export type ReviewOutput = z.infer<typeof ReviewOutput>;

export const RepairOutput = z.object({
  sections: z.array(
    z.object({
      id: str,
      blocks: z.array(AuthorBlock),
      questions: z.array(AuthorQuestion),
      tutor_script: z.array(AuthorTutorLine),
    }),
  ),
});
export type RepairOutput = z.infer<typeof RepairOutput>;

export const EVIDENCE_VALUES = ['photo', 'drawing', 'audio', 'text'] as const;

export const ProjectDraftOutput = z.object({
  brief: str,
  steps: strs,
  materials: strs,
  rubric: z.array(
    z.object({
      criterion: str,
      /** Descriptors from the lowest level (1) to the highest, 2 to 4 of them. */
      levels: strs,
    }),
  ),
  evidence_options: z.array(z.enum(EVIDENCE_VALUES)),
  reflection_prompts: strs,
  tutor_script: z.array(AuthorTutorLine),
});
export type ProjectDraftOutput = z.infer<typeof ProjectDraftOutput>;

export const TestDraftOutput = z.object({
  /** revision_topic or assessment_part sections. */
  parts: z.array(
    z.object({
      heading: str,
      blocks: z.array(AuthorBlock),
      questions: z.array(AuthorQuestion),
    }),
  ),
});
export type TestDraftOutput = z.infer<typeof TestDraftOutput>;

// ---------------------------------------------------------------------------------------------
// unit_revise: the patch
// ---------------------------------------------------------------------------------------------

export const PatchOutput = z.object({
  /** One or two sentences: what you changed, or why you could not. */
  summary: str,
  /** Whole-section replacements (existing id) or new sections (new id). */
  sections: z.array(
    z.object({
      /** An existing section id to replace, or a NEW lowercase_with_underscores id to add a section. */
      id: str,
      /** Only used for a new section: concept, or an enrichment type not yet used. */
      type: str,
      /** "" keeps the existing heading. */
      heading: str,
      /** The complete new block list of the section. */
      blocks: z.array(AuthorBlock),
      /** The complete new tutor script. [] keeps the existing one. */
      tutor_script: z.array(AuthorTutorLine),
    }),
  ),
  /** Replaced questions (`ref` is an existing question id) or new ones (`ref` is a new short name). */
  questions: z.array(
    z.object({
      /** The section that owns a NEW question. Ignored for an existing question. */
      section_id: str,
      question: AuthorQuestion,
    }),
  ),
  /** Workbook text. "" keeps the existing text. */
  workbook: z.object({
    tier1_title: str,
    tier2_title: str,
    tier3_title: str,
    take_it_home: str,
    not_yet: str,
  }),
  /** Teacher's manual entries for the sections named. [] / "" keeps the existing entry. */
  manual: z.object({
    script: z.array(z.object({ section_id: str, say: str, ask: str, watch_for: str })),
    helper_script: z.array(z.object({ section_id: str, steps: strs })),
    materials: strs,
    got_it: strs,
    not_yet_guidance: str,
  }),
});
export type PatchOutput = z.infer<typeof PatchOutput>;

/** Every authoring schema by the name used as `schemaName` in a request. */
export const AUTHORING_SCHEMAS = {
  scheme_extract: SchemeExtractOutput,
  chapter_titles: ChapterTitlesOutput,
  unit_outline: OutlineOutput,
  unit_section: AuthorSectionBody,
  unit_workbook: WorkbookOutput,
  unit_manual: ManualOutput,
  unit_review: ReviewOutput,
  unit_repair: RepairOutput,
  unit_project: ProjectDraftOutput,
  unit_test: TestDraftOutput,
  unit_patch: PatchOutput,
} as const;
export type AuthoringSchemaName = keyof typeof AUTHORING_SCHEMAS;
