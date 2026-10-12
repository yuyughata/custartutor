import type { LessonUnit, Section, SessionSegment, TeacherManual } from '@custar/content-schema';

/**
 * Picks the helper's material out of the unit and the teacher's manual. Pure, so it is tested without a screen.
 * The manual comes from the GROWN-UP pack (ADR 0004); the sections and the session plan from the learner pack.
 */

export interface SectionHelp {
  sectionId: string;
  /** The helper's numbered steps for this section (`helper_script`); empty when none are scripted. */
  steps: string[];
  /** The teacher's say / ask / watch-for lines for this section (`script`), or null for each that is absent. */
  say: string | null;
  ask: string | null;
  watchFor: string | null;
}

/** What the helper needs for one section. Nothing scripted gives empty steps and nulls, never an error. */
export function helpForSection(manual: TeacherManual, sectionId: string): SectionHelp {
  const steps = manual.helper_script
    .filter((entry) => entry.section_id === sectionId)
    .flatMap((entry) => entry.steps);
  const line = manual.script.find((entry) => entry.section_id === sectionId);
  return {
    sectionId,
    steps,
    say: line?.say ?? null,
    ask: line?.ask ?? null,
    watchFor: line?.watch_for ?? null,
  };
}

/** True when the helper has anything at all for this section. */
export function hasHelp(help: SectionHelp): boolean {
  return help.steps.length > 0 || help.say !== null || help.ask !== null || help.watchFor !== null;
}

const SEGMENT_LABEL: Record<SessionSegment, string> = {
  start: 'Start',
  teach: 'Teach',
  move_and_do: 'Move and do',
  practice: 'Practice',
  close: 'Close',
};

export interface PeriodPlan {
  period: number;
  /** For example "Start 10 min · Teach 15 min". */
  timing: string;
  totalMinutes: number;
  sectionIds: string[];
  sectionHeadings: string[];
}

export interface GetReady {
  materials: string[];
  /** The manual's own timing note. */
  timing: string;
  periods: PeriodPlan[];
}

/** The "get ready" page: materials to gather, the manual's timing note and the timetable of the periods. */
export function getReady(unit: LessonUnit, manual: TeacherManual): GetReady {
  const headingOf = new Map(unit.sections.map((section) => [section.id, section.heading]));
  return {
    materials: [...manual.materials],
    timing: manual.timing,
    periods: unit.session_plan.map((period) => ({
      period: period.period,
      timing: period.minutes
        .map((entry) => `${SEGMENT_LABEL[entry.segment]} ${entry.minutes} min`)
        .join(' · '),
      totalMinutes: period.minutes.reduce((sum, entry) => sum + entry.minutes, 0),
      sectionIds: [...period.sections],
      sectionHeadings: period.sections.map((id) => headingOf.get(id) ?? id),
    })),
  };
}

/** Which period of the timetable a section is taught in (1-based), or null if the plan leaves it out. */
export function periodOfSection(unit: LessonUnit, sectionId: string): number | null {
  return unit.session_plan.find((period) => period.sections.includes(sectionId))?.period ?? null;
}

/** The mastery-check sections of a unit (usually one, the last). */
export function masterySections(unit: LessonUnit): Section[] {
  return unit.sections.filter((section) => section.type === 'mastery_check');
}

/** Where "Try again" returns to after a "Not yet": the first mastery-check section, else the last one. */
export function retryIndex(unit: LessonUnit): number {
  const first = unit.sections.findIndex((section) => section.type === 'mastery_check');
  return first >= 0 ? first : Math.max(0, unit.sections.length - 1);
}
