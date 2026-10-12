import { describe, expect, it } from 'vitest';
import { stripInlineMarkup } from '@custar/content-schema';
import { charCount, hasUnmatchedMarker, plainText, splitBold, toggleBold, wordCount } from './markup';

describe('splitBold', () => {
  it('splits on balanced markers', () => {
    expect(splitBold('a **b** c')).toEqual([
      { text: 'a ', bold: false },
      { text: 'b', bold: true },
      { text: ' c', bold: false },
    ]);
  });

  it('leaves an unmatched marker literal (nothing is bold)', () => {
    expect(splitBold('a **b c')).toEqual([{ text: 'a **b c', bold: false }]);
    expect(hasUnmatchedMarker('a **b c')).toBe(true);
    expect(hasUnmatchedMarker('a **b** c')).toBe(false);
    expect(hasUnmatchedMarker('plain')).toBe(false);
  });

  it('copes with the empty string and an empty pair', () => {
    expect(splitBold('')).toEqual([]);
    expect(splitBold('a****b')).toEqual([
      { text: 'a', bold: false },
      { text: 'b', bold: false },
    ]);
  });
});

describe('counts and plain text', () => {
  it('counts characters as people see them', () => {
    expect(charCount('ọkọ')).toBe(3);
    expect(charCount('😀a')).toBe(2);
    expect(charCount('')).toBe(0);
  });

  it('counts words in the spoken text', () => {
    expect(wordCount('Name **three** places!')).toBe(3);
    expect(wordCount('  ')).toBe(0);
  });

  it('plainText is what the tutor speaks (content-schema stripInlineMarkup)', () => {
    for (const text of ['a **b** c', 'no marks', '**all**', 'a ** b', 'two **x** and **y**']) {
      expect(plainText(text)).toBe(stripInlineMarkup(text));
    }
  });
});

describe('toggleBold', () => {
  it('wraps a selection and keeps it selected', () => {
    const out = toggleBold('Name three places', { start: 5, end: 10 });
    expect(out.text).toBe('Name **three** places');
    expect(out.text.slice(out.selection.start, out.selection.end)).toBe('three');
  });

  it('puts the caret between an empty pair when nothing is selected', () => {
    const out = toggleBold('ab', { start: 1, end: 1 });
    expect(out.text).toBe('a****b');
    expect(out.selection).toEqual({ start: 3, end: 3 });
  });

  it('unwraps when the stars are just outside the selection', () => {
    const out = toggleBold('Name **three** places', { start: 7, end: 12 });
    expect(out.text).toBe('Name three places');
    expect(out.text.slice(out.selection.start, out.selection.end)).toBe('three');
  });

  it('unwraps when the selection includes the stars', () => {
    const out = toggleBold('Name **three** places', { start: 5, end: 14 });
    expect(out.text).toBe('Name three places');
  });

  it('puts the stars inside surrounding spaces', () => {
    const out = toggleBold('a b c', { start: 1, end: 4 });
    expect(out.text).toBe('a **b** c');
  });

  it('removes stars already inside the selection so spans never nest', () => {
    const out = toggleBold('one **two** three', { start: 0, end: 17 });
    expect(out.text).toBe('**one two three**');
    expect(hasUnmatchedMarker(out.text)).toBe(false);
  });

  it('treats a selection of only spaces as a caret', () => {
    const out = toggleBold('a   b', { start: 1, end: 3 });
    expect(out.text).toBe('a  **** b');
  });

  it('accepts a backwards selection', () => {
    expect(toggleBold('abc', { start: 3, end: 0 }).text).toBe('**abc**');
  });

  it('applying it twice returns the original text', () => {
    const first = toggleBold('Name three places', { start: 5, end: 10 });
    const second = toggleBold(first.text, first.selection);
    expect(second.text).toBe('Name three places');
  });
});
