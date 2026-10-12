// chapter_plan: `group` (no model call: groupIntoChapters decides which weeks form which chapter) then `title`
// (one call: titles, drafted objectives, stage and an optional theme). The structure is fixed by code: any reply
// that moves, adds, drops or reorders a week is rejected (one repair retry, then a schema error). unit_no is the
// 1-based ordinal of the unit over the TERM.
import {
  groupIntoChapters,
  type ChapterGrouping,
  type Stage,
  type LevelCode,
} from '@custar/content-schema';
import {
  StepError,
  type ChapterPlanInput,
  type ChapterPlanResult,
  type Flag,
  type JobState,
  type PlannedChapter,
  type PlannedUnit,
  type StepDeps,
  type StepOutcome,
} from '../contract';
import { ChapterTitlesOutput, type ChapterTitlesOutput as Titles } from '../prompts/schemas';
import { titleMessages } from '../prompts/steps';
import { buildSystem } from '../prompts/system';
import { callModel } from './call';
import { normaliseStage } from './levels';
import { clean, toJson, toSlug } from './util';

export const PLAN_STEPS = ['group', 'title'] as const;

export function runGroup(input: ChapterPlanInput): StepOutcome<'chapter_plan'> {
  const grouping = groupIntoChapters(input.scheme, { min: 3, max: 5 });
  if (grouping.chapters.length === 0) {
    throw new StepError('group', 'invalid_input', 'The scheme has no teaching weeks, so there is nothing to plan.');
  }
  return { output: toJson(grouping), usage: [] };
}

function readGrouping(state: JobState): ChapterGrouping | null {
  const raw = state.outputs['group'] as Partial<ChapterGrouping> | undefined;
  if (!raw || !Array.isArray(raw.chapters)) return null;
  return raw as ChapterGrouping;
}

/** Checks the model's reply against the fixed structure. Returns problems; empty means the structure is intact. */
export function validateTitles(grouping: ChapterGrouping, titles: Titles): string[] {
  const problems: string[] = [];
  if (titles.chapters.length !== grouping.chapters.length) {
    problems.push(`expected ${grouping.chapters.length} chapter(s), got ${titles.chapters.length}`);
  }
  grouping.chapters.forEach((chapter, index) => {
    const reply = titles.chapters[index];
    if (!reply) return;
    if (reply.chapter_no !== chapter.chapter_no) {
      problems.push(`chapters[${index}].chapter_no must be ${chapter.chapter_no} (got ${reply.chapter_no})`);
    }
    const weeks = reply.units.map((unit) => unit.week_no);
    if (weeks.length !== chapter.week_nos.length || weeks.some((week, i) => week !== chapter.week_nos[i])) {
      problems.push(
        `chapter ${chapter.chapter_no} must hold exactly weeks [${chapter.week_nos.join(', ')}] in that order (got [${weeks.join(', ')}]); never move, add, drop or reorder a week`,
      );
    }
    if (clean(reply.title) === '') problems.push(`chapters[${index}].title is empty`);
    reply.units.forEach((unit, unitIndex) => {
      if (clean(unit.title) === '') problems.push(`chapters[${index}].units[${unitIndex}].title is empty`);
    });
  });
  return problems;
}

/** How many one-hour periods a week's topic needs: by the size of its breakdown. */
export function periodsFor(subtopicCount: number): number {
  if (subtopicCount <= 2) return 1;
  if (subtopicCount <= 6) return 2;
  return 3;
}

export async function runTitle(
  input: ChapterPlanInput,
  state: JobState,
  deps: StepDeps,
): Promise<StepOutcome<'chapter_plan'>> {
  const grouping = readGrouping(state);
  if (!grouping) throw new StepError('title', 'internal', 'The group step has no output yet.', { retryable: false });

  const { value, usage } = await callModel(deps, {
    step: 'title',
    family: 'chapter_plan:title',
    label: 'chapter_plan:title',
    schemaName: 'chapter_titles',
    schema: ChapterTitlesOutput,
    system: buildSystem('plan', input.cast),
    messages: titleMessages(input, grouping),
    check: (reply) => validateTitles(grouping, reply),
  });

  const result = buildPlan(input, grouping, value);
  return { output: toJson({ chapters: result.plan.chapters.length, flags: result.flags.length }), usage, result };
}

/** Builds the plan from the fixed structure and the model's words. Assumes `validateTitles` passed. */
export function buildPlan(input: ChapterPlanInput, grouping: ChapterGrouping, titles: Titles): ChapterPlanResult {
  const flags: Flag[] = [];
  const level = input.scheme.level_code as LevelCode;
  const teaching = input.scheme.weeks
    .filter((week) => week.kind === 'teaching')
    .sort((a, b) => a.week_no - b.week_no);
  const unitNoByWeek = new Map(teaching.map((week, index) => [week.week_no, index + 1]));
  const weekByNo = new Map(input.scheme.weeks.map((week) => [week.week_no, week]));

  for (const warning of grouping.warnings) flags.push({ code: 'grouping', severity: 'concern', message: warning });

  const chapters: PlannedChapter[] = grouping.chapters.map((chapter, index) => {
    const reply = titles.chapters[index]!;
    const units: PlannedUnit[] = chapter.week_nos.map((weekNo, unitIndex) => {
      const week = weekByNo.get(weekNo)!;
      const replyUnit = reply.units[unitIndex]!;
      let objective = clean(replyUnit.objective);
      if (objective === '') {
        objective = [week.topic, ...week.subtopics].join('; ');
        flags.push({
          code: 'objective_fallback',
          severity: 'note',
          message: `Week ${weekNo}: the model gave no objective, so the topic and subtopics were joined. Edit it.`,
          week_no: weekNo,
        });
      }
      const stage = normaliseStage(level, replyUnit.stage as Stage, replyUnit.stage_to);
      if (stage.note) {
        flags.push({ code: 'stage', severity: 'note', message: `Week ${weekNo}: ${stage.note}.`, week_no: weekNo });
      }
      return {
        unit_no: unitNoByWeek.get(weekNo)!,
        week_no: weekNo,
        kind: 'lesson',
        title: clean(replyUnit.title) || week.topic,
        objective,
        stage: stage.stage,
        ...(stage.stage_to ? { stage_to: stage.stage_to } : {}),
        periods: periodsFor(week.subtopics.length),
      };
    });

    if (units.length < 3) {
      flags.push({
        code: 'chapter_size',
        severity: 'concern',
        message: `Chapter ${chapter.chapter_no} has ${units.length} unit(s); a chapter needs 3 to 5 units to be published. The term is too short to fill it; merge it by hand or add units.`,
      });
    } else if (units.length > 5) {
      flags.push({
        code: 'chapter_size',
        severity: 'concern',
        message: `Chapter ${chapter.chapter_no} has ${units.length} units; a chapter may hold at most 5.`,
      });
    }

    const slug = toSlug(reply.theme_slug) || toSlug(reply.theme_title);
    const themeTitle = clean(reply.theme_title);
    const themeLens = clean(reply.theme_lens);
    const theme = slug !== '' && themeTitle !== '' && themeLens !== '' ? { slug, title: themeTitle, lens: themeLens } : undefined;
    return {
      chapter_no: chapter.chapter_no,
      title: clean(reply.title) || `Chapter ${chapter.chapter_no}`,
      ...(theme ? { theme } : {}),
      units,
    };
  });

  return { plan: { chapters }, flags };
}
