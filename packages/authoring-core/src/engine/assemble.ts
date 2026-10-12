// Assembly: the deterministic step that builds a UnitContent from the parts the model steps produced, parses it
// strictly with content-schema and lints it. No model call. Used by the `assemble` step, by `repair:n` (which
// re-assembles after rewriting sections) and exported for the admin app.
import {
  CURRENT_SCHEMA_VERSION,
  UnitParseError,
  lintUnit,
  parseUnit,
  type LintReport,
  type Question,
  type SectionType,
  type UnitContent,
} from '@custar/content-schema';
import type { Flag, Json, UnitGenerateInput } from '../contract';
import type { StoredOutline } from './sections';
import type { SectionPart } from './mapping';
import { toJson, wordForCount, unique } from './util';

// ---------------------------------------------------------------------------------------------
// Parts
// ---------------------------------------------------------------------------------------------

/** What the `workbook` step stores: the workbook pieces the practice section does not hold. */
export interface WorkbookPart {
  tier_titles: [string, string, string];
  drill: Question[];
  drill_seconds: number;
  take_it_home: string;
  application: Question;
  not_yet: string;
  variants: { id: string; questions: Question[] }[];
}

/** What the `manual` step stores. */
export interface ManualPart {
  script: { section_id: string; say: string; ask: string; watch_for: string }[];
  theme_lenses: { subject: string; lens: string; what_child_does: string }[];
  connection_moment: string;
  materials: string[];
  got_it: string[];
  not_yet_guidance: string;
  helper_script: { section_id: string; steps: string[] }[];
}

/** What the `draft` step stores for a mini or term project. */
export interface ProjectPart {
  brief: string;
  steps: { n: number; text: string }[];
  materials: string[];
  rubric: { criterion: string; levels: { level: number; descriptor: string }[] }[];
  evidence_options: ('photo' | 'drawing' | 'audio' | 'text')[];
  reflection_prompts: string[];
  tutor_script?: unknown;
}

/** What the `draft` step stores for a revision or an assessment. */
export interface TestPart {
  sections: SectionPart[];
}

export interface LessonParts {
  outline: StoredOutline;
  sections: Readonly<Record<string, SectionPart>>;
  workbook: WorkbookPart;
  manual: ManualPart;
}

export type UnitParts =
  | { kind: 'lesson'; lesson: LessonParts }
  | { kind: 'project'; project: ProjectPart }
  | { kind: 'test'; test: TestPart };

export interface AssembledUnit {
  /** The unit as JSON. Parsed and linted when `unit` is set; a best-effort draft when parsing failed. */
  content: Json;
  unit: UnitContent | null;
  errors: Flag[];
  warnings: Flag[];
  ok: boolean;
  /** Deterministic notes for the reviewer (not lint). */
  notes: string[];
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

export function lintToFlags(report: Pick<LintReport, 'errors' | 'warnings'>): {
  errors: Flag[];
  warnings: Flag[];
} {
  const flag = (
    issue: { code: string; message: string; path?: string | undefined },
    severity: 'note' | 'concern',
  ): Flag => ({
    code: issue.code,
    severity,
    message: issue.message,
    ...(issue.path ? { path: issue.path } : {}),
  });
  return {
    errors: report.errors.map((issue) => flag(issue, 'concern')),
    warnings: report.warnings.map((issue) => flag(issue, 'note')),
  };
}

const SEGMENT_LABEL: Record<string, string> = {
  start: 'Start',
  teach: 'Teach',
  move_and_do: 'Move & Do',
  practice: 'Practice',
  close: 'Close',
};

/** The manual's timing text, built from the session plan so it can never disagree with it. */
export function timingTextFrom(
  periods: readonly {
    period: number;
    sections: readonly string[];
    minutes: readonly { segment: string; minutes: number }[];
  }[],
  headings: ReadonlyMap<string, string>,
): string {
  const count = periods.length;
  const lines = periods.map((period) => {
    const total = period.minutes.reduce((sum, entry) => sum + entry.minutes, 0);
    const shape = period.minutes
      .map((entry) => `${SEGMENT_LABEL[entry.segment] ?? entry.segment} ${entry.minutes}`)
      .join(', ');
    const names = period.sections.map((id) => headings.get(id) ?? id).join('; ');
    return `Period ${period.period} (${total} minutes): ${shape}. Sections: ${names}.`;
  });
  return `${wordForCount(count)} ${count === 1 ? 'period' : 'periods'} of about an hour. ${lines.join(' ')}`;
}

export function timingText(outline: StoredOutline): string {
  return timingTextFrom(
    outline.periods,
    new Map(outline.sections.map((section) => [section.id, section.heading])),
  );
}

/** One line that tells a child (or a busy adult) the right answer, for the workbook's answers note. */
export function answerSummary(question: Question): string {
  switch (question.kind) {
    case 'mcq':
      return question.options[question.answer.correct_index] ?? '';
    case 'circle':
      return question.answer.correct.join(', ');
    case 'fill_blank':
      return question.answer.blanks.map((blank) => blank.accepted[0] ?? '').join(' / ');
    case 'match':
      return question.answer.pairs.map((pair) => `${pair.left}–${pair.right}`).join(', ');
    case 'sort':
      return Object.entries(question.answer.mapping)
        .map(([item, category]) => `${item}: ${category}`)
        .join('; ');
    case 'free_text':
    case 'spoken':
      return question.rubric.exemplar
        ? `any correct answer, for example "${question.rubric.exemplar}"`
        : 'any correct answer';
    case 'draw':
      return 'self-check';
    case 'tap_image':
      return question.answer.hotspots
        .filter((h) => h.correct)
        .map((h) => h.label)
        .join(', ');
    case 'speak':
      return question.answer.expected.join(' / ');
  }
}

export const WORKBOOK_INTRO =
  'Exercises move from supported (Tier 1) to independent (Tier 3). Answers are at the back for self-checking.';

export function answersNote(
  tiers: { question_ids: readonly string[] }[],
  drill: readonly string[],
  questions: Readonly<Record<string, Question>>,
): string {
  const ordered = tiers.flatMap((tier) => tier.question_ids);
  const parts = ordered.map((id, index) => {
    const question = questions[id];
    return `${index + 1}. ${question ? answerSummary(question) : '?'}.`;
  });
  const drillAnswers = drill.map((id) => {
    const question = questions[id];
    return question ? answerSummary(question) : '?';
  });
  if (drillAnswers.length > 0) parts.push(`Quick-Answer: ${drillAnswers.join('; ')}.`);
  return parts.join(' ');
}

function parseOrIssues(raw: Json): { unit: UnitContent | null; errors: Flag[] } {
  try {
    return { unit: parseUnit(raw), errors: [] };
  } catch (error) {
    if (error instanceof UnitParseError) {
      return {
        unit: null,
        errors: error.issues.map((issue) => ({
          code: 'schema_invalid',
          severity: 'concern' as const,
          message: issue.message,
          ...(issue.path ? { path: issue.path } : {}),
        })),
      };
    }
    return {
      unit: null,
      errors: [
        {
          code: 'schema_invalid',
          severity: 'concern',
          message: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }
}

function lintParsed(
  raw: Json,
  input: { previous_enrichment: readonly SectionType[] },
): Omit<AssembledUnit, 'notes'> {
  const parsed = parseOrIssues(raw);
  if (!parsed.unit) {
    return { content: raw, unit: null, errors: parsed.errors, warnings: [], ok: false };
  }
  const report = lintUnit(parsed.unit, { previousEnrichment: input.previous_enrichment });
  const flags = lintToFlags(report);
  return {
    content: toJson(parsed.unit),
    unit: parsed.unit,
    errors: flags.errors,
    warnings: flags.warnings,
    ok: report.ok,
  };
}

function headerOf(input: UnitGenerateInput, weekFallback = false): Record<string, unknown> {
  const { unit } = input;
  const week = unit.week_no ?? (weekFallback ? Math.min(unit.unit_no, 15) : null);
  return {
    subject_slug: input.subject.slug,
    level_code: input.level_code,
    term: input.term,
    title: unit.title,
    objective: unit.objective,
    stage: unit.stage,
    ...(unit.stage_to ? { stage_to: unit.stage_to } : {}),
    ...(input.theme ? { theme: input.theme } : {}),
    chapter: { number: input.chapter.number, title: input.chapter.title },
    unit_no: unit.unit_no,
    ...(week !== null ? { week_no: week } : {}),
  };
}

// ---------------------------------------------------------------------------------------------
// Lesson
// ---------------------------------------------------------------------------------------------

export function assembleLesson(input: UnitGenerateInput, parts: LessonParts): AssembledUnit {
  const notes: string[] = [];
  const { outline, workbook, manual } = parts;
  if (input.unit.week_no === null) {
    notes.push(
      `The unit has no scheme week, so the header's week number was set to ${Math.min(input.unit.unit_no, 15)} (the unit number); set the real week by hand.`,
    );
  }

  const sections = [];
  const questions: Record<string, Question> = {};
  for (const outlineSection of outline.sections) {
    const part = parts.sections[outlineSection.id];
    if (!part) {
      notes.push(`Section ${outlineSection.id} has not been written.`);
      continue;
    }
    sections.push(part.section);
    for (const question of part.questions) questions[question.id] = question;
  }
  const workbookQuestions = [
    ...workbook.drill,
    workbook.application,
    ...workbook.variants.flatMap((variant) => variant.questions),
  ];
  for (const question of workbookQuestions) questions[question.id] = question;

  const practice = outline.sections.find((section) => section.type === 'practice');
  const practiceQuestions = practice ? (parts.sections[practice.id]?.questions ?? []) : [];
  const tiers = ([1, 2, 3] as const).map((tier, index) => ({
    tier,
    title: workbook.tier_titles[index],
    question_ids: practiceQuestions.filter((q) => q.tier === tier).map((q) => q.id),
  }));
  const drillIds = workbook.drill.map((q) => q.id);

  const sectionIds = new Set(sections.map((s) => s.id));
  const scriptById = new Map(
    manual.script.filter((e) => sectionIds.has(e.section_id)).map((e) => [e.section_id, e]),
  );
  const helperById = new Map(
    manual.helper_script.filter((e) => sectionIds.has(e.section_id)).map((e) => [e.section_id, e]),
  );
  const script = sections.flatMap((section) =>
    scriptById.has(section.id) ? [scriptById.get(section.id)!] : [],
  );
  for (const section of sections) {
    if (!scriptById.has(section.id))
      notes.push(`The teacher's manual has no script entry for ${section.id}.`);
  }
  const helper_script = sections.flatMap((section) =>
    helperById.has(section.id) ? [helperById.get(section.id)!] : [],
  );

  const raw = toJson({
    schema_version: CURRENT_SCHEMA_VERSION,
    kind: 'lesson',
    header: headerOf(input, true),
    sections,
    questions,
    session_plan: outline.periods.map((period) => ({
      period: period.period,
      sections: period.sections,
      minutes: period.minutes,
    })),
    workbook: {
      intro: WORKBOOK_INTRO,
      tiers,
      quick_answer_drill: {
        seconds: Math.max(10, Math.min(600, Math.round(workbook.drill_seconds))),
        question_ids: drillIds,
      },
      take_it_home: workbook.take_it_home,
      application_task_id: workbook.application.id,
      answers_note: answersNote(tiers, drillIds, questions),
      not_yet: workbook.not_yet,
      practice_variants: workbook.variants.map((variant) => ({
        id: variant.id,
        question_ids: variant.questions.map((q) => q.id),
      })),
    },
    teacher_manual: {
      script,
      ...(manual.theme_lenses.length > 0 && manual.connection_moment.trim() !== ''
        ? {
            theme_map: { lenses: manual.theme_lenses, connection_moment: manual.connection_moment },
          }
        : {}),
      timing: timingText(outline),
      materials: manual.materials,
      mastery_guidance: { got_it: manual.got_it, not_yet: manual.not_yet_guidance },
      helper_script,
    },
  });
  return { ...lintParsed(raw, input), notes };
}

// ---------------------------------------------------------------------------------------------
// Projects, revision, assessment
// ---------------------------------------------------------------------------------------------

export function assembleProject(input: UnitGenerateInput, project: ProjectPart): AssembledUnit {
  const raw = toJson({
    schema_version: CURRENT_SCHEMA_VERSION,
    kind: input.unit.kind,
    header: headerOf(input),
    brief: project.brief,
    steps: project.steps,
    materials: project.materials,
    rubric: project.rubric,
    evidence_options: unique(project.evidence_options),
    reflection_prompts: project.reflection_prompts,
    ...(project.tutor_script ? { tutor_script: project.tutor_script } : {}),
  });
  return { ...lintParsed(raw, input), notes: [] };
}

export function assembleTest(input: UnitGenerateInput, test: TestPart): AssembledUnit {
  const questions: Record<string, Question> = {};
  for (const part of test.sections) for (const q of part.questions) questions[q.id] = q;
  const total = Object.keys(questions).length;
  const raw = toJson({
    schema_version: CURRENT_SCHEMA_VERSION,
    kind: input.unit.kind,
    header: headerOf(input),
    sections: test.sections.map((part) => part.section),
    questions,
    scoring: { total_marks: Math.max(1, total), pass_mark: Math.ceil(total / 2) },
  });
  return { ...lintParsed(raw, input), notes: [] };
}

/** Builds, parses and lints a unit from its parts. */
export function assembleUnit(input: UnitGenerateInput, parts: UnitParts): AssembledUnit {
  switch (parts.kind) {
    case 'lesson':
      return assembleLesson(input, parts.lesson);
    case 'project':
      return assembleProject(input, parts.project);
    case 'test':
      return assembleTest(input, parts.test);
  }
}
