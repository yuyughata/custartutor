import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contentSchema from '@custar/content-schema';
import { ChapterPlanResult, SchemeIngestResult } from '../contract';
import { LlmRequestError } from './errors';
import { toStructuredJsonSchema } from './structuredSchema';

type Json = Record<string, unknown>;

function convert(schema: z.ZodType): Json {
  return toStructuredJsonSchema(schema, 'Test');
}

/** Every object node in a schema, with its path. */
function objectNodes(node: unknown, path = ''): Array<[string, Json]> {
  if (Array.isArray(node)) return node.flatMap((item, i) => objectNodes(item, `${path}/${i}`));
  if (typeof node !== 'object' || node === null) return [];
  const record = node as Json;
  const here: Array<[string, Json]> = record['type'] === 'object' ? [[path, record]] : [];
  return [
    ...here,
    ...Object.entries(record).flatMap(([key, value]) => objectNodes(value, `${path}/${key}`)),
  ];
}

describe('toStructuredJsonSchema', () => {
  it('closes every object, keeps required and drops the $schema marker', () => {
    const schema = convert(
      z.object({ a: z.string(), b: z.number().optional(), c: z.object({ d: z.boolean() }) }),
    );
    expect(schema).toEqual({
      type: 'object',
      properties: {
        a: { type: 'string' },
        b: { type: 'number' },
        c: {
          type: 'object',
          properties: { d: { type: 'boolean' } },
          required: ['d'],
          additionalProperties: false,
        },
      },
      required: ['a', 'c'],
      additionalProperties: false,
    });
  });

  it('keeps enum, const and the supported string formats as keywords', () => {
    const schema = convert(
      z.object({
        stage: z.enum(['absorb', 'connect']),
        kind: z.literal('mcq'),
        tier: z.literal([1, 2, 3]),
        id: z.string().uuid(),
        at: z.iso.datetime(),
      }),
    );
    const props = schema['properties'] as Record<string, Json>;
    expect(props['stage']).toEqual({ type: 'string', enum: ['absorb', 'connect'] });
    expect(props['kind']).toEqual({ type: 'string', const: 'mcq' });
    expect(props['tier']).toMatchObject({ enum: [1, 2, 3] });
    // The regex Zod puts next to a format is dropped; the format says it.
    expect(props['id']).toEqual({ type: 'string', format: 'uuid' });
    expect(props['at']).toMatchObject({ type: 'string', format: 'date-time' });
    expect(props['at']).not.toHaveProperty('pattern');
  });

  it('folds unsupported constraints into the description so the model still sees them', () => {
    const schema = convert(
      z.object({
        short: z.string().min(3).max(40).describe('A short label.'),
        tags: z.array(z.string()).min(2).max(5),
        score: z.number().int().min(0).max(10),
        slug: z.string().regex(/^[a-z]+$/),
      }),
    );
    const props = schema['properties'] as Record<string, Json>;
    expect(props['short']).toEqual({
      type: 'string',
      description: 'A short label.\n\n{minLength: 3, maxLength: 40}',
    });
    expect(props['tags']).toEqual({
      type: 'array',
      items: { type: 'string' },
      description: '{minItems: 2, maxItems: 5}',
    });
    expect(props['score']).toEqual({ type: 'integer', description: '{minimum: 0, maximum: 10}' });
    expect(props['slug']).toEqual({ type: 'string', description: '{pattern: "^[a-z]+$"}' });
  });

  it('keeps minItems 0 and 1 and drops the safe-integer range Zod writes for .int()', () => {
    const schema = convert(z.object({ list: z.array(z.string()).min(1), n: z.number().int() }));
    const props = schema['properties'] as Record<string, Json>;
    expect(props['list']).toMatchObject({ minItems: 1 });
    expect(props['n']).toEqual({ type: 'integer' });
  });

  it('writes nullable as anyOf and turns oneOf into anyOf', () => {
    const schema = convert(
      z.object({
        maybe: z.string().nullable(),
        either: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('a'), x: z.string() }),
          z.object({ kind: z.literal('b'), y: z.number() }),
        ]),
      }),
    );
    const props = schema['properties'] as Record<string, Json>;
    expect(props['maybe']).toEqual({ anyOf: [{ type: 'string' }, { type: 'null' }] });
    const either = props['either'] as Json;
    expect(either).toHaveProperty('anyOf');
    expect(either).not.toHaveProperty('oneOf');
    expect(objectNodes(either).every(([, node]) => node['additionalProperties'] === false)).toBe(
      true,
    );
  });

  it('puts defaults in the description and leaves them optional', () => {
    const schema = convert(z.object({ n: z.number().default(3) }));
    expect(schema['required']).toBeUndefined();
    expect((schema['properties'] as Record<string, Json>)['n']).toEqual({
      type: 'number',
      description: '{default: 3}',
    });
  });

  it('inlines definitions used once or tiny, and keeps genuinely shared structures as $defs', () => {
    const Shared = z.object({ id: z.string(), label: z.string(), note: z.string().optional() });
    const schema = convert(z.object({ first: Shared, second: Shared, title: z.string() }));
    const defs = schema['$defs'] as Record<string, Json> | undefined;
    expect(defs).toBeDefined();
    expect(Object.keys(defs ?? {})).toHaveLength(1);
    const props = schema['properties'] as Record<string, Json>;
    expect(props['first']).toHaveProperty('$ref');
    expect(props['first']).toEqual(props['second']);
    expect(props['title']).toEqual({ type: 'string' });
    // Every $ref resolves.
    const ref = String((props['first'] as Json)['$ref']);
    expect(defs).toHaveProperty(ref.replace('#/$defs/', ''));
  });

  it('is cached per schema object', () => {
    const schema = z.object({ a: z.string() });
    expect(toStructuredJsonSchema(schema, 'A')).toBe(toStructuredJsonSchema(schema, 'A'));
  });

  it.each([
    ['a record', z.object({ bag: z.record(z.string(), z.string()) }), /bag.*arbitrary keys/],
    ['unknown', z.object({ raw: z.unknown() }), /raw.*no type/],
    ['a tuple', z.object({ pair: z.tuple([z.string(), z.number()]) }), /pair.*tuple/],
    ['a non-object root', z.array(z.string()), /\(root\).*must be an object/],
    [
      'a custom schema',
      z.object({ x: z.custom<string>(() => true) }),
      /cannot be expressed|no type/,
    ],
  ] as Array<[string, z.ZodType, RegExp]>)(
    'rejects %s, naming the schema and the path',
    (_n, schema, pattern) => {
      expect(() => convert(schema)).toThrow(LlmRequestError);
      expect(() => convert(schema)).toThrow(/Schema "Test"/);
      expect(() => convert(schema)).toThrow(pattern);
    },
  );

  it('rejects a recursive schema', () => {
    interface Tree {
      value: string;
      children: Tree[];
    }
    const Tree: z.ZodType<Tree> = z.lazy(() =>
      z.object({ value: z.string(), children: z.array(Tree) }),
    );
    expect(() => convert(z.object({ tree: Tree }))).toThrow(/recurs/);
  });
});

describe('the schemas the engine uses', () => {
  it('converts the contract result types the model fills in', () => {
    for (const [name, schema] of Object.entries({ ChapterPlanResult, SchemeIngestResult })) {
      const converted = toStructuredJsonSchema(schema, name);
      expect(
        objectNodes(converted).every(([, node]) => node['additionalProperties'] === false),
      ).toBe(true);
    }
  });

  it('converts the strict content-schema pieces', () => {
    const strict = {
      LessonHeader: contentSchema.LessonHeader,
      TutorScript: contentSchema.TutorScript,
      Workbook: contentSchema.Workbook,
      TeacherManual: contentSchema.TeacherManual,
      McqQuestion: contentSchema.McqQuestion,
      MatchQuestion: contentSchema.MatchQuestion,
      Scheme: contentSchema.Scheme,
    };
    for (const [name, schema] of Object.entries(strict)) {
      expect(() => toStructuredJsonSchema(schema, name), name).not.toThrow();
    }
  });

  // These two are facts the prompt builders must design around, not behaviour to be fixed here: the lenient
  // `Section`/`UnitContent` carry `UnknownBlock.raw` (z.unknown) and the sort question carries a record.
  it('refuses the lenient section and the sort question as they are', () => {
    expect(() => toStructuredJsonSchema(contentSchema.Section, 'Section')).toThrow(/raw/);
    expect(() => toStructuredJsonSchema(contentSchema.SortQuestion, 'SortQuestion')).toThrow(
      /mapping/,
    );
  });
});
