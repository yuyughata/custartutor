import { describe, expect, it } from 'vitest';
import { parseUnit } from '@custar/content-schema';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { newBlock } from './factories';
import {
  TABLE_MAX_COLUMNS,
  blockSummary,
  tableAddColumn,
  tableAddRow,
  tableRemoveColumn,
  tableRemoveRow,
} from './blocks';

describe('blockSummary', () => {
  it('says what each kind of block is about, without the bold markers', () => {
    expect(blockSummary({ type: 'paragraph', text: 'The **market** is busy.' })).toBe(
      'The market is busy.',
    );
    expect(blockSummary({ type: 'definition', term: 'Noun', meaning: 'A naming word' })).toBe(
      'Noun: A naming word',
    );
    expect(blockSummary({ type: 'bullets', items: [{ text: 'one' }, { text: 'two' }] })).toBe(
      '2 items: one',
    );
    expect(blockSummary({ type: 'table', headers: ['a', 'b'], rows: [['1', '2']] })).toBe(
      '2 columns, 1 row',
    );
    expect(blockSummary({ type: 'question', question_id: 'q_name' })).toBe('q_name');
    expect(blockSummary({ type: 'unknown', original_type: 'poll', raw: {} })).toBe(
      'unrecognised block type "poll"',
    );
  });

  it('is empty for a new block and for rubbish', () => {
    expect(blockSummary(newBlock('paragraph'))).toBe('');
    expect(blockSummary(null)).toBe('');
    expect(blockSummary('text')).toBe('');
  });

  it('shortens long text', () => {
    const out = blockSummary({ type: 'paragraph', text: 'word '.repeat(60) });
    expect(out.length).toBeLessThanOrEqual(80);
    expect(out.endsWith('…')).toBe(true);
  });

  it('summarises every block of the golden unit', () => {
    const unit = parseUnit(goldenUnit2);
    for (const section of 'sections' in unit ? (unit.sections ?? []) : []) {
      for (const block of section.blocks) expect(typeof blockSummary(block)).toBe('string');
    }
  });
});

describe('table operations', () => {
  const table = {
    type: 'table',
    headers: ['Animal', 'Sound'],
    rows: [
      ['cat', 'meow'],
      ['dog', 'woof'],
    ],
  };

  it('adds a column to the header and every row', () => {
    const next = tableAddColumn(table);
    expect(next.headers).toEqual(['Animal', 'Sound', '']);
    expect(next.rows).toEqual([
      ['cat', 'meow', ''],
      ['dog', 'woof', ''],
    ]);
  });

  it('removes a column from the header and every row, but never the last one', () => {
    const next = tableRemoveColumn(table, 0);
    expect(next.headers).toEqual(['Sound']);
    expect(next.rows).toEqual([['meow'], ['woof']]);
    expect(tableRemoveColumn(next, 0)).toBe(next);
  });

  it('stops at the largest table', () => {
    let big: Record<string, unknown> = table;
    for (let i = 0; i < 20; i += 1) big = tableAddColumn(big);
    expect((big.headers as string[]).length).toBe(TABLE_MAX_COLUMNS);
  });

  it('adds a row as wide as the header and keeps at least one row', () => {
    expect(tableAddRow(table).rows).toEqual([
      ['cat', 'meow'],
      ['dog', 'woof'],
      ['', ''],
    ]);
    const one = tableRemoveRow({ ...table, rows: [['cat', 'meow']] }, 0);
    expect(one.rows).toEqual([['cat', 'meow']]);
    expect(tableRemoveRow(table, 1).rows).toEqual([['cat', 'meow']]);
  });

  it('keeps the table rectangular through any sequence (the schema would refuse a ragged one)', () => {
    let t: Record<string, unknown> = table;
    t = tableAddColumn(t);
    t = tableAddRow(t);
    t = tableRemoveColumn(t, 1);
    const width = (t.headers as string[]).length;
    expect((t.rows as string[][]).every((row) => row.length === width)).toBe(true);
  });
});
