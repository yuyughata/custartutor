import { describe, expect, it } from 'vitest';
import { splitForSpeech } from './chunks';

describe('splitForSpeech', () => {
  it('returns nothing for empty text and one piece for short text', () => {
    expect(splitForSpeech('')).toEqual([]);
    expect(splitForSpeech('   \n ')).toEqual([]);
    expect(splitForSpeech('We learn in school.')).toEqual(['We learn in school.']);
  });

  it('collapses whitespace', () => {
    expect(splitForSpeech('We   learn\nin\tschool.')).toEqual(['We learn in school.']);
  });

  it('packs whole sentences up to the limit', () => {
    const text = 'One two three. Four five six. Seven eight nine. Ten eleven twelve.';
    const pieces = splitForSpeech(text, 32);
    expect(pieces.every((piece) => piece.length <= 32)).toBe(true);
    expect(pieces.length).toBeGreaterThan(1);
    // each piece ends at a sentence end
    for (const piece of pieces) expect(piece).toMatch(/[.!?]$/);
    expect(pieces.join(' ')).toBe(text);
  });

  it('does not cut a decimal number at its point', () => {
    const pieces = splitForSpeech('It costs 3.5 naira. Next sentence is here.', 22);
    expect(pieces[0]).toContain('3.5 naira.');
  });

  it('breaks an over-long sentence at commas, then spaces', () => {
    const text =
      'First we wash our hands, then we dry them well, then we sit down at the table together, and finally we eat.';
    const pieces = splitForSpeech(text, 40);
    expect(pieces.every((piece) => piece.length <= 40)).toBe(true);
    expect(pieces.join(' ')).toBe(text);
    expect(pieces[0]?.endsWith(',')).toBe(true);
  });

  it('cuts a single huge word hard rather than looping forever', () => {
    const word = 'a'.repeat(100);
    const pieces = splitForSpeech(word, 30);
    expect(pieces.every((piece) => piece.length <= 30)).toBe(true);
    expect(pieces.join('')).toBe(word);
  });

  it('keeps every piece within the limit for long real text', () => {
    const text = Array.from({ length: 60 }, (_, i) => `Sentence number ${i} is short.`).join(' ');
    for (const limit of [60, 200, 600]) {
      const pieces = splitForSpeech(text, limit);
      expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(limit);
      expect(pieces.join(' ')).toBe(text);
    }
  });
});
