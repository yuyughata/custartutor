import { joinUnitFromPacks } from '@custar/content-schema';
import type { GrownupPackContent, LessonUnit } from '@custar/content-schema';
import type { LoadedLesson } from '@custar/learner-core';

/** Where the loaders come from, so the decision below is tested without a database. */
export interface HelperLessonSources {
  /** The learner pack of the active version (throws when nothing is downloaded or the pack is damaged). */
  loadLesson(): Promise<LoadedLesson>;
  /** The grown-up pack of the active version, or null when only the learner pack is on the phone. */
  loadGrownup(): Promise<GrownupPackContent | null>;
}

export type HelperLessonResult =
  | {
      status: 'ready';
      lesson: LoadedLesson;
      /** The lesson with the REAL teacher's manual put back (the learner pack alone carries an empty stand-in). */
      unit: LessonUnit;
      grownup: GrownupPackContent;
    }
  /** The lesson is on the phone but the grown-up pack is not: offer to download it. */
  | { status: 'needs_grownup_pack'; lesson: LoadedLesson };

/**
 * Loads what a helper session needs: the child's lesson AND the grown-up pack. A helper session cannot start
 * without the grown-up pack (the helper script lives there), so its absence is a state of its own, not an error.
 * Anything else that goes wrong (a missing or damaged learner pack) throws for the screen to explain.
 */
export async function loadHelperLesson(sources: HelperLessonSources): Promise<HelperLessonResult> {
  const lesson = await sources.loadLesson();
  const grownup = await sources.loadGrownup();
  if (grownup === null) return { status: 'needs_grownup_pack', lesson };
  const joined = joinUnitFromPacks(lesson.unit, grownup);
  if (joined.kind !== 'lesson')
    throw new Error('This unit is not a lesson, so it has no helper script.');
  return { status: 'ready', lesson, unit: joined, grownup };
}
