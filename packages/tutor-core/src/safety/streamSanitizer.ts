// The incremental form of sanitizeReply, for streaming. Text is released one SENTENCE at a time, after the same
// cleaning and rejection rules have looked at it together with everything released before, so a URL, a phone
// number or a markdown token is never split across two chunks and a rejected sentence is never shown. A sentence
// that runs on (no full stop for 160 characters) is released at a word boundary, never inside a run of digits.
//
//   const sanitizer = createStreamSanitizer(options);
//   for each model chunk: const step = sanitizer.push(chunk);  // step.text is what the child may now see
//   at the end:           const last = sanitizer.end();
// Once `rejected` or `done` is true nothing more is released and the caller can stop reading the model.
import { cleanReply, cutAtSentence } from './cleanReply';
import { DEFAULT_MAX_REPLY_CHARS } from './sanitize';
import type { SanitizeOptions } from './sanitize';
import { findRejections } from './rejections';
import type { RejectionReason } from './rejections';

export interface StreamStep {
  /** New text to show (includes the joining space), possibly empty. */
  text: string;
  rejected: boolean;
  /** Nothing more will be released (rejected, or the length limit was reached). Stop reading the model. */
  done: boolean;
  reasons: RejectionReason[];
}

export interface StreamSanitizer {
  push(chunk: string): StreamStep;
  /** Flushes what is left. `truncated: true` drops an unfinished last sentence (the model ran out of tokens). */
  end(options?: { truncated?: boolean }): StreamStep;
  /** Everything released so far. */
  readonly released: string;
  readonly rejected: boolean;
  /** Nothing more will be released. */
  readonly done: boolean;
  readonly reasons: readonly RejectionReason[];
}

const LONG_RUN = 160;
const SENTENCE_END = /[.!?]["')\]]*\s/g;

/** The index up to which `pending` can be released, or 0 when nothing can be yet. */
function releasePoint(pending: string): number {
  let cut = 0;
  SENTENCE_END.lastIndex = 0;
  for (let match = SENTENCE_END.exec(pending); match !== null; match = SENTENCE_END.exec(pending)) {
    cut = match.index + match[0].length;
  }
  const newline = pending.lastIndexOf('\n');
  if (newline + 1 > cut) cut = newline + 1;
  if (cut > 0 || pending.length < LONG_RUN) return cut;

  // a long sentence: cut at the last space, but not after a word that could be the start of a number
  let end = pending.lastIndexOf(' ');
  while (end > 0) {
    const before = pending.lastIndexOf(' ', end - 1);
    const word = pending.slice(before + 1, end);
    if (before > 0 && /^[\d().+-]+$/.test(word)) end = before;
    else break;
  }
  return end > 0 ? end + 1 : 0;
}

export function createStreamSanitizer(options: SanitizeOptions = {}): StreamSanitizer {
  const max = options.maxChars ?? DEFAULT_MAX_REPLY_CHARS;
  let pending = '';
  let released = '';
  let rejected = false;
  let done = false;
  let reasons: RejectionReason[] = [];

  const idle = (): StreamStep => ({ text: '', rejected, done, reasons: [...reasons] });

  const take = (segment: string): StreamStep => {
    const cleaned = cleanReply(segment);
    if (cleaned === '') return idle();
    const candidate = released === '' ? cleaned : `${released} ${cleaned}`;
    const found = findRejections(candidate, options);
    if (found.length > 0) {
      rejected = true;
      done = true;
      reasons = found;
      return { text: '', rejected, done, reasons: [...reasons] };
    }
    if (candidate.length > max) {
      const cut = cutAtSentence(candidate, max);
      done = true;
      const added = cut.length > released.length ? cut.slice(released.length) : '';
      released = cut.length > released.length ? cut : released;
      return { text: added, rejected, done, reasons: [] };
    }
    const text = released === '' ? cleaned : ` ${cleaned}`;
    released = candidate;
    return { text, rejected, done, reasons: [] };
  };

  return {
    push(chunk: string): StreamStep {
      if (done) return idle();
      pending += chunk;
      const cut = releasePoint(pending);
      if (cut === 0) return idle();
      const segment = pending.slice(0, cut);
      pending = pending.slice(cut);
      return take(segment);
    },
    end(endOptions: { truncated?: boolean } = {}): StreamStep {
      if (done) return idle();
      let rest = pending;
      pending = '';
      if (endOptions.truncated === true && !/[.!?]["')\]]*\s*$/.test(rest)) rest = '';
      const step = rest.trim() === '' ? idle() : take(rest);
      done = true;
      return { ...step, done: true };
    },
    get released() {
      return released;
    },
    get rejected() {
      return rejected;
    },
    get done() {
      return done;
    },
    get reasons() {
      return reasons;
    },
  };
}
