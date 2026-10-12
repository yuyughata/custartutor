// sanitizeReply: the last deterministic filter on what the tutor model wrote, before a child sees it (and again
// on the whole reply after the stream). It TIDIES what can be tidied (links, HTML, markdown, emoji, length) and
// REJECTS what cannot (see rejections.ts); a rejected reply is replaced by the fixed redirect text upstream.
//
// What it cannot do: judge whether advice is good, whether a fact is right, or whether a sentence is unkind. That
// is the tutor prompt's job and the output check's (a second model), and neither is proof.
import { cleanReply, cutAtSentence, sameText } from './cleanReply';
import { findRejections } from './rejections';
import type { RejectionOptions, RejectionReason } from './rejections';

export type { RejectionOptions, RejectionReason } from './rejections';

/** About three to four short sentences for the youngest children; the pipeline narrows it by stage. */
export const DEFAULT_MAX_REPLY_CHARS = 700;

export interface SanitizeOptions extends RejectionOptions {
  maxChars?: number;
}

export interface SanitizeResult {
  /** The plain text to show. Empty when `rejected`. */
  text: string;
  /** The text differs from the input in more than whitespace. */
  changed: boolean;
  rejected: boolean;
  /** Why the reply was rejected (empty when it was not). */
  reasons: RejectionReason[];
  /** What was tidied: markup, links, emoji, length. */
  fixes: Array<'markup' | 'link' | 'emoji' | 'truncated'>;
}

function fixesFor(input: string, cleaned: string): SanitizeResult['fixes'] {
  const fixes: SanitizeResult['fixes'] = [];
  if (/[*_`#>]|<\/?[a-z]|&[a-z]+;|\]\(/i.test(input) && !sameText(input, cleaned)) fixes.push('markup');
  if (/https?:|www\.|\.(?:com|ng|org|net)\b/i.test(input)) fixes.push('link');
  if (/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(input)) fixes.push('emoji');
  return fixes;
}

export function sanitizeReply(input: string, options: SanitizeOptions = {}): SanitizeResult {
  const cleaned = cleanReply(input);
  const fixes = fixesFor(input, cleaned);
  const reasons = findRejections(cleaned, options);
  if (reasons.length > 0) {
    return { text: '', changed: true, rejected: true, reasons, fixes };
  }
  const max = options.maxChars ?? DEFAULT_MAX_REPLY_CHARS;
  const text = cutAtSentence(cleaned, max);
  if (text !== cleaned) fixes.push('truncated');
  return { text, changed: !sameText(input, text), rejected: false, reasons: [], fixes };
}
