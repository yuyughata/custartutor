import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import {
  AnyBlock,
  BLOCK_TYPES,
  Block,
  degradeUnknownBlock,
  isKnownBlockType,
  isUnknownBlock,
  parseBlocksLenient,
  stripInlineMarkup,
} from './blocks';

const validBlocks: Record<string, unknown> = {
  paragraph: { type: 'paragraph', text: 'Hello.' },
  bullets: {
    type: 'bullets',
    items: [{ lead: 'classroom', text: 'where we learn' }, { text: 'A plain item' }],
  },
  definition: { type: 'definition', term: 'price', meaning: 'The money we pay.' },
  example: { type: 'example', label: 'Example 1', text: 'Where do we cook? The kitchen.' },
  dialogue: {
    type: 'dialogue',
    lines: [
      { character: 'Zari', text: 'Come and see!' },
      { character: 'Zuri', text: 'I am coming.' },
    ],
  },
  illustration: {
    type: 'illustration',
    brief: 'A school yard.',
    alt: 'Children in a school yard.',
  },
  callout: { type: 'callout', tone: 'tip', text: 'Take your time.' },
  activity_steps: { type: 'activity_steps', steps: [{ label: 'NAME', text: 'each place' }] },
  table: { type: 'table', headers: ['Goods', 'Price'], rows: [['Mango', '₦3']] },
  question: { type: 'question', question_id: 'q_one' },
};

describe('Block', () => {
  it('has a valid example for every block type', () => {
    expect(Object.keys(validBlocks).sort()).toEqual([...BLOCK_TYPES].sort());
    for (const [type, block] of Object.entries(validBlocks)) {
      const parsed = Block.parse(block);
      expect(parsed.type).toBe(type);
      expect(parsed).toEqual(block);
    }
  });

  it('accepts an optional lang on every block type', () => {
    for (const block of Object.values(validBlocks)) {
      const withLang = { ...(block as object), lang: 'yo' };
      expect(Block.parse(withLang)).toEqual(withLang);
    }
  });

  it('rejects an invalid lang', () => {
    expect(Block.safeParse({ type: 'paragraph', text: 'x', lang: 'English' }).success).toBe(false);
    expect(Block.safeParse({ type: 'paragraph', text: 'x', lang: 'en_NG' }).success).toBe(false);
  });

  it.each([
    ['paragraph without text', { type: 'paragraph' }],
    ['paragraph with blank text', { type: 'paragraph', text: '   ' }],
    ['bullets with no items', { type: 'bullets', items: [] }],
    ['definition without meaning', { type: 'definition', term: 'price' }],
    ['dialogue with no lines', { type: 'dialogue', lines: [] }],
    ['illustration without alt text', { type: 'illustration', brief: 'A picture' }],
    ['illustration without a brief', { type: 'illustration', alt: 'A picture' }],
    ['callout with an unknown tone', { type: 'callout', tone: 'warning', text: 'x' }],
    ['activity_steps with no steps', { type: 'activity_steps', steps: [] }],
    ['table with a ragged row', { type: 'table', headers: ['A', 'B'], rows: [['1']] }],
    ['question with a bad id', { type: 'question', question_id: 'Q 1' }],
    ['unknown type', { type: 'hologram' }],
  ])('rejects %s', (_name, block) => {
    expect(Block.safeParse(block).success).toBe(false);
  });

  it('allows an illustration to carry an asset id once the picture exists', () => {
    const block = {
      type: 'illustration',
      asset_id: 'img_0123abcd',
      brief: 'A yard',
      alt: 'A yard',
    };
    expect(Block.parse(block)).toEqual(block);
  });
});

describe('UnknownBlock and AnyBlock', () => {
  it('AnyBlock accepts the unknown stand-in', () => {
    const stand_in = { type: 'unknown', original_type: 'hologram', raw: { type: 'hologram' } };
    const parsed = AnyBlock.parse(stand_in);
    expect(isUnknownBlock(parsed)).toBe(true);
  });

  it('AnyBlock requires original_type on the stand-in', () => {
    expect(AnyBlock.safeParse({ type: 'unknown', raw: {} }).success).toBe(false);
  });
});

describe('parseBlocksLenient', () => {
  it('parses known blocks and degrades unrecognised ones without throwing', () => {
    const future = { type: 'hologram', depth: 3 };
    const result = parseBlocksLenient([validBlocks.paragraph, future, validBlocks.callout]);
    expect(result).toHaveLength(3);
    expect(result[0]).toEqual(validBlocks.paragraph);
    expect(result[1]).toEqual({ type: 'unknown', original_type: 'hologram', raw: future });
    expect(result[2]).toEqual(validBlocks.callout);
  });

  it('never throws for odd entries', () => {
    const result = parseBlocksLenient(['text', 42, null, {}, { type: 7 }, []]);
    expect(result.map((b) => (b.type === 'unknown' ? b.original_type : 'known'))).toEqual(
      Array(6).fill('(missing)'),
    );
  });

  it('keeps an existing stand-in', () => {
    const standIn = { type: 'unknown', original_type: 'hologram', raw: {} };
    expect(parseBlocksLenient([standIn])).toEqual([standIn]);
  });

  it('still throws for a known type with an invalid shape, and for non-arrays', () => {
    expect(() => parseBlocksLenient([{ type: 'paragraph' }])).toThrow(ZodError);
    expect(() => parseBlocksLenient({ type: 'paragraph' })).toThrow(TypeError);
  });

  it('degradeUnknownBlock and isKnownBlockType agree', () => {
    expect(isKnownBlockType(validBlocks.table)).toBe(true);
    expect(isKnownBlockType({ type: 'unknown' })).toBe(false);
    expect(isKnownBlockType(null)).toBe(false);
    expect(degradeUnknownBlock(validBlocks.table)).toBe(validBlocks.table);
  });
});

describe('stripInlineMarkup', () => {
  it('removes bold markers and nothing else', () => {
    expect(stripInlineMarkup('The **classroom** — where we **learn**.')).toBe(
      'The classroom — where we learn.',
    );
    expect(stripInlineMarkup('2 * 3 = 6')).toBe('2 * 3 = 6');
    expect(stripInlineMarkup('no markup')).toBe('no markup');
  });
});
