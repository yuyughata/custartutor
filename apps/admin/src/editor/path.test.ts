import { describe, expect, it } from 'vitest';
import {
  appendAt,
  getAt,
  insertAt,
  listAt,
  moveItem,
  pathKey,
  removeAt,
  samePath,
  setAt,
  startsWithPath,
  textAt,
  updateAt,
} from './path';

const base = {
  a: { b: [{ c: 1 }, { c: 2 }], s: 'x' },
  list: ['p', 'q', 'r'],
};

describe('getAt / listAt / textAt', () => {
  it('reads nested values and is quiet about what is missing', () => {
    expect(getAt(base, ['a', 'b', 1, 'c'])).toBe(2);
    expect(getAt(base, ['a', 'zzz', 0])).toBeUndefined();
    expect(getAt(base, ['list', 'x'])).toBeUndefined();
    expect(getAt(null, ['a'])).toBeUndefined();
    expect(listAt(base, ['list'])).toEqual(['p', 'q', 'r']);
    expect(listAt(base, ['a', 's'])).toEqual([]);
    expect(textAt(base, ['a', 's'])).toBe('x');
    expect(textAt(base, ['a', 'b'])).toBe('');
  });
});

describe('setAt', () => {
  it('is immutable and shares what it did not touch', () => {
    const next = setAt(base, ['a', 'b', 0, 'c'], 9);
    expect(getAt(next, ['a', 'b', 0, 'c'])).toBe(9);
    expect(getAt(base, ['a', 'b', 0, 'c'])).toBe(1);
    expect(next.list).toBe(base.list);
    expect(next.a.b[1]).toBe(base.a.b[1]);
  });

  it('returns the same object when nothing changes', () => {
    expect(setAt(base, ['a', 's'], 'x')).toBe(base);
  });

  it('creates missing containers: a list before a number, an object before a name', () => {
    const next = setAt({}, ['sections', 0, 'blocks', 1, 'text'], 'hi');
    expect(next).toEqual({ sections: [{ blocks: [undefined, { text: 'hi' }] }] });
    expect(Array.isArray((next as { sections: unknown }).sections)).toBe(true);
    expect(setAt({}, ['workbook', 'intro'], 'x')).toEqual({ workbook: { intro: 'x' } });
  });

  it('removes an object key when set to undefined', () => {
    expect(setAt({ a: 1, b: 2 }, ['a'], undefined)).toEqual({ b: 2 });
  });

  it('replaces the root for an empty path', () => {
    expect(setAt(base, [], 5)).toBe(5);
  });
});

describe('removeAt / insertAt / appendAt / moveItem / updateAt', () => {
  it('removes list items and object keys, and ignores what is not there', () => {
    expect(removeAt(base, ['list', 1]).list).toEqual(['p', 'r']);
    expect(removeAt(base, ['a', 's']).a).toEqual({ b: base.a.b });
    expect(removeAt(base, ['list', 9])).toBe(base);
    expect(removeAt(base, ['nope'])).toBe(base);
    expect(removeAt({ a: 1 }, ['a'])).toEqual({});
  });

  it('inserts at a position, clamped to the ends', () => {
    expect(insertAt(base, ['list'], 1, 'X').list).toEqual(['p', 'X', 'q', 'r']);
    expect(insertAt(base, ['list'], -5, 'X').list).toEqual(['X', 'p', 'q', 'r']);
    expect(insertAt(base, ['list'], 99, 'X').list).toEqual(['p', 'q', 'r', 'X']);
    expect(appendAt(base, ['list'], 'Z').list).toEqual(['p', 'q', 'r', 'Z']);
    expect(appendAt({}, ['made', 'list'], 1)).toEqual({ made: { list: [1] } });
  });

  it('moves an item and clamps the target', () => {
    expect(moveItem(base, ['list'], 0, 2).list).toEqual(['q', 'r', 'p']);
    expect(moveItem(base, ['list'], 2, 0).list).toEqual(['r', 'p', 'q']);
    expect(moveItem(base, ['list'], 1, 99).list).toEqual(['p', 'r', 'q']);
    expect(moveItem(base, ['list'], 1, 1)).toBe(base);
    expect(moveItem(base, ['list'], 7, 0)).toBe(base);
  });

  it('updates a value from the current one', () => {
    expect(updateAt(base, ['a', 's'], (s) => `${String(s)}!`).a.s).toBe('x!');
  });
});

describe('path keys', () => {
  it('formats like the schema paths and compares', () => {
    expect(pathKey(['sections', 2, 'blocks', 0, 'text'])).toBe('sections[2].blocks[0].text');
    expect(pathKey(['questions', 'q-odd', 'prompt'])).toBe('questions["q-odd"].prompt');
    expect(pathKey([])).toBe('');
    expect(samePath(['a', 1], ['a', 1])).toBe(true);
    expect(samePath(['a', 1], ['a', 2])).toBe(false);
    expect(startsWithPath(['a', 1, 'b'], ['a', 1])).toBe(true);
    expect(startsWithPath(['a'], ['a', 1])).toBe(false);
  });
});
