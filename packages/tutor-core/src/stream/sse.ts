// The SSE codec of `tutor-chat` (ADR 0008). The server writes one `data:` line of JSON per TutorStreamEvent; the
// learner app feeds the response body, in whatever chunks the network delivers, to the parser and gets validated
// events back. The parser never throws: a malformed or unknown message is skipped, because a child's chat must not
// die over one bad line, and the app can always recover the finished turn with `fetch_turn`.
//
// Parsing follows the SSE rules that matter here: lines end with LF, CRLF or CR (also when a CRLF is split between
// two chunks); a line starting with ":" is a comment (keep-alive); several `data:` lines of one event are joined
// with a newline; a blank line ends the event; the fields `event`, `id` and `retry` are ignored; a leading BOM is
// dropped. An event that is still incomplete when the stream ends is dropped unless its data already is a whole,
// valid event.
import { TutorStreamEvent } from '../contract';

export const SSE_KEEP_ALIVE = ': keep-alive\n\n';
export const DEFAULT_MAX_EVENT_CHARS = 65_536;

/** One event as an SSE message. */
export function encodeSseEvent(event: TutorStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** A comment line; proxies and phones keep the connection open when they see traffic. */
export function encodeSseComment(text = 'keep-alive'): string {
  return `: ${text.replace(/[\r\n]+/g, ' ')}\n\n`;
}

export interface SseParserOptions {
  /** Longest accepted event (the sum of its data lines). Longer ones are skipped. Default 64 KiB. */
  maxEventChars?: number;
}

export interface SseParser {
  /** Feed the next chunk of text; returns the events completed by it, in order. */
  push(chunk: string): TutorStreamEvent[];
  /** The stream ended. */
  flush(): TutorStreamEvent[];
}

function toEvent(data: string): TutorStreamEvent | null {
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    return null;
  }
  const parsed = TutorStreamEvent.safeParse(json);
  return parsed.success ? parsed.data : null;
}

export function createSseParser(options: SseParserOptions = {}): SseParser {
  const maxEvent = options.maxEventChars ?? DEFAULT_MAX_EVENT_CHARS;
  let line = '';
  let sawCarriageReturn = false;
  let started = false;
  let data: string[] = [];
  let size = 0;
  let overflow = false;

  const reset = (): void => {
    data = [];
    size = 0;
    overflow = false;
  };

  const dispatch = (out: TutorStreamEvent[]): void => {
    if (data.length > 0 && !overflow) {
      const event = toEvent(data.join('\n'));
      if (event) out.push(event);
    }
    reset();
  };

  const handleLine = (text: string, out: TutorStreamEvent[]): void => {
    if (text === '') return dispatch(out);
    if (text.startsWith(':')) return;
    const colon = text.indexOf(':');
    const field = colon === -1 ? text : text.slice(0, colon);
    if (field !== 'data') return;
    let value = colon === -1 ? '' : text.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    size += value.length + 1;
    if (size > maxEvent) {
      overflow = true;
      data = [];
      return;
    }
    if (!overflow) data.push(value);
  };

  return {
    push(chunk: string): TutorStreamEvent[] {
      const out: TutorStreamEvent[] = [];
      let text = chunk;
      if (!started) {
        started = true;
        if (text.startsWith('\ufeff')) text = text.slice(1);
      }
      for (const char of text) {
        if (char === '\n' && sawCarriageReturn) {
          sawCarriageReturn = false;
          continue;
        }
        sawCarriageReturn = char === '\r';
        if (char === '\n' || char === '\r') {
          handleLine(line, out);
          line = '';
        } else if (line.length <= maxEvent) {
          line += char;
        } else {
          overflow = true;
        }
      }
      return out;
    },
    flush(): TutorStreamEvent[] {
      const out: TutorStreamEvent[] = [];
      if (line !== '') {
        handleLine(line, out);
        line = '';
      }
      if (data.length > 0 && !overflow) {
        const event = toEvent(data.join('\n'));
        if (event) out.push(event);
      }
      reset();
      return out;
    },
  };
}
