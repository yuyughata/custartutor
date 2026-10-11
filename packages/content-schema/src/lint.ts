import { stripInlineMarkup } from './blocks';
import type { AnyBlock } from './blocks';
import { stageIndex } from './common';
import type { Stage } from './common';
import { isDeterministic, answerProblems } from './question';
import type { Question } from './question';
import { findRefIssues } from './refs';
import {
  ALWAYS_PRESENT_TYPES,
  ENRICHMENT_MENU,
  LAYER_FOR_TYPE,
  isEnrichmentType,
} from './sections';
import type { Section, SectionType } from './sections';
import { questionsOf, sectionsOf } from './unit';
import type { TeacherManual, UnitContent, Workbook } from './unit';

/**
 * Publish-gate lint for unit content (plan section 4, brief section 17). Pure: no I/O, no randomness.
 *
 * ERRORS block publishing. WARNINGS are advisory and go to the human reviewer; a human always approves.
 */

export interface Issue {
  code: string;
  message: string;
  /** Location in the unit, for example `sections[3].blocks[1]`. */
  path?: string;
}

export interface LintReport {
  errors: Issue[];
  warnings: Issue[];
  ok: boolean;
}

export interface LintContext {
  /** Section types of the enrichment trio used by the previous unit of the same subject. */
  previousEnrichment?: readonly SectionType[];
}

export const ENRICHMENT_MIN = 2;
export const ENRICHMENT_MAX = 3;
export const SESSION_MINUTES_MIN = 50;
export const SESSION_MINUTES_MAX = 70;
/** Early-years text should average no more than this many words per sentence. */
export const MAX_AVERAGE_SENTENCE_WORDS = 12;

/** Words flagged for human review of religious neutrality (whole words, case-insensitive). */
export const RELIGIOUS_TERM_PATTERN =
  /\b(?:church(?:es)?|mosques?|pray(?:s|ed|ing)?|prayers?|gods?|allah|jesus|christ|bible|quran|koran)\b/gi;

type PathSegment = string | number;

function formatPath(segments: readonly PathSegment[]): string {
  return segments.reduce<string>((out, segment) => {
    if (typeof segment === 'number') return `${out}[${segment}]`;
    return out === '' ? segment : `${out}.${segment}`;
  }, '');
}

class Report {
  readonly errors: Issue[] = [];
  readonly warnings: Issue[] = [];

  error(code: string, message: string, path?: readonly PathSegment[]): void {
    this.errors.push({ code, message, ...(path ? { path: formatPath(path) } : {}) });
  }

  warn(code: string, message: string, path?: readonly PathSegment[]): void {
    this.warnings.push({ code, message, ...(path ? { path: formatPath(path) } : {}) });
  }

  done(): LintReport {
    return { errors: this.errors, warnings: this.warnings, ok: this.errors.length === 0 };
  }
}

// ---------------------------------------------------------------------------------------------
// Text extraction
// ---------------------------------------------------------------------------------------------

/** Prose of a block, for reading-level analysis. Each entry is one sentence-like unit when `whole`. */
function proseOf(block: AnyBlock): { text: string; whole: boolean }[] {
  switch (block.type) {
    case 'paragraph':
      return [{ text: block.text, whole: false }];
    case 'bullets':
      return block.items.map((item) => ({
        text: item.lead ? `${item.lead} ${item.text}` : item.text,
        whole: true,
      }));
    case 'definition':
      return [{ text: `${block.term} ${block.meaning}`, whole: true }];
    case 'example':
      return [{ text: `${block.label} ${block.text}`, whole: false }];
    case 'dialogue':
      return block.lines.map((line) => ({ text: line.text, whole: false }));
    case 'callout':
      return [{ text: block.text, whole: false }];
    case 'activity_steps':
      return block.steps.map((step) => ({ text: `${step.label} ${step.text}`, whole: true }));
    default:
      return [];
  }
}

function wordCount(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

/** Average words per sentence over the prose blocks of a section; null when there is no prose. */
export function averageSentenceLength(blocks: readonly AnyBlock[]): number | null {
  let words = 0;
  let sentences = 0;
  for (const block of blocks) {
    for (const piece of proseOf(block)) {
      const text = stripInlineMarkup(piece.text).trim();
      if (text === '') continue;
      const parts = piece.whole ? [text] : text.split(/(?<=[.!?])\s+/);
      for (const part of parts) {
        const count = wordCount(part);
        if (count === 0) continue;
        words += count;
        sentences += 1;
      }
    }
  }
  return sentences === 0 ? null : words / sentences;
}

function collectStrings(
  value: unknown,
  path: PathSegment[],
  out: { path: PathSegment[]; text: string }[],
) {
  if (typeof value === 'string') {
    out.push({ path, text: value });
  } else if (Array.isArray(value)) {
    value.forEach((item: unknown, index) => collectStrings(item, [...path, index], out));
  } else if (typeof value === 'object' && value !== null) {
    for (const [key, item] of Object.entries(value)) {
      collectStrings(item, [...path, key], out);
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Think Deeper rungs (brief section 9)
// ---------------------------------------------------------------------------------------------

const EXPRESS_RUNG =
  /\b(?:explain why|explain how|give your reason|give a reason|which is better|how do you know)\b/;
const CONNECT_RUNG =
  /\b(?:same or different|why do you think|what would happen if|what if|how (?:is|are|does|do) .{0,60}(?:different|alike|the same)|why)\b/;
const ABSORB_RUNG = /\b(?:name|what|which|who|where|what comes next)\b/;

/** The highest reasoning rung a prompt appears to ask for, or null when no keyword matches. */
export function reasoningRungOf(prompt: string): Stage | null {
  const text = stripInlineMarkup(prompt).toLowerCase().replace(/[‘’]/g, "'");
  if (EXPRESS_RUNG.test(text)) return 'express';
  if (CONNECT_RUNG.test(text)) return 'connect';
  if (ABSORB_RUNG.test(text)) return 'absorb';
  return null;
}

function thinkDeeperPrompts(section: Section, questions: Record<string, Question>): string[] {
  const prompts: string[] = [];
  for (const block of section.blocks) {
    switch (block.type) {
      case 'bullets':
        prompts.push(...block.items.map((item) => item.text));
        break;
      case 'paragraph':
        prompts.push(
          ...(stripInlineMarkup(block.text).match(/[^.!?]*\?/g) ?? []).map((q) => q.trim()),
        );
        break;
      case 'activity_steps':
        prompts.push(...block.steps.map((step) => step.text).filter((text) => text.includes('?')));
        break;
      case 'question': {
        const question = questions[block.question_id];
        if (question) prompts.push(question.prompt);
        break;
      }
      default:
        break;
    }
  }
  return prompts.filter((prompt) => prompt.trim() !== '');
}

// ---------------------------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------------------------

function lintObjective(unit: UnitContent, report: Report): void {
  const objective: unknown = unit.header.objective;
  if (typeof objective !== 'string' || objective.trim() === '') {
    report.error('objective_empty', 'The NERDC objective is empty.', ['header', 'objective']);
  }
}

function lintRefs(unit: UnitContent, report: Report): void {
  for (const issue of findRefIssues(unit)) {
    report.error(issue.code, issue.message, issue.path);
  }
}

function lintBlocks(sections: readonly Section[], report: Report): void {
  sections.forEach((section, sectionIndex) => {
    section.blocks.forEach((block, blockIndex) => {
      if (block.type === 'unknown') {
        report.error(
          'unknown_block',
          `Block type "${block.original_type}" is not recognised; it cannot be published.`,
          ['sections', sectionIndex, 'blocks', blockIndex],
        );
      }
    });
  });
}

function lintQuestions(questions: Record<string, Question>, report: Report): void {
  for (const [id, question] of Object.entries(questions)) {
    const path = ['questions', id];
    if (isDeterministic(question)) {
      const answer: unknown = (question as { answer?: unknown }).answer;
      if (typeof answer !== 'object' || answer === null) {
        report.error(
          'answer_spec_missing',
          `Question "${id}" (${question.kind}) has no answer spec, so it cannot be graded offline.`,
          [...path, 'answer'],
        );
        continue;
      }
      for (const problem of answerProblems(question)) {
        report.error('answer_spec_invalid', `Question "${id}": ${problem.message}.`, [
          ...path,
          ...problem.path,
        ]);
      }
    } else if (question.kind === 'free_text' || question.kind === 'spoken') {
      const rubric: unknown = question.rubric;
      if (typeof rubric !== 'object' || rubric === null) {
        report.error('rubric_missing', `Question "${id}" (${question.kind}) has no rubric.`, [
          ...path,
          'rubric',
        ]);
      }
    }
  }
}

function lintRequiredSections(sections: readonly Section[], report: Report): void {
  const present = new Set<string>(sections.map((section) => section.type));
  for (const type of ALWAYS_PRESENT_TYPES) {
    if (!present.has(type)) {
      report.error('missing_section', `Required section "${type}" is missing.`);
    }
  }
}

function lintEnrichment(sections: readonly Section[], report: Report): void {
  const enrichment = sections.filter((section) => isEnrichmentType(section.type));
  if (enrichment.length < ENRICHMENT_MIN || enrichment.length > ENRICHMENT_MAX) {
    report.error(
      'enrichment_count',
      `A lesson uses ${ENRICHMENT_MIN} to ${ENRICHMENT_MAX} enrichment sections from the menu (${ENRICHMENT_MENU.join(', ')}); found ${enrichment.length}.`,
    );
  }
  const seen = new Set<string>();
  for (const section of enrichment) {
    if (seen.has(section.type)) {
      report.error(
        'enrichment_duplicate',
        `Enrichment section type "${section.type}" is used more than once.`,
      );
    }
    seen.add(section.type);
  }
}

function lintWorkbook(workbook: Workbook | undefined, report: Report): void {
  if (!workbook) {
    report.error('workbook_missing', 'The unit has no workbook.', ['workbook']);
    return;
  }
  const tiers = workbook.tiers ?? [];
  const tierNumbers = new Set(tiers.map((tier) => tier.tier));
  if (tiers.length !== 3 || ![1, 2, 3].every((n) => tierNumbers.has(n as 1 | 2 | 3))) {
    report.error(
      'workbook_tiers',
      `The workbook needs exactly three tiers (1, 2 and 3); found ${tiers.length}.`,
      ['workbook', 'tiers'],
    );
  }
  tiers.forEach((tier, index) => {
    if (tier.question_ids.length === 0) {
      report.error('workbook_tiers', `Workbook tier ${tier.tier} has no questions.`, [
        'workbook',
        'tiers',
        index,
      ]);
    }
  });
  const task: unknown = workbook.application_task_id;
  if (typeof task !== 'string' || task === '') {
    report.error('workbook_application_task', 'The workbook has no application task.', [
      'workbook',
      'application_task_id',
    ]);
  }
  const drill = workbook.quick_answer_drill;
  if (!drill || drill.question_ids.length === 0) {
    report.error('workbook_drill', 'The workbook has no quick-answer drill.', [
      'workbook',
      'quick_answer_drill',
    ]);
  }
}

function lintTeacherManual(manual: TeacherManual | undefined, report: Report): void {
  if (!manual) {
    report.error('teacher_manual_missing', "The unit has no teacher's manual entry.", [
      'teacher_manual',
    ]);
    return;
  }
  if ((manual.script ?? []).length === 0) {
    report.error('teacher_manual_script', "The teacher's manual has no script.", [
      'teacher_manual',
      'script',
    ]);
  }
  if ((manual.materials ?? []).length === 0) {
    report.error('teacher_manual_materials', "The teacher's manual lists no materials.", [
      'teacher_manual',
      'materials',
    ]);
  }
  const guidance = manual.mastery_guidance as TeacherManual['mastery_guidance'] | undefined;
  if (
    !guidance ||
    (guidance.got_it ?? []).length === 0 ||
    typeof guidance.not_yet !== 'string' ||
    guidance.not_yet.trim() === ''
  ) {
    report.error(
      'teacher_manual_mastery',
      "The teacher's manual needs mastery guidance: what 'got it' looks like and what to do if not yet.",
      ['teacher_manual', 'mastery_guidance'],
    );
  }
  if ((manual.helper_script ?? []).length === 0) {
    report.warn('helper_script_empty', 'There is no helper script for pre-readers.', [
      'teacher_manual',
      'helper_script',
    ]);
  }
}

function lintMasteryCheck(
  sections: readonly Section[],
  questions: Record<string, Question>,
  report: Report,
): void {
  const mastery = sections.filter((section) => section.type === 'mastery_check');
  if (mastery.length === 0) return; // reported as missing_section
  const hasGradable = mastery.some((section) =>
    section.blocks.some((block) => {
      if (block.type !== 'question') return false;
      const question = questions[block.question_id];
      return (
        question !== undefined && isDeterministic(question) && answerProblems(question).length === 0
      );
    }),
  );
  if (!hasGradable) {
    report.error(
      'mastery_no_gradable',
      'The mastery check needs at least one question that can be graded deterministically; only graded items grant mastery.',
    );
  }
}

function lintThinkDeeper(
  sections: readonly Section[],
  questions: Record<string, Question>,
  stage: Stage,
  report: Report,
): void {
  const target = stageIndex(stage);
  sections.forEach((section, sectionIndex) => {
    if (section.type !== 'think_deeper') return;
    const prompts = thinkDeeperPrompts(section, questions);
    if (prompts.length === 0) {
      report.warn('think_deeper_no_prompts', 'Think Deeper has no prompts to check.', [
        'sections',
        sectionIndex,
      ]);
      return;
    }
    let matchesTarget = false;
    for (const prompt of prompts) {
      const rung = reasoningRungOf(prompt);
      if (rung === null) continue;
      if (stageIndex(rung) === target) matchesTarget = true;
      if (stageIndex(rung) > target) {
        report.warn(
          'think_deeper_too_hard',
          `Think Deeper prompt "${prompt}" reads like the "${rung}" rung, above the unit's "${stage}" stage.`,
          ['sections', sectionIndex],
        );
      }
    }
    if (!matchesTarget) {
      report.warn(
        'think_deeper_rung',
        `No Think Deeper prompt matches the "${stage}" reasoning rung (see brief section 9).`,
        ['sections', sectionIndex],
      );
    }
  });
}

function lintRotation(sections: readonly Section[], context: LintContext, report: Report): void {
  const previous = context.previousEnrichment;
  if (!previous || previous.length === 0) return;
  const current = new Set(sections.filter((s) => isEnrichmentType(s.type)).map((s) => s.type));
  const before = new Set(previous);
  if (current.size === before.size && [...current].every((type) => before.has(type))) {
    report.warn(
      'enrichment_not_rotated',
      `The enrichment sections (${[...current].join(', ')}) are the same as the previous unit; vary the rotation.`,
    );
  }
}

function lintSessionPlan(unit: UnitContent, report: Report): void {
  if (unit.kind !== 'lesson') return;
  unit.session_plan.forEach((period, index) => {
    const total = period.minutes.reduce((sum, entry) => sum + entry.minutes, 0);
    if (total < SESSION_MINUTES_MIN || total > SESSION_MINUTES_MAX) {
      report.warn(
        'session_minutes',
        `Period ${period.period} totals ${total} minutes; a lesson period should run ${SESSION_MINUTES_MIN} to ${SESSION_MINUTES_MAX}.`,
        ['session_plan', index],
      );
    }
  });
}

function lintReadingLevel(sections: readonly Section[], stage: Stage, report: Report): void {
  if (stage === 'express') return;
  sections.forEach((section, index) => {
    const average = averageSentenceLength(section.blocks);
    if (average !== null && average > MAX_AVERAGE_SENTENCE_WORDS) {
      report.warn(
        'reading_level',
        `Section "${section.id}" averages ${average.toFixed(1)} words per sentence; keep ${stage}-stage text to ${MAX_AVERAGE_SENTENCE_WORDS} or fewer.`,
        ['sections', index],
      );
    }
  });
}

function lintLayers(sections: readonly Section[], report: Report): void {
  sections.forEach((section, index) => {
    const expected = LAYER_FOR_TYPE[section.type];
    if (section.layer !== expected) {
      report.warn(
        'layer_mismatch',
        `Section "${section.id}" is a ${section.type} and is normally ${expected}, but is tagged ${section.layer}.`,
        ['sections', index, 'layer'],
      );
    }
  });
}

function lintReligiousTerms(unit: UnitContent, report: Report): void {
  const found: { path: PathSegment[]; text: string }[] = [];
  collectStrings(unit, [], found);
  for (const { path, text } of found) {
    const hits = new Set<string>();
    for (const match of text.matchAll(RELIGIOUS_TERM_PATTERN)) {
      hits.add(match[0].toLowerCase());
    }
    if (hits.size > 0) {
      report.warn(
        'religious_term',
        `Found "${[...hits].join('", "')}"; check that the content stays religiously neutral and inclusive.`,
        path,
      );
    }
  }
}

/**
 * Lints a unit. Lessons get the full rule set; other kinds get the structural rules (objective,
 * references, answer specs, unknown blocks) plus the advisory text checks.
 */
export function lintUnit(unit: UnitContent, context: LintContext = {}): LintReport {
  const report = new Report();
  const sections = sectionsOf(unit);
  const questions = questionsOf(unit);
  const stage = unit.header.stage_to ?? unit.header.stage;

  lintObjective(unit, report);
  lintRefs(unit, report);
  lintBlocks(sections, report);
  lintQuestions(questions, report);

  if (unit.kind === 'lesson') {
    lintRequiredSections(sections, report);
    lintEnrichment(sections, report);
    lintWorkbook(unit.workbook as Workbook | undefined, report);
    lintTeacherManual(unit.teacher_manual as TeacherManual | undefined, report);
    lintMasteryCheck(sections, questions, report);

    lintThinkDeeper(sections, questions, stage, report);
    lintRotation(sections, context, report);
    if (!sections.some((section) => section.type === 'window_to_world')) {
      report.warn(
        'no_global_window',
        'There is no Window to the World section, so the unit has a Nigerian anchor but no global window.',
      );
    }
    lintSessionPlan(unit, report);
  }

  lintReadingLevel(sections, unit.header.stage, report);
  lintLayers(sections, report);
  lintReligiousTerms(unit, report);
  return report.done();
}

// ---------------------------------------------------------------------------------------------
// Stable ids across versions
// ---------------------------------------------------------------------------------------------

/**
 * The stable-ID rule: section ids and question ids are assigned once and never dropped or regenerated.
 * Returns an error for every id of `previous` that is missing from `next`. New ids are fine.
 */
export function lintVersionIds(previous: UnitContent, next: UnitContent): LintReport {
  const report = new Report();
  const nextSections = new Set(sectionsOf(next).map((section) => section.id));
  const nextQuestions = new Set(Object.keys(questionsOf(next)));
  sectionsOf(previous).forEach((section) => {
    if (!nextSections.has(section.id)) {
      report.error(
        'section_id_dropped',
        `Section id "${section.id}" from the previous version is missing; ids must stay stable.`,
        ['sections', section.id],
      );
    }
  });
  for (const id of Object.keys(questionsOf(previous))) {
    if (!nextQuestions.has(id)) {
      report.error(
        'question_id_dropped',
        `Question id "${id}" from the previous version is missing; ids must stay stable.`,
        ['questions', id],
      );
    }
  }
  return report.done();
}
