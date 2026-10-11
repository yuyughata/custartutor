import { z } from 'zod';

/** Version of the unit content schema produced by this package. Bump together with a `migrate.ts` step. */
export const CURRENT_SCHEMA_VERSION = 1;

/** Developmental stage (brief section 9): absorb (nursery) to connect (lower primary) to express (upper). */
export const Stage = z.enum(['absorb', 'connect', 'express']);
export type Stage = z.infer<typeof Stage>;

/** Stage order, lowest rung first. */
export const STAGE_ORDER: readonly Stage[] = ['absorb', 'connect', 'express'];

/** Section layer: NERDC base (CORE), MFW-derived enrichment (ENRICH), or core critical thinking (CORE+). */
export const Layer = z.enum(['CORE', 'ENRICH', 'CORE+']);
export type Layer = z.infer<typeof Layer>;

export const LevelCode = z.enum(['P1', 'P2', 'P3', 'P4', 'P5', 'P6']);
export type LevelCode = z.infer<typeof LevelCode>;

export const UnitKind = z.enum([
  'lesson',
  'mini_project',
  'term_project',
  'revision',
  'assessment',
]);
export type UnitKind = z.infer<typeof UnitKind>;

/**
 * Language tag, BCP 47 style: `en-NG`, `yo`, `ig`, `ha`. Deliberately loose (primary subtag plus optional
 * subtags); we do not validate against the IANA registry.
 */
export const Lang = z
  .string()
  .regex(/^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/, 'must be a language tag such as en-NG, yo, ig or ha');
export type Lang = z.infer<typeof Lang>;

/**
 * Stable identifier for sections, questions, tutor nodes, hotspots, variants. Lowercase slug with
 * underscores. IDs are assigned once and NEVER change across versions of a unit (see README).
 */
export const Id = z
  .string()
  .regex(
    /^[a-z][a-z0-9_]{1,63}$/,
    'must be a lowercase slug (letters, digits, underscores), 2-64 chars',
  );
export type Id = z.infer<typeof Id>;

/** Slug with hyphens, for subjects and themes (`basic-science`, `market-day`). */
export const Slug = z
  .string()
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'must be a lowercase hyphenated slug');
export type Slug = z.infer<typeof Slug>;

/** Identifier of an uploaded asset (image, audio): a UUID, content hash or slug. */
export const AssetId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/, 'must be an asset identifier');
export type AssetId = z.infer<typeof AssetId>;

/** Child-facing or teacher-facing text that must not be blank. May contain `**bold**` spans. */
export const Text = z.string().refine((value) => value.trim().length > 0, 'must not be blank');
export type Text = z.infer<typeof Text>;

/** Term number within the school year. */
export const Term = z.literal([1, 2, 3]);
export type Term = z.infer<typeof Term>;

/** Difficulty tier of a question: 1 supported, 2 now you try, 3 stretch. */
export const Tier = z.literal([1, 2, 3]);
export type Tier = z.infer<typeof Tier>;

/** Position of a value in `STAGE_ORDER`. */
export function stageIndex(stage: Stage): number {
  return STAGE_ORDER.indexOf(stage);
}
