import { describe, expect, it } from 'vitest';
import type { TutorStreamEvent } from '../contract';
import { SSE_KEEP_ALIVE, createSseParser, encodeSseComment, encodeSseEvent } from './sse';

const SESSION = '22222222-2222-4222-8222-222222222222';
const MESSAGE = '33333333-3333-4333-8333-333333333333';

const EVENTS: TutorStreamEvent[] = [
  { type: 'meta', session_id: SESSION, message_id: MESSAGE },
  { type: 'safety', action: 'steer' },
  { type: 'delta', text: 'We cook in the kitchen. ' },
  { type: 'delta', text: 'Line one\nline two, "quoted", \u2028 and ☃ \u{1F600}' },
  { type: 'tool', name: 'show_activity', input: { question_id: 'qf_gutter' } },
  { type: 'replace', text: 'Let us go back to the lesson.', reason: 'filter' },
  { type: 'error', code: 'upstream', retryable: true },
  { type: 'done', message_id: MESSAGE },
];

function lcg(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

function split(text: string, next: () => number): string[] {
  const parts: string[] = [];
  let i = 0;
  while (i < text.length) {
    const size = 1 + Math.floor(next() * 12);
    parts.push(text.slice(i, i + size));
    i += size;
  }
  return parts;
}

function parseAll(chunks: string[]): TutorStreamEvent[] {
  const parser = createSseParser();
  const out: TutorStreamEvent[] = [];
  for (const chunk of chunks) out.push(...parser.push(chunk));
  out.push(...parser.flush());
  return out;
}

describe('encodeSseEvent', () => {
  it('writes one data line and a blank line', () => {
    expect(encodeSseEvent({ type: 'delta', text: 'Hi' })).toBe(
      'data: {"type":"delta","text":"Hi"}\n\n',
    );
    expect(encodeSseComment('a\nb')).toBe(': a b\n\n');
    expect(SSE_KEEP_ALIVE).toBe(': keep-alive\n\n');
  });

  it('never puts a raw newline inside a message', () => {
    for (const event of EVENTS) expect(encodeSseEvent(event).slice(0, -2)).not.toContain('\n');
  });
});

describe('createSseParser', () => {
  const wire = EVENTS.map(encodeSseEvent).join('');

  it('round-trips every event type in one chunk', () => {
    expect(parseAll([wire])).toEqual(EVENTS);
  });

  it('gives the same events however the stream is chunked (property)', () => {
    const next = lcg(42);
    for (let i = 0; i < 200; i += 1) expect(parseAll(split(wire, next))).toEqual(EVENTS);
  });

  it('copes with CRLF, CR, and a CRLF split between chunks', () => {
    const crlf = wire.replace(/\n/g, '\r\n');
    const cr = wire.replace(/\n/g, '\r');
    const next = lcg(9);
    expect(parseAll([crlf])).toEqual(EVENTS);
    expect(parseAll([cr])).toEqual(EVENTS);
    for (let i = 0; i < 100; i += 1) expect(parseAll(split(crlf, next))).toEqual(EVENTS);
    expect(parseAll(crlf.split(/(?<=\r)/))).toEqual(EVENTS);
  });

  it('ignores comments and keep-alives anywhere, and the other SSE fields', () => {
    const noisy = `${SSE_KEEP_ALIVE}event: message\nid: 7\nretry: 1000\n: hello\n${wire}${SSE_KEEP_ALIVE}`;
    expect(parseAll([noisy])).toEqual(EVENTS);
  });

  it('joins several data lines of one event with a newline', () => {
    const pretty = 'data: {\ndata:   "type": "delta",\ndata: "text": "multi"\ndata: }\n\n';
    expect(parseAll([pretty])).toEqual([{ type: 'delta', text: 'multi' }]);
  });

  it('accepts "data:" without the space and drops a leading BOM', () => {
    expect(parseAll(['\ufeffdata:{"type":"safety","action":"allow"}\n\n'])).toEqual([
      { type: 'safety', action: 'allow' },
    ]);
  });

  it('ignores event types it does not know and skips malformed messages without throwing', () => {
    const text = [
      'data: {"type":"future_thing","x":1}\n\n',
      'data: {not json\n\n',
      'data: 42\n\n',
      'data: {"type":"delta"}\n\n',
      'data: {"type":"delta","text":"ok"}\n\n',
      'garbage line without a colon\n\n',
    ].join('');
    expect(parseAll([text])).toEqual([{ type: 'delta', text: 'ok' }]);
  });

  it('skips an event that is over the size cap and carries on', () => {
    const parser = createSseParser({ maxEventChars: 200 });
    const big = `data: {"type":"delta","text":"${'x'.repeat(500)}"}\n\n`;
    const out = [...parser.push(big), ...parser.push('data: {"type":"delta","text":"after"}\n\n')];
    expect(out).toEqual([{ type: 'delta', text: 'after' }]);
  });

  it('drops an event cut off by the end of the stream, but keeps a complete one that lacks its blank line', () => {
    expect(parseAll(['data: {"type":"delta","te'])).toEqual([]);
    expect(parseAll(['data: {"type":"delta","text":"whole"}'])).toEqual([
      { type: 'delta', text: 'whole' },
    ]);
  });

  it('can be reused for a second stream after flush', () => {
    const parser = createSseParser();
    parser.push('data: {"type":"delta","te');
    parser.flush();
    expect(parser.push(encodeSseEvent({ type: 'delta', text: 'next' }))).toEqual([
      { type: 'delta', text: 'next' },
    ]);
  });
});
