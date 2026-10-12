import { describe, expect, it } from 'vitest';
import { redactPii } from '../redact';
import { detectGuardPatterns, detectSafetyPatterns } from '../safety/patterns';
import { sanitizeReply } from '../safety/sanitize';
import { createStreamSanitizer } from '../safety/streamSanitizer';
import { MAX_RAW_CHARS, prepareTurn } from './prepare';
import { makeInput } from '../../test-support/testKit';

/** Text built to make a careless pattern slow: long runs of near-matches. */
const NASTY = [
  'a at '.repeat(200),
  'www. '.repeat(200),
  '1 '.repeat(500),
  'I live at '.repeat(100),
  'my name is '.repeat(90),
  '12 Test '.repeat(120),
  '0800 '.repeat(200),
  'zero '.repeat(200),
  '.'.repeat(1000),
  ' '.repeat(1000),
  '@'.repeat(1000),
  'i '.repeat(500),
  'd'.repeat(1000),
  'http://'.repeat(120),
  '(+'.repeat(500),
  '**_'.repeat(300),
  '\u{1F600}'.repeat(300),
  'x.com '.repeat(160),
  'dot '.repeat(250),
  'my teacher is '.repeat(70),
];

function time(run: () => unknown): number {
  const started = Date.now();
  run();
  return Date.now() - started;
}

describe('hostile input cannot make the text layers slow or throw', () => {
  it.each(NASTY.map((text, i) => [i, text.slice(0, 1000)] as const))('case %i', (_i, text) => {
    expect(time(() => redactPii(text, { knownNames: ['Testa Sample'] }))).toBeLessThan(400);
    expect(time(() => detectSafetyPatterns(text))).toBeLessThan(400);
    expect(time(() => detectGuardPatterns(text))).toBeLessThan(400);
    expect(time(() => sanitizeReply(text))).toBeLessThan(400);
    expect(time(() => prepareTurn(makeInput({ message: { mode: 'text', text } })))).toBeLessThan(800);
  });

  it('a stream of one-character chunks stays cheap', () => {
    const sanitizer = createStreamSanitizer();
    const text = 'We cook in the kitchen. Where do we sleep? Think about it carefully. '.repeat(8);
    const spent = time(() => {
      for (const char of text) sanitizer.push(char);
      sanitizer.end();
    });
    expect(spent).toBeLessThan(800);
    expect(sanitizer.rejected).toBe(false);
  });

  it('cuts a message that is far longer than the server allows before it reaches any layer', () => {
    const prepared = prepareTurn(makeInput({ message: { mode: 'text', text: 'word '.repeat(5000) } }));
    expect(prepared.childText.length).toBeLessThanOrEqual(MAX_RAW_CHARS);
  });
});

describe('the pattern list after the safety review', () => {
  it.each([
    'my mother beats me',
    'my papa is hitting me',
    'my oga dey beat me',
    'my madam always hits me',
    'he always hits me',
    'someone keeps touching me',
    'I have not eaten for two days',
    'my friend wants to hurt himself',
    'please kill me',
    'I feel so worthless',
    'I should die',
  ])('flags "%s"', (text) => {
    expect(detectSafetyPatterns(text).length).toBeGreaterThan(0);
  });

  it.each([
    'my brother hit me with a pillow',
    'he hits the ball very far',
    'my sister is beating the drum',
    'the teacher touched the board',
    'we eat at home',
    'she wants to dance',
  ])('does not flag "%s"', (text) => {
    expect(detectSafetyPatterns(text)).toEqual([]);
  });
});
