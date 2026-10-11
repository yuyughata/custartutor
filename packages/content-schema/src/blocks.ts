import { z } from 'zod';
import { AssetId, Id, Lang, Text } from './common';

/**
 * Content blocks, discriminated on `type`.
 *
 * Inline markup: any text field may contain `**bold**` spans and nothing else. Renderers turn the spans
 * into bold runs; the tutor and text-to-speech strip them with `stripInlineMarkup`.
 *
 * Every block may carry its own `lang` (for example a Yoruba key term inside an English section).
 */

const langField = { lang: Lang.optional() };

export const ParagraphBlock = z.object({
  type: z.literal('paragraph'),
  text: Text,
  ...langField,
});

/** A bullet. When `lead` is set it renders in bold as `**lead** — text` (glossary style lists). */
export const BulletItem = z.object({
  lead: Text.optional(),
  text: Text,
});

export const BulletsBlock = z.object({
  type: z.literal('bullets'),
  items: z.array(BulletItem).min(1),
  ...langField,
});

export const DefinitionBlock = z.object({
  type: z.literal('definition'),
  term: Text,
  meaning: Text,
  ...langField,
});

export const ExampleBlock = z.object({
  type: z.literal('example'),
  label: Text,
  text: Text,
  ...langField,
});

export const DialogueBlock = z.object({
  type: z.literal('dialogue'),
  lines: z.array(z.object({ character: Text, text: Text })).min(1),
  ...langField,
});

/**
 * An illustration. `brief` is the description for human illustrators or image models; `alt` is the
 * accessible description shown to screen readers and spoken by the tutor. `asset_id` is filled in once
 * the picture exists. Until then the renderer shows a dashed placeholder with the brief.
 */
export const IllustrationBlock = z.object({
  type: z.literal('illustration'),
  asset_id: AssetId.optional(),
  brief: Text,
  alt: Text,
  ...langField,
});

export const CalloutBlock = z.object({
  type: z.literal('callout'),
  tone: z.enum(['info', 'tip', 'not_yet']),
  text: Text,
  ...langField,
});

export const ActivityStepsBlock = z.object({
  type: z.literal('activity_steps'),
  steps: z.array(z.object({ label: Text, text: Text })).min(1),
  ...langField,
});

export const TableBlock = z
  .object({
    type: z.literal('table'),
    headers: z.array(Text).min(1),
    rows: z.array(z.array(z.string())).min(1),
    ...langField,
  })
  .superRefine((table, ctx) => {
    table.rows.forEach((row, index) => {
      if (row.length !== table.headers.length) {
        ctx.addIssue({
          code: 'custom',
          message: `row has ${row.length} cells but there are ${table.headers.length} headers`,
          path: ['rows', index],
        });
      }
    });
  });

/** Places a question from the unit's `questions` map into the flow of a section. */
export const QuestionBlock = z.object({
  type: z.literal('question'),
  question_id: Id,
  ...langField,
});

/** The block types this version of the schema understands. */
export const Block = z.discriminatedUnion('type', [
  ParagraphBlock,
  BulletsBlock,
  DefinitionBlock,
  ExampleBlock,
  DialogueBlock,
  IllustrationBlock,
  CalloutBlock,
  ActivityStepsBlock,
  TableBlock,
  QuestionBlock,
]);
export type Block = z.infer<typeof Block>;
export type BlockType = Block['type'];

export const BLOCK_TYPES: readonly BlockType[] = [
  'paragraph',
  'bullets',
  'definition',
  'example',
  'dialogue',
  'illustration',
  'callout',
  'activity_steps',
  'table',
  'question',
];

/**
 * Stand-in for a block whose `type` this build does not recognise (for example a block type added by a
 * newer schema version). Produced by `parseBlocksLenient`; never authored by hand. The renderer should
 * skip it (or show nothing) rather than crash, and lint reports it as an error so it cannot be published.
 */
export const UnknownBlock = z.object({
  type: z.literal('unknown'),
  original_type: z.string(),
  raw: z.unknown(),
});
export type UnknownBlock = z.infer<typeof UnknownBlock>;

/** What a section's `blocks` array may hold: known blocks plus the degraded `unknown` stand-in. */
export const AnyBlock = z.discriminatedUnion('type', [...Block.options, UnknownBlock]);
export type AnyBlock = z.infer<typeof AnyBlock>;

export function isUnknownBlock(block: AnyBlock): block is UnknownBlock {
  return block.type === 'unknown';
}

const KNOWN_TYPES: ReadonlySet<string> = new Set(BLOCK_TYPES);

/**
 * True when `raw` is an object whose `type` is one of the block types this build understands.
 */
export function isKnownBlockType(raw: unknown): boolean {
  if (typeof raw !== 'object' || raw === null) return false;
  const type = (raw as { type?: unknown }).type;
  return typeof type === 'string' && KNOWN_TYPES.has(type);
}

function isUnknownWrapper(raw: unknown): boolean {
  return (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { type?: unknown }).type === 'unknown' &&
    typeof (raw as { original_type?: unknown }).original_type === 'string'
  );
}

/**
 * Leaves a recognised block (or an existing `unknown` stand-in) as it is, and wraps anything else as
 * `{ type: 'unknown', original_type, raw }`. Never throws.
 */
export function degradeUnknownBlock(raw: unknown): unknown {
  if (isKnownBlockType(raw) || isUnknownWrapper(raw)) return raw;
  const type =
    typeof raw === 'object' && raw !== null ? (raw as { type?: unknown }).type : undefined;
  return {
    type: 'unknown',
    original_type: typeof type === 'string' ? type : '(missing)',
    raw,
  };
}

/**
 * Parses a list of raw blocks WITHOUT throwing on an unrecognised block `type`.
 *
 * Graceful degradation: when a newer content pack contains a block type an older app build has never
 * heard of, the old build must still open the lesson. Each unrecognised block becomes
 * `{ type: 'unknown', original_type, raw }` and everything else parses normally. A block with a known
 * `type` but an invalid shape is a real content error and still throws (ZodError), because a changed
 * shape of an existing block is a breaking change that must bump `schema_version`.
 *
 * Input that is not an array throws a TypeError.
 */
export function parseBlocksLenient(input: unknown): AnyBlock[] {
  if (!Array.isArray(input)) {
    throw new TypeError('blocks must be an array');
  }
  return input.map((raw: unknown) => AnyBlock.parse(degradeUnknownBlock(raw)));
}

/** Removes `**bold**` markers, for text-to-speech, the tutor and reading-level analysis. */
export function stripInlineMarkup(text: string): string {
  return text.replace(/\*\*(.+?)\*\*/g, '$1');
}
