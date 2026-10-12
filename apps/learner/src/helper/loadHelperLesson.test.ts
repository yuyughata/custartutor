import { describe, expect, it, vi } from 'vitest';
import { hasTeacherManual, parseUnit, splitUnitForPacks } from '@custar/content-schema';
import type { LessonUnit } from '@custar/content-schema';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import type { LoadedLesson } from '@custar/learner-core';
import { loadHelperLesson } from './loadHelperLesson';

const full = parseUnit(goldenUnit2) as LessonUnit;
const { learner, grownup } = splitUnitForPacks(full);
if (!grownup) throw new Error('fixture has no grown-up content');

// What `loadActiveLesson` hands back for a phone with only the learner pack: the manual is an empty stand-in.
const learnerOnly = parseUnit({
  ...learner,
  teacher_manual: {
    script: [],
    timing: 'The teacher manual is in the grown-up pack.',
    materials: [],
    mastery_guidance: { got_it: [], not_yet: 'The teacher manual is in the grown-up pack.' },
    helper_script: [],
  },
}) as LessonUnit;

const lesson = {
  unitId: 'u1',
  versionNo: 3,
  unit: learnerOnly,
  manifest: {},
  assetPath: () => null,
} as unknown as LoadedLesson;

describe('loadHelperLesson', () => {
  it('puts the real teacher manual back when both packs are on the phone', async () => {
    expect(hasTeacherManual(learnerOnly)).toBe(false);
    const result = await loadHelperLesson({
      loadLesson: () => Promise.resolve(lesson),
      loadGrownup: () => Promise.resolve(grownup),
    });
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.unit.teacher_manual).toEqual(full.teacher_manual);
    expect(hasTeacherManual(result.unit)).toBe(true);
    expect(result.lesson).toBe(lesson);
  });

  it('reports "needs the grown-up pack" when only the learner pack is there (not an error)', async () => {
    const result = await loadHelperLesson({
      loadLesson: () => Promise.resolve(lesson),
      loadGrownup: () => Promise.resolve(null),
    });
    expect(result.status).toBe('needs_grownup_pack');
    expect(result.lesson).toBe(lesson);
  });

  it('lets a missing or damaged learner pack surface as an error, and does not read the grown-up pack', async () => {
    const loadGrownup = vi.fn(() => Promise.resolve(grownup));
    await expect(
      loadHelperLesson({
        loadLesson: () => Promise.reject(new Error('no pack')),
        loadGrownup,
      }),
    ).rejects.toThrow('no pack');
    expect(loadGrownup).not.toHaveBeenCalled();
  });

  it('lets a damaged grown-up pack surface as an error', async () => {
    await expect(
      loadHelperLesson({
        loadLesson: () => Promise.resolve(lesson),
        loadGrownup: () => Promise.reject(new Error('grown-up file damaged')),
      }),
    ).rejects.toThrow('grown-up file damaged');
  });
});
