import { z } from 'zod';
import {
  CURRENT_SCHEMA_VERSION,
  Id,
  LevelCode,
  Slug,
  Stage,
  Term,
  Text,
  Tier,
  stageIndex,
} from './common';
import { Question } from './question';
import { findRefIssues } from './refs';
import type { UnitRefInput } from './refs';
import { Section } from './sections';
import { TutorScript } from './tutor-script';

/**
 * UnitContent: one record that yields the textbook, the workbook and the teacher's manual.
 * Discriminated on `kind`. Cross-references (question blocks, session plan, workbook, manual, tutor
 * scripts) are checked with `superRefine`, so a unit that parses never has a dangling id.
 */

export const Theme = z.object({
  slug: Slug,
  title: Text,
  /** The subject's lens on the theme, for example "Value", "Observation", "Language". */
  lens: Text,
});
export type Theme = z.infer<typeof Theme>;

export const Chapter = z.object({
  number: z.number().int().min(1),
  title: Text,
});
export type Chapter = z.infer<typeof Chapter>;

const headerCore = {
  subject_slug: Slug,
  level_code: LevelCode,
  term: Term,
  title: Text,
  /** The NERDC objective, verbatim from the scheme of work. */
  objective: Text,
  stage: Stage,
  /** When a unit straddles two stages (the template reads "Absorb -> Connect"), the higher one. */
  stage_to: Stage.optional(),
  theme: Theme.optional(),
};

function checkStageRange(
  header: { stage: Stage; stage_to?: Stage },
  ctx: z.RefinementCtx,
): void {
  if (header.stage_to !== undefined && stageIndex(header.stage_to) < stageIndex(header.stage)) {
    ctx.addIssue({
      code: 'custom',
      message: 'stage_to must not be an earlier stage than stage',
      path: ['stage_to'],
    });
  }
}

/** Lesson header. `unit_no` is the 1-based ordinal of the unit within its term; `week_no` is the scheme week. */
export const LessonHeader = z
  .object({
    ...headerCore,
    chapter: Chapter,
    unit_no: z.number().int().min(1),
    week_no: z.number().int().min(1).max(15),
  })
  .superRefine(checkStageRange);
export type LessonHeader = z.infer<typeof LessonHeader>;

/** Header for projects, revision and assessments: chapter, unit and week are optional. */
export const GeneralHeader = z
  .object({
    ...headerCore,
    chapter: Chapter.optional(),
    unit_no: z.number().int().min(1).optional(),
    week_no: z.number().int().min(1).max(15).optional(),
  })
  .superRefine(checkStageRange);
export type GeneralHeader = z.infer<typeof GeneralHeader>;

/** The headline fields every unit header carries. */
export type UnitHeader = LessonHeader | GeneralHeader;

const schemaVersion = z.literal(CURRENT_SCHEMA_VERSION);

function addRefIssues(unit: UnitRefInput, ctx: z.RefinementCtx): void {
  for (const issue of findRefIssues(unit)) {
    ctx.addIssue({ code: 'custom', message: issue.message, path: issue.path });
  }
}

const QuestionMap = z.record(Id, Question);

// ---------------------------------------------------------------------------------------------
// Lesson
// ---------------------------------------------------------------------------------------------

export const SESSION_SEGMENTS = ['start', 'teach', 'move_and_do', 'practice', 'close'] as const;
export const SessionSegment = z.enum(SESSION_SEGMENTS);
export type SessionSegment = z.infer<typeof SessionSegment>;

/** One period of the week's timetable for this subject, in the one-hour shape (Start, Teach, Move & Do, Practice, Close). */
export const SessionPeriod = z.object({
  period: z.number().int().min(1),
  sections: z.array(Id).min(1),
  minutes: z
    .array(z.object({ segment: SessionSegment, minutes: z.number().int().min(1).max(120) }))
    .min(1),
});
export type SessionPeriod = z.infer<typeof SessionPeriod>;

export const WorkbookTier = z.object({
  tier: Tier,
  title: Text,
  question_ids: z.array(Id).min(1),
});
export type WorkbookTier = z.infer<typeof WorkbookTier>;

export const Workbook = z.object({
  /** The "How this works" note at the top of the workbook. */
  intro: Text.optional(),
  /** Tier 1 supported, Tier 2 now you try, Tier 3 stretch. Lint requires all three. */
  tiers: z.array(WorkbookTier).min(1).max(3),
  quick_answer_drill: z.object({
    seconds: z.number().int().min(10).max(600),
    question_ids: z.array(Id),
  }),
  take_it_home: Text,
  /** The everyday-life application task: a question in the unit's `questions` map. */
  application_task_id: Id,
  answers_note: Text.optional(),
  /** Remediation text for a child who has not yet mastered the unit. */
  not_yet: Text.optional(),
  /** Pre-reviewed pools for "more practice" (instead of generating worksheets on demand). */
  practice_variants: z.array(z.object({ id: Id, question_ids: z.array(Id).min(1) })),
});
export type Workbook = z.infer<typeof Workbook>;

export const TeacherManual = z.object({
  /** Say this, ask this, watch for this. */
  script: z.array(z.object({ section_id: Id, say: Text, ask: Text, watch_for: Text })),
  /** Which subjects touch the shared theme, and the two-minute connection moment. */
  theme_map: z
    .object({
      lenses: z.array(z.object({ subject: Text, lens: Text, what_child_does: Text })).min(1),
      connection_moment: Text,
    })
    .optional(),
  timing: Text,
  /** Low-cost local items needed (for Do & Discover and practice). */
  materials: z.array(Text),
  mastery_guidance: z.object({
    /** What "got it" looks like. */
    got_it: z.array(Text),
    /** What to do when the child has not got it yet. */
    not_yet: Text,
  }),
  /** Script for the human helper who co-pilots a pre-reader's lesson. */
  helper_script: z.array(z.object({ section_id: Id, steps: z.array(Text).min(1) })),
});
export type TeacherManual = z.infer<typeof TeacherManual>;

export const LessonUnit = z
  .object({
    schema_version: schemaVersion,
    kind: z.literal('lesson'),
    header: LessonHeader,
    sections: z.array(Section).min(1),
    questions: QuestionMap,
    session_plan: z.array(SessionPeriod).min(1),
    workbook: Workbook,
    teacher_manual: TeacherManual,
  })
  .superRefine(addRefIssues);
export type LessonUnit = z.infer<typeof LessonUnit>;

// ---------------------------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------------------------

export const EVIDENCE_OPTIONS = ['photo', 'drawing', 'audio', 'text'] as const;
export const EvidenceOption = z.enum(EVIDENCE_OPTIONS);
export type EvidenceOption = z.infer<typeof EvidenceOption>;

export const RubricRow = z.object({
  criterion: Text,
  /** Ordered from lowest to highest level; `level` is 1 to 4. */
  levels: z.array(z.object({ level: z.number().int().min(1).max(4), descriptor: Text })).min(2),
});
export type RubricRow = z.infer<typeof RubricRow>;

const projectShape = {
  schema_version: schemaVersion,
  header: GeneralHeader,
  /** What the child will make or find out, in child language. */
  brief: Text,
  steps: z.array(z.object({ n: z.number().int().min(1), text: Text })).min(1),
  /** Local, low-cost materials. */
  materials: z.array(Text).min(1),
  rubric: z.array(RubricRow).min(1),
  evidence_options: z.array(EvidenceOption).min(1),
  reflection_prompts: z.array(Text).min(1),
  tutor_script: TutorScript.optional(),
  sections: z.array(Section).optional(),
  questions: QuestionMap.optional(),
};

function checkProject(
  unit: { steps: { n: number }[]; evidence_options: string[] } & UnitRefInput,
  ctx: z.RefinementCtx,
): void {
  unit.steps.forEach((step, index) => {
    if (step.n !== index + 1) {
      ctx.addIssue({
        code: 'custom',
        message: `steps must be numbered 1, 2, 3 ... in order (step ${index + 1} has n=${step.n})`,
        path: ['steps', index, 'n'],
      });
    }
  });
  if (new Set(unit.evidence_options).size !== unit.evidence_options.length) {
    ctx.addIssue({
      code: 'custom',
      message: 'evidence_options must be distinct',
      path: ['evidence_options'],
    });
  }
  addRefIssues(unit, ctx);
}

export const MiniProjectUnit = z
  .object({ kind: z.literal('mini_project'), ...projectShape })
  .superRefine(checkProject);
export type MiniProjectUnit = z.infer<typeof MiniProjectUnit>;

export const TermProjectUnit = z
  .object({ kind: z.literal('term_project'), ...projectShape })
  .superRefine(checkProject);
export type TermProjectUnit = z.infer<typeof TermProjectUnit>;

// ---------------------------------------------------------------------------------------------
// Revision and assessment
// ---------------------------------------------------------------------------------------------

export const Scoring = z
  .object({
    total_marks: z.number().int().min(1),
    pass_mark: z.number().int().min(0),
  })
  .superRefine((scoring, ctx) => {
    if (scoring.pass_mark > scoring.total_marks) {
      ctx.addIssue({
        code: 'custom',
        message: 'pass_mark must not exceed total_marks',
        path: ['pass_mark'],
      });
    }
  });
export type Scoring = z.infer<typeof Scoring>;

const testShape = {
  schema_version: schemaVersion,
  header: GeneralHeader,
  sections: z.array(Section).min(1),
  questions: QuestionMap,
  scoring: Scoring,
};

export const RevisionUnit = z
  .object({ kind: z.literal('revision'), ...testShape })
  .superRefine(addRefIssues);
export type RevisionUnit = z.infer<typeof RevisionUnit>;

export const AssessmentUnit = z
  .object({ kind: z.literal('assessment'), ...testShape })
  .superRefine(addRefIssues);
export type AssessmentUnit = z.infer<typeof AssessmentUnit>;

// ---------------------------------------------------------------------------------------------
// The union
// ---------------------------------------------------------------------------------------------

export const UnitContent = z.discriminatedUnion('kind', [
  LessonUnit,
  MiniProjectUnit,
  TermProjectUnit,
  RevisionUnit,
  AssessmentUnit,
]);
export type UnitContent = z.infer<typeof UnitContent>;

export type ProjectUnit = MiniProjectUnit | TermProjectUnit;

/** All sections of a unit, whatever its kind (projects may have none). */
export function sectionsOf(unit: UnitContent): Section[] {
  return 'sections' in unit && unit.sections ? unit.sections : [];
}

/** The questions map of a unit, whatever its kind (projects may have none). */
export function questionsOf(unit: UnitContent): Record<string, Question> {
  return 'questions' in unit && unit.questions ? unit.questions : {};
}
