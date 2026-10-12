import { describe, expect, it } from 'vitest';
import { sanitizeReply } from './sanitize';
import { createStreamSanitizer } from './streamSanitizer';
import type { SanitizeOptions } from './sanitize';

/** A small deterministic generator, so "random" chunking is the same on every run. */
function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function chunked(text: string, next: () => number): string[] {
  const parts: string[] = [];
  let index = 0;
  while (index < text.length) {
    const size = 1 + Math.floor(next() * 9);
    parts.push(text.slice(index, index + size));
    index += size;
  }
  return parts;
}

function run(chunks: string[], options?: SanitizeOptions) {
  const sanitizer = createStreamSanitizer(options);
  const shown: string[] = [];
  for (const chunk of chunks) {
    const step = sanitizer.push(chunk);
    if (step.text !== '') shown.push(step.text);
    if (step.done) break;
  }
  const last = sanitizer.end();
  if (last.text !== '') shown.push(last.text);
  return { sanitizer, shown, text: shown.join('') };
}

describe('createStreamSanitizer', () => {
  it('releases text one sentence at a time', () => {
    const sanitizer = createStreamSanitizer();
    expect(sanitizer.push('We cook in the').text).toBe('');
    expect(sanitizer.push(' kitchen. Where').text).toBe('We cook in the kitchen.');
    expect(sanitizer.push(' do we sleep?').text).toBe('');
    expect(sanitizer.end().text).toBe(' Where do we sleep?');
    expect(sanitizer.released).toBe('We cook in the kitchen. Where do we sleep?');
  });

  it('gives the same text as sanitizeReply, however the stream is chunked', () => {
    const replies = [
      'Good try! **Think** about where we cook. Is it the <b>kitchen</b>? See www.example.com for more.',
      'The price is 1 000 000 naira, or 10 20 30 40 50. Count with me: 1 2 3 4 5. Well done!',
      'First, look at the picture.\n\nThen say what you see.\n- one\n- two',
    ];
    const next = lcg(7);
    for (const reply of replies) {
      const whole = sanitizeReply(reply);
      for (let i = 0; i < 40; i += 1) {
        const result = run(chunked(reply, next));
        expect(result.sanitizer.rejected).toBe(false);
        expect(result.text.replace(/\s+/g, ' ')).toBe(whole.text);
      }
    }
  });

  it('never splits a link or a number across two releases', () => {
    const reply =
      'Visit https://example.com/some/long/path today. Then call 0800 000 0000 now. Bye.';
    const next = lcg(11);
    for (let i = 0; i < 40; i += 1) {
      const result = run(chunked(reply, next));
      for (const piece of result.shown) {
        expect(piece).not.toMatch(/https?:|example\.com|0800/);
      }
    }
  });

  it('rejects the sentence that asks for personal data, before showing it', () => {
    const sanitizer = createStreamSanitizer();
    const first = sanitizer.push('Well done. ');
    expect(first.text).toBe('Well done.');
    const step = sanitizer.push('Now, what is your name? ');
    expect(step.rejected).toBe(true);
    expect(step.done).toBe(true);
    expect(step.text).toBe('');
    expect(sanitizer.reasons).toContain('asks_personal_data');
    expect(sanitizer.push('more text. ').text).toBe('');
    expect(sanitizer.released).toBe('Well done.');
  });

  it('catches a rule that spans two sentences of the stream', () => {
    const sanitizer = createStreamSanitizer({ masteryGuard: [['kitchen']] });
    sanitizer.push('Let me tell you the answer. ');
    expect(sanitizer.rejected).toBe(false);
    const step = sanitizer.push('The correct answer is the kitchen. ');
    expect(step.rejected).toBe(true);
  });

  it('stops at the length limit, on a sentence end', () => {
    const sanitizer = createStreamSanitizer({ maxChars: 60 });
    const out: string[] = [];
    for (const sentence of [
      'This is one. ',
      'This is two. ',
      'This is three. ',
      'This is four. ',
    ]) {
      const step = sanitizer.push(sentence);
      out.push(step.text);
      if (step.done) break;
    }
    expect(sanitizer.released.length).toBeLessThanOrEqual(60);
    expect(sanitizer.released.endsWith('.')).toBe(true);
    expect(out.join('')).toBe(sanitizer.released);
  });

  it('drops an unfinished last sentence when the model ran out of tokens', () => {
    const sanitizer = createStreamSanitizer();
    sanitizer.push('We cook in the kitchen. And then we');
    const last = sanitizer.end({ truncated: true });
    expect(last.text).toBe('');
    expect(sanitizer.released).toBe('We cook in the kitchen.');
  });

  it('releases a very long sentence at a word boundary, not inside a number', () => {
    const sanitizer = createStreamSanitizer({ maxChars: 5000 });
    const filler = 'word '.repeat(40);
    const step = sanitizer.push(`${filler}call 0800 000`);
    expect(step.text).not.toMatch(/0800/);
    const rest = sanitizer.push(' 0000 now');
    const end = sanitizer.end();
    expect(`${step.text}${rest.text}${end.text}`).not.toContain('0800 000 0000');
    expect(sanitizer.rejected).toBe(true);
  });
});
