import { CURRENT_SCHEMA_VERSION } from './common';

/**
 * Schema evolution. Every stored unit carries `schema_version`. `migrateToCurrent` upgrades old content
 * one version at a time with pure `vN -> vN+1` functions from the registry below, so any old pack can be
 * brought to the current shape. Content written by a NEWER schema than this build knows is refused with a
 * typed error: the app must update (the pack manifest's `min_app_version` normally prevents this).
 *
 * To change the schema: bump `CURRENT_SCHEMA_VERSION`, add the `vN -> vN+1` function to `MIGRATIONS`, add
 * a golden fixture pair to `migrate.test.ts`. Never edit an existing migration.
 */

export type RawUnit = Record<string, unknown>;
export type Migration = (unit: RawUnit) => RawUnit;

export type SchemaVersionErrorCode = 'newer_than_supported' | 'invalid_version' | 'missing_migration';

export class SchemaVersionError extends Error {
  readonly code: SchemaVersionErrorCode;
  readonly found: unknown;
  readonly supported: number;

  constructor(code: SchemaVersionErrorCode, found: unknown, supported: number, message: string) {
    super(message);
    this.name = 'SchemaVersionError';
    this.code = code;
    this.found = found;
    this.supported = supported;
  }
}

function isRecord(value: unknown): value is RawUnit {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * v0 -> v1.
 *
 * v0 differences from v1 (the only two):
 *  1. The NERDC objective lived at `header.nerdc_objective`; v1 calls it `header.objective`.
 *  2. `questions` was an ARRAY of question objects (each with its own `id`); v1 stores a MAP keyed by
 *     question id, so blocks and the workbook can resolve a question in constant time.
 * Everything else is unchanged.
 */
export function migrateV0ToV1(unit: RawUnit): RawUnit {
  const next: RawUnit = { ...unit };

  if (isRecord(unit.header)) {
    const { nerdc_objective: legacyObjective, ...header } = unit.header;
    next.header =
      legacyObjective !== undefined && header.objective === undefined
        ? { ...header, objective: legacyObjective }
        : { ...header };
  }

  if (Array.isArray(unit.questions)) {
    const map: RawUnit = {};
    for (const question of unit.questions as unknown[]) {
      if (isRecord(question) && typeof question.id === 'string') {
        map[question.id] = question;
      }
    }
    next.questions = map;
  }

  return next;
}

/** Registry of migrations, keyed by the version they upgrade FROM. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  0: migrateV0ToV1,
};

export interface MigrationResult {
  unit: RawUnit;
  /** Version the input was at (a missing `schema_version` counts as 0). */
  from: number;
  /** Version of the returned unit: always `CURRENT_SCHEMA_VERSION`. */
  to: number;
}

/**
 * Upgrades raw unit JSON to the current schema version. Pure: the input is not mutated. Content that is
 * already current is returned as is (same object).
 *
 * Throws `SchemaVersionError` when the version is not a non-negative integer (`invalid_version`), is
 * newer than this build supports (`newer_than_supported`), or a step is missing from the registry
 * (`missing_migration`); throws TypeError when the input is not an object.
 */
export function migrateToCurrent(raw: unknown): MigrationResult {
  if (!isRecord(raw)) {
    throw new TypeError('unit content must be a JSON object');
  }
  const found = raw.schema_version ?? 0;
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 0) {
    throw new SchemaVersionError(
      'invalid_version',
      raw.schema_version,
      CURRENT_SCHEMA_VERSION,
      `schema_version must be a non-negative integer, got ${JSON.stringify(raw.schema_version)}`,
    );
  }
  if (found > CURRENT_SCHEMA_VERSION) {
    throw new SchemaVersionError(
      'newer_than_supported',
      found,
      CURRENT_SCHEMA_VERSION,
      `content has schema_version ${found} but this build supports up to ${CURRENT_SCHEMA_VERSION}; update the app`,
    );
  }

  let unit: RawUnit = raw;
  for (let version = found; version < CURRENT_SCHEMA_VERSION; version += 1) {
    const step = MIGRATIONS[version];
    if (!step) {
      throw new SchemaVersionError(
        'missing_migration',
        version,
        CURRENT_SCHEMA_VERSION,
        `no migration from schema_version ${version} to ${version + 1}`,
      );
    }
    unit = { ...step(unit), schema_version: version + 1 };
  }
  return { unit, from: found, to: CURRENT_SCHEMA_VERSION };
}
