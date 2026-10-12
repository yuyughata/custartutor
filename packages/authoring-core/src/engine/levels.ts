// Stage defaults by class level (brief section 9). Absorb is nursery and early primary, connect is lower
// primary, express is upper primary. Primary 1 follows the template: absorb moving to connect.
import type { LevelCode, Stage } from '@custar/content-schema';
import { stageIndex } from '@custar/content-schema';

export interface StageDefault {
  stage: Stage;
  stage_to?: Stage;
  /** Stages a unit of this level may use. */
  allowed: readonly Stage[];
  /** One sentence for the planner. */
  guidance: string;
}

export const STAGE_BY_LEVEL: Record<LevelCode, StageDefault> = {
  P1: {
    stage: 'absorb',
    stage_to: 'connect',
    allowed: ['absorb', 'connect'],
    guidance:
      'Primary 1 (ages 5 to 7): the template unit is stage absorb moving to connect. Use stage "absorb" with stage_to "connect" unless a unit is plainly only one of them.',
  },
  P2: {
    stage: 'connect',
    allowed: ['absorb', 'connect'],
    guidance:
      'Primary 2 (ages 6 to 8): use stage "connect" with stage_to "none"; use "absorb" only for a first, very concrete week.',
  },
  P3: {
    stage: 'connect',
    allowed: ['connect'],
    guidance: 'Primary 3 (ages 7 to 9): use stage "connect" with stage_to "none".',
  },
  P4: {
    stage: 'connect',
    stage_to: 'express',
    allowed: ['connect', 'express'],
    guidance:
      'Primary 4 (ages 8 to 10): use stage "connect" moving to "express" (stage_to "express"); a week that is plainly only reasoning or only explaining may use one of them.',
  },
  P5: {
    stage: 'express',
    allowed: ['connect', 'express'],
    guidance: 'Primary 5 (ages 9 to 11): use stage "express" with stage_to "none".',
  },
  P6: {
    stage: 'express',
    allowed: ['express'],
    guidance: 'Primary 6 (ages 10 to 12): use stage "express" with stage_to "none".',
  },
};

/** Fixes a model-proposed stage pair to something valid for the level. Returns the pair and a note when it changed. */
export function normaliseStage(
  level: LevelCode,
  stage: Stage,
  stageTo: Stage | 'none',
): { stage: Stage; stage_to?: Stage; note?: string } {
  const rule = STAGE_BY_LEVEL[level];
  let nextStage = stage;
  let note: string | undefined;
  if (!rule.allowed.includes(stage)) {
    nextStage = rule.stage;
    note = `stage "${stage}" is not used at ${level}; set to "${rule.stage}"`;
  }
  let nextTo: Stage | undefined = stageTo === 'none' ? undefined : stageTo;
  if (
    nextTo !== undefined &&
    (!rule.allowed.includes(nextTo) || stageIndex(nextTo) <= stageIndex(nextStage))
  ) {
    nextTo = undefined;
  }
  if (
    stageTo === 'none' &&
    note !== undefined &&
    rule.stage_to !== undefined &&
    stageIndex(rule.stage_to) > stageIndex(nextStage)
  ) {
    nextTo = rule.stage_to;
  }
  return { stage: nextStage, ...(nextTo ? { stage_to: nextTo } : {}), ...(note ? { note } : {}) };
}
