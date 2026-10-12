// Pure helpers for editing the weeks table of a scheme draft: add, remove and edit rows, validate, normalise
// for saving and detect unsaved changes. No React and no I/O, so it is unit tested.
import { WEEK_KINDS, type SchemeWeek, type WeekKind } from '@custar/content-schema';

export const WEEK_MIN = 1;
/** The database allows weeks 1 to 20. */
export const WEEK_MAX = 20;
/** A unit's `week_no` stops at 15 (UnitContent.header), so a teaching week beyond that cannot become a unit. */
export const UNIT_WEEK_MAX = 15;

export const WEEK_KIND_LABELS: Record<WeekKind, string> = {
  teaching: 'Teaching',
  mid_term_exam: 'Mid-term exam',
  break: 'Break',
  revision: 'Revision',
  exam: 'Exam',
  closing: 'Closing',
};

export function weekKindLabel(kind: string): string {
  return WEEK_KIND_LABELS[kind as WeekKind] ?? kind;
}

export function isWeekKind(value: string): value is WeekKind {
  return (WEEK_KINDS as readonly string[]).includes(value);
}

export interface WeekIssue {
  severity: 'error' | 'warning';
  /** Row index in the table, or -1 when the issue is about the whole scheme. */
  index: number;
  field: 'week_no' | 'kind' | 'topic' | 'subtopics' | 'scheme';
  message: string;
}

/** The smallest week number not yet used (so "Add week" fills gaps), capped at WEEK_MAX. */
export function nextWeekNo(weeks: readonly SchemeWeek[]): number {
  const used = new Set(weeks.map((week) => week.week_no));
  for (let candidate = WEEK_MIN; candidate <= WEEK_MAX; candidate += 1) {
    if (!used.has(candidate)) return candidate;
  }
  return WEEK_MAX;
}

export function addWeek(weeks: readonly SchemeWeek[]): SchemeWeek[] {
  return [...weeks, { week_no: nextWeekNo(weeks), kind: 'teaching', topic: '', subtopics: [] }];
}

export function removeWeek(weeks: readonly SchemeWeek[], index: number): SchemeWeek[] {
  return weeks.filter((_, position) => position !== index);
}

export function updateWeek(
  weeks: readonly SchemeWeek[],
  index: number,
  patch: Partial<SchemeWeek>,
): SchemeWeek[] {
  return weeks.map((week, position) => (position === index ? { ...week, ...patch } : week));
}

/** Subtopics are edited as one line each. Blank lines are kept while typing and dropped by `normalizeWeeks`. */
export function subtopicsToText(subtopics: readonly string[]): string {
  return subtopics.join('\n');
}

export function textToSubtopics(text: string): string[] {
  return text === '' ? [] : text.split('\n');
}

/** Trim text, drop blank subtopics and sort by week number. This is what gets saved. */
export function normalizeWeeks(weeks: readonly SchemeWeek[]): SchemeWeek[] {
  return weeks
    .map((week) => ({
      week_no: week.week_no,
      kind: week.kind,
      topic: week.topic.trim(),
      subtopics: week.subtopics.map((line) => line.trim()).filter((line) => line !== ''),
    }))
    .sort((a, b) => a.week_no - b.week_no);
}

export function weeksEqual(a: readonly SchemeWeek[], b: readonly SchemeWeek[]): boolean {
  return JSON.stringify(normalizeWeeks(a)) === JSON.stringify(normalizeWeeks(b));
}

export function validateWeeks(weeks: readonly SchemeWeek[]): WeekIssue[] {
  const issues: WeekIssue[] = [];
  if (weeks.length === 0) {
    issues.push({
      severity: 'error',
      index: -1,
      field: 'scheme',
      message: 'Add at least one week.',
    });
    return issues;
  }
  const seen = new Map<number, number>();
  weeks.forEach((week, index) => {
    if (!Number.isInteger(week.week_no) || week.week_no < WEEK_MIN || week.week_no > WEEK_MAX) {
      issues.push({
        severity: 'error',
        index,
        field: 'week_no',
        message: `Week number must be a whole number from ${WEEK_MIN} to ${WEEK_MAX}.`,
      });
    } else if (seen.has(week.week_no)) {
      issues.push({
        severity: 'error',
        index,
        field: 'week_no',
        message: `Week ${week.week_no} appears twice.`,
      });
    } else {
      seen.set(week.week_no, index);
    }
    if (!isWeekKind(week.kind)) {
      issues.push({ severity: 'error', index, field: 'kind', message: 'Pick a kind of week.' });
    }
    if (week.topic.trim() === '') {
      issues.push({ severity: 'error', index, field: 'topic', message: 'The topic is empty.' });
    }
    if (week.kind === 'teaching') {
      if (week.week_no > UNIT_WEEK_MAX) {
        issues.push({
          severity: 'warning',
          index,
          field: 'week_no',
          message: `Teaching weeks after week ${UNIT_WEEK_MAX} cannot become units.`,
        });
      }
      if (week.subtopics.every((line) => line.trim() === '')) {
        issues.push({
          severity: 'warning',
          index,
          field: 'subtopics',
          message: 'No subtopics. The unit would be drafted from the topic alone.',
        });
      }
    }
    const blank = week.subtopics.filter((line) => line.trim() === '').length;
    if (blank > 0 && blank < week.subtopics.length) {
      issues.push({
        severity: 'warning',
        index,
        field: 'subtopics',
        message: 'Blank subtopic lines are removed when you save.',
      });
    }
  });
  if (!weeks.some((week) => week.kind === 'teaching')) {
    issues.push({
      severity: 'error',
      index: -1,
      field: 'scheme',
      message: 'A scheme needs at least one teaching week before it can be approved.',
    });
  }
  return issues;
}

export function hasErrors(issues: readonly WeekIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

export function issuesForRow(issues: readonly WeekIssue[], index: number): WeekIssue[] {
  return issues.filter((issue) => issue.index === index);
}

export function countByKind(weeks: readonly SchemeWeek[]): { teaching: number; other: number } {
  const teaching = weeks.filter((week) => week.kind === 'teaching').length;
  return { teaching, other: weeks.length - teaching };
}
