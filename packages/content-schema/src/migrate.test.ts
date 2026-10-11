import { describe, expect, it } from 'vitest';
import { CURRENT_SCHEMA_VERSION } from './common';
import { goldenUnit2 } from './fixtures';
import { MIGRATIONS, SchemaVersionError, migrateToCurrent, migrateV0ToV1 } from './migrate';
import { parseUnit } from './parse';
import { clone } from './test-utils';

/** A small v0 unit: `nerdc_objective` in the header and `questions` as an array. */
const v0Revision = {
  kind: 'revision',
  header: {
    subject_slug: 'basic-science',
    level_code: 'P1',
    term: 1,
    title: 'Revision: Term 1',
    nerdc_objective: 'Review of all topics: Environment, roads, colours, shapes, living things',
    stage: 'absorb',
  },
  sections: [
    {
      id: 'review_places',
      type: 'revision_topic',
      layer: 'CORE',
      heading: 'Places',
      blocks: [{ type: 'question', question_id: 'q_places' }],
    },
  ],
  questions: [
    {
      id: 'q_places',
      kind: 'mcq',
      tier: 1,
      prompt: 'Where do we cook?',
      options: ['kitchen', 'bedroom'],
      answer: { correct_index: 0 },
    },
  ],
  scoring: { total_marks: 10, pass_mark: 5 },
};

/** What the migration must produce (golden). */
const v1Revision = {
  schema_version: 1,
  kind: 'revision',
  header: {
    subject_slug: 'basic-science',
    level_code: 'P1',
    term: 1,
    title: 'Revision: Term 1',
    objective: 'Review of all topics: Environment, roads, colours, shapes, living things',
    stage: 'absorb',
  },
  sections: v0Revision.sections,
  questions: {
    q_places: {
      id: 'q_places',
      kind: 'mcq',
      tier: 1,
      prompt: 'Where do we cook?',
      options: ['kitchen', 'bedroom'],
      answer: { correct_index: 0 },
    },
  },
  scoring: { total_marks: 10, pass_mark: 5 },
};

/** Turns a v1 lesson back into the v0 shape. */
function toV0(unit: typeof goldenUnit2): Record<string, unknown> {
  const copy = clone(unit) as unknown as Record<string, unknown>;
  const { objective, ...header } = clone(unit.header);
  copy.header = { ...header, nerdc_objective: objective };
  copy.questions = Object.values(clone(unit.questions));
  delete copy.schema_version;
  return copy;
}

describe('migrateToCurrent', () => {
  it('migrates a v0 unit (missing schema_version) to v1: golden', () => {
    const result = migrateToCurrent(v0Revision);
    expect(result.from).toBe(0);
    expect(result.to).toBe(CURRENT_SCHEMA_VERSION);
    expect(result.unit).toEqual(v1Revision);
  });

  it('treats an explicit schema_version 0 the same as a missing one', () => {
    const result = migrateToCurrent({ ...v0Revision, schema_version: 0 });
    expect(result.from).toBe(0);
    expect(result.unit).toEqual(v1Revision);
  });

  it('does not mutate its input', () => {
    const input = clone(v0Revision);
    migrateToCurrent(input);
    expect(input).toEqual(v0Revision);
  });

  it('migrates a whole v0 lesson back to the golden unit', () => {
    const v0 = toV0(goldenUnit2);
    expect(v0.schema_version).toBeUndefined();
    expect(Array.isArray(v0.questions)).toBe(true);
    const { unit, from } = migrateToCurrent(v0);
    expect(from).toBe(0);
    expect(unit).toEqual(goldenUnit2);
    expect(parseUnit(v0)).toEqual(goldenUnit2);
  });

  it('keeps an existing v1 objective if both names are present', () => {
    const result = migrateV0ToV1({
      header: { objective: 'new', nerdc_objective: 'old' },
      questions: [],
    });
    expect(result.header).toEqual({ objective: 'new' });
  });

  it('returns current content unchanged', () => {
    const result = migrateToCurrent(goldenUnit2);
    expect(result).toEqual({ unit: goldenUnit2, from: 1, to: 1 });
    expect(result.unit).toBe(goldenUnit2);
  });

  it('has a migration for every version below the current one', () => {
    for (let version = 0; version < CURRENT_SCHEMA_VERSION; version += 1) {
      expect(typeof MIGRATIONS[version]).toBe('function');
    }
  });

  it('throws a typed error for content newer than this build supports', () => {
    const attempt = () =>
      migrateToCurrent({ ...clone(goldenUnit2), schema_version: CURRENT_SCHEMA_VERSION + 1 });
    expect(attempt).toThrow(SchemaVersionError);
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaVersionError);
      const typed = error as SchemaVersionError;
      expect(typed.code).toBe('newer_than_supported');
      expect(typed.found).toBe(CURRENT_SCHEMA_VERSION + 1);
      expect(typed.supported).toBe(CURRENT_SCHEMA_VERSION);
      expect(typed.message).toContain('update the app');
    }
  });

  it('rejects an invalid schema_version', () => {
    for (const bad of ['1', -1, 1.5, null, true]) {
      try {
        migrateToCurrent({ ...v0Revision, schema_version: bad });
        throw new Error('expected a SchemaVersionError');
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaVersionError);
        expect((error as SchemaVersionError).code).toBe('invalid_version');
      }
    }
  });

  it('rejects input that is not an object', () => {
    for (const bad of [null, 'text', 42, [], undefined]) {
      expect(() => migrateToCurrent(bad)).toThrow(TypeError);
    }
  });
});
