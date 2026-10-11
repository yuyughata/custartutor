import type { LevelCode, Stage } from '@custar/content-schema';
import { stageLabels } from '@custar/design-tokens';

/** `basic-science` becomes `Basic Science`. */
export function subjectName(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** `P1` becomes `Primary 1`. */
export function levelName(code: LevelCode): string {
  return `Primary ${code.slice(1)}`;
}

/** The template's stage line: "Absorb → Connect (name, notice, recall; compare, sort, reason)". */
export function stageLine(stage: Stage, stageTo?: Stage): string {
  const from = stageLabels[stage];
  if (stageTo && stageTo !== stage) {
    const to = stageLabels[stageTo];
    return `${from.label} → ${to.label} (${from.mode}; ${to.mode})`;
  }
  return `${from.label} (${from.mode})`;
}

export type ViewMode = 'student' | 'grownup' | 'admin';

/** Grown-ups and admins see layer badges, teacher's manual and answers. */
export function isGrownUpMode(mode: ViewMode): boolean {
  return mode !== 'student';
}
