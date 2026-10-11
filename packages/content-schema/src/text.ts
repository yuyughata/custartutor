/**
 * Text normalisation and fuzzy matching used by deterministic grading.
 *
 * Rules (also see `numeric.ts` for numbers):
 *  - Unicode NFC, so composed and decomposed forms of Yoruba/Igbo/Hausa letters compare equal.
 *  - Diacritics are PRESERVED: "ọkọ" (vehicle) and "oko" (farm) are different words and stay different.
 *  - Case-insensitive, whitespace collapsed and trimmed, curly quotes straightened.
 *  - Trailing punctuation (and surrounding quote or bracket marks) is ignored: "Kitchen!" = "kitchen".
 *  - Typo tolerance is optional, and limited to ONE edit on answers of 6 or more characters that contain
 *    no digits. Short words and anything numeric must match exactly.
 */

/** Minimum length (in characters) of the accepted answer before one typo is forgiven. */
export const TYPO_MIN_LENGTH = 6;

export function normalizeText(input: string): string {
  return input
    .normalize('NFC')
    .replace(/[‘’ʼ]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .normalize('NFC')
    .replace(/^[\p{Pi}\p{Ps}"'\s]+/u, '')
    .replace(/[\p{P}\s]+$/u, '');
}

function codePoints(value: string): string[] {
  return Array.from(value);
}

/** Classic Levenshtein edit distance over Unicode code points (a transposition costs 2). */
export function levenshtein(a: string, b: string): number {
  const left = codePoints(a);
  const right = codePoints(b);
  if (left.length === 0) return right.length;
  if (right.length === 0) return left.length;
  let previous: number[] = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current: number[] = [i];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      );
    }
    previous = current;
  }
  return previous[right.length] ?? 0;
}

const HAS_DIGIT = /\p{Nd}/u;

export type TextMatchVia = 'exact' | 'typo';

export interface TextMatchOptions {
  /** Forgive one typo on long non-numeric answers. Default true. */
  typoTolerance?: boolean;
}

/**
 * Matches a response against a list of accepted answers.
 * Returns how it matched, or null when it does not.
 */
export function matchText(
  response: string,
  accepted: readonly string[],
  options: TextMatchOptions = {},
): TextMatchVia | null {
  const normalizedResponse = normalizeText(response);
  if (normalizedResponse === '') return null;
  const candidates = accepted.map(normalizeText).filter((value) => value !== '');
  if (candidates.includes(normalizedResponse)) return 'exact';
  if (options.typoTolerance === false) return null;
  if (HAS_DIGIT.test(normalizedResponse)) return null;
  for (const candidate of candidates) {
    if (codePoints(candidate).length < TYPO_MIN_LENGTH) continue;
    if (HAS_DIGIT.test(candidate)) continue;
    if (levenshtein(normalizedResponse, candidate) === 1) return 'typo';
  }
  return null;
}
