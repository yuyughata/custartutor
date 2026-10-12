// Pure helpers for the chapter planner: edit a ChapterPlan, move a unit to a neighbouring chapter, and validate
// live. A chapter must keep 3 to 5 units (the validator of publish_unit_version and apply_chapter_plan enforce
// the same bound). No React and no I/O.
import type { ChapterPlan, PlannedChapter, PlannedUnit } from '@custar/authoring-core';
import { STAGE_ORDER, type Scheme, type Stage } from '@custar/content-schema';

export const PLAN_MIN_UNITS = 3;
export const PLAN_MAX_UNITS = 5;
export const PERIODS_MIN = 1;
export const PERIODS_MAX = 10;

export type MoveDirection = 'previous' | 'next';

export interface PlanIssue {
  severity: 'error' | 'warning';
  /** Index of the chapter in `plan.chapters`; absent for a plan-wide issue. */
  chapter?: number;
  /** Index of the unit inside that chapter. */
  unit?: number;
  message: string;
}

function violation(count: number): number {
  return Math.max(0, PLAN_MIN_UNITS - count) + Math.max(0, count - PLAN_MAX_UNITS);
}

export function unitCount(plan: ChapterPlan): number {
  return plan.chapters.reduce((total, chapter) => total + chapter.units.length, 0);
}

function mapChapter(
  plan: ChapterPlan,
  index: number,
  fn: (chapter: PlannedChapter) => PlannedChapter,
): ChapterPlan {
  return {
    chapters: plan.chapters.map((chapter, position) =>
      position === index ? fn(chapter) : chapter,
    ),
  };
}

export function renameChapter(plan: ChapterPlan, chapter: number, title: string): ChapterPlan {
  return mapChapter(plan, chapter, (entry) => ({ ...entry, title }));
}

export function updateUnit(
  plan: ChapterPlan,
  chapter: number,
  unit: number,
  patch: Partial<PlannedUnit>,
): ChapterPlan {
  return mapChapter(plan, chapter, (entry) => ({
    ...entry,
    units: entry.units.map((candidate, position) =>
      position === unit ? withStageRange({ ...candidate, ...patch }) : candidate,
    ),
  }));
}

/** A unit that ends at the stage it starts at (or has no end stage chosen) carries no `stage_to`. */
function withStageRange(unit: PlannedUnit): PlannedUnit {
  if ('stage_to' in unit && (unit.stage_to === undefined || unit.stage_to === unit.stage)) {
    const { stage_to: _unused, ...rest } = unit;
    return rest;
  }
  return unit;
}

export function slugify(title: string): string {
  const slug = title
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return /^[a-z]/.test(slug) ? slug : slug === '' ? 'theme' : `t-${slug}`;
}

export function setTheme(
  plan: ChapterPlan,
  chapter: number,
  theme: { title: string; lens: string } | null,
): ChapterPlan {
  return mapChapter(plan, chapter, (entry) => {
    const { theme: _old, ...rest } = entry;
    return theme === null
      ? rest
      : { ...rest, theme: { slug: slugify(theme.title), title: theme.title, lens: theme.lens } };
  });
}

/** Whether a unit may move to the neighbouring chapter, and why not. Only boundary units can move, so unit order never changes. */
export function canMoveUnit(
  plan: ChapterPlan,
  chapter: number,
  unit: number,
  direction: MoveDirection,
): { ok: boolean; reason?: string } {
  const source = plan.chapters[chapter];
  const targetIndex = direction === 'previous' ? chapter - 1 : chapter + 1;
  const target = plan.chapters[targetIndex];
  if (!source || !source.units[unit]) return { ok: false, reason: 'No such unit.' };
  if (!target) {
    return {
      ok: false,
      reason: direction === 'previous' ? 'This is the first chapter.' : 'This is the last chapter.',
    };
  }
  const isBoundary = direction === 'previous' ? unit === 0 : unit === source.units.length - 1;
  if (!isBoundary) {
    return {
      ok: false,
      reason: `Only the ${direction === 'previous' ? 'first' : 'last'} unit of a chapter can move ${direction === 'previous' ? 'back' : 'forward'}, so the units stay in order.`,
    };
  }
  const before = violation(source.units.length) + violation(target.units.length);
  const after = violation(source.units.length - 1) + violation(target.units.length + 1);
  if (after > before) {
    const sourceAfter = source.units.length - 1;
    const targetAfter = target.units.length + 1;
    const problem =
      violation(sourceAfter) > violation(source.units.length)
        ? `chapter ${source.chapter_no} would have ${sourceAfter} unit${sourceAfter === 1 ? '' : 's'}`
        : `chapter ${target.chapter_no} would have ${targetAfter} units`;
    return {
      ok: false,
      reason: `Not allowed: ${problem} (${PLAN_MIN_UNITS} to ${PLAN_MAX_UNITS} needed).`,
    };
  }
  return { ok: true };
}

export function moveUnit(
  plan: ChapterPlan,
  chapter: number,
  unit: number,
  direction: MoveDirection,
): ChapterPlan {
  if (!canMoveUnit(plan, chapter, unit, direction).ok) return plan;
  const targetIndex = direction === 'previous' ? chapter - 1 : chapter + 1;
  const moved = plan.chapters[chapter]?.units[unit] as PlannedUnit;
  return {
    chapters: plan.chapters.map((entry, position) => {
      if (position === chapter) {
        return { ...entry, units: entry.units.filter((_, at) => at !== unit) };
      }
      if (position === targetIndex) {
        return {
          ...entry,
          units: direction === 'previous' ? [...entry.units, moved] : [moved, ...entry.units],
        };
      }
      return entry;
    }),
  };
}

function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}

/** Live validation. `scheme` is optional; with it the plan is also checked for teaching weeks without a unit. */
export function validatePlan(plan: ChapterPlan, scheme?: Scheme | null): PlanIssue[] {
  const issues: PlanIssue[] = [];
  if (plan.chapters.length === 0) {
    issues.push({ severity: 'error', message: 'The plan has no chapters.' });
    return issues;
  }
  let previousUnitNo = 0;
  const weekUsed = new Map<number, number>();
  plan.chapters.forEach((chapter, chapterIndex) => {
    const label = `Chapter ${chapter.chapter_no}`;
    const count = chapter.units.length;
    if (count < PLAN_MIN_UNITS || count > PLAN_MAX_UNITS) {
      issues.push({
        severity: 'error',
        chapter: chapterIndex,
        message: `${label} has ${count} unit${count === 1 ? '' : 's'}; it needs ${PLAN_MIN_UNITS} to ${PLAN_MAX_UNITS}.`,
      });
    }
    if (chapter.title.trim() === '') {
      issues.push({
        severity: 'error',
        chapter: chapterIndex,
        message: `${label} needs a title.`,
      });
    }
    if (chapter.theme && (chapter.theme.title.trim() === '' || chapter.theme.lens.trim() === '')) {
      issues.push({
        severity: 'error',
        chapter: chapterIndex,
        message: `${label}: a theme needs a title and a lens (or remove the theme).`,
      });
    }
    chapter.units.forEach((unit, unitIndex) => {
      const where = `${label}, unit ${unit.unit_no}`;
      if (unit.title.trim() === '') {
        issues.push({
          severity: 'error',
          chapter: chapterIndex,
          unit: unitIndex,
          message: `${where} needs a title.`,
        });
      }
      if (unit.objective.trim() === '') {
        issues.push({
          severity: 'error',
          chapter: chapterIndex,
          unit: unitIndex,
          message: `${where} needs an objective (the NERDC objective for the week).`,
        });
      }
      if (unit.stage_to !== undefined && stageIndex(unit.stage_to) < stageIndex(unit.stage)) {
        issues.push({
          severity: 'error',
          chapter: chapterIndex,
          unit: unitIndex,
          message: `${where}: the end stage cannot be earlier than the start stage.`,
        });
      }
      if (
        !Number.isInteger(unit.periods) ||
        unit.periods < PERIODS_MIN ||
        unit.periods > PERIODS_MAX
      ) {
        issues.push({
          severity: 'error',
          chapter: chapterIndex,
          unit: unitIndex,
          message: `${where}: periods must be ${PERIODS_MIN} to ${PERIODS_MAX}.`,
        });
      }
      if (unit.unit_no <= previousUnitNo) {
        issues.push({
          severity: 'error',
          chapter: chapterIndex,
          unit: unitIndex,
          message: `${where} is out of order (unit numbers must increase through the term).`,
        });
      }
      previousUnitNo = unit.unit_no;
      weekUsed.set(unit.week_no, (weekUsed.get(unit.week_no) ?? 0) + 1);
    });
  });
  for (const [week, times] of weekUsed) {
    if (times > 1) {
      issues.push({
        severity: 'warning',
        message: `Week ${week} has ${times} units. Check that this is intended.`,
      });
    }
  }
  if (scheme) {
    const teaching = scheme.weeks.filter((week) => week.kind === 'teaching');
    for (const week of teaching) {
      if (!weekUsed.has(week.week_no)) {
        issues.push({
          severity: 'warning',
          message: `Teaching week ${week.week_no} (${week.topic}) has no unit in this plan.`,
        });
      }
    }
    const teachingNumbers = new Set(teaching.map((week) => week.week_no));
    for (const week of weekUsed.keys()) {
      if (!teachingNumbers.has(week)) {
        issues.push({
          severity: 'warning',
          message: `A unit is planned for week ${week}, which is not a teaching week in the scheme.`,
        });
      }
    }
  }
  return issues;
}

export function hasPlanErrors(issues: readonly PlanIssue[]): boolean {
  return issues.some((issue) => issue.severity === 'error');
}

/** Trim text and renumber chapters 1..n. This is what gets sent to apply_chapter_plan. */
export function normalizePlan(plan: ChapterPlan): ChapterPlan {
  return {
    chapters: plan.chapters.map((chapter, index) => ({
      ...chapter,
      chapter_no: index + 1,
      title: chapter.title.trim(),
      ...(chapter.theme
        ? {
            theme: {
              slug: chapter.theme.slug,
              title: chapter.theme.title.trim(),
              lens: chapter.theme.lens.trim(),
            },
          }
        : {}),
      units: chapter.units.map((unit) => ({
        ...unit,
        title: unit.title.trim(),
        objective: unit.objective.trim(),
      })),
    })),
  };
}

export function plansEqual(a: ChapterPlan, b: ChapterPlan): boolean {
  return JSON.stringify(normalizePlan(a)) === JSON.stringify(normalizePlan(b));
}

export function issuesForChapter(
  issues: readonly PlanIssue[],
  chapter: number,
  unit?: number,
): PlanIssue[] {
  return issues.filter(
    (issue) =>
      issue.chapter === chapter &&
      (unit === undefined ? issue.unit === undefined : issue.unit === unit),
  );
}
