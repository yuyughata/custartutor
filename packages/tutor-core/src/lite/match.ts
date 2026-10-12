// How Tutor Lite reads a child's typed reply. Everything here is deterministic and offline, and it reuses the
// content-schema grader so the rules are the SAME as for fill-in-the-blank questions:
//   - text: NFC, case, spaces and end punctuation are ignored; one typo is forgiven only on answers of 6 or more
//     letters with no digits;
//   - numbers: compared by exact value, never by edit distance ("12" is never "21"; "1/2" is "0.5"); the number
//     words "zero" to "one hundred" count as numbers.
import { gradeBlank, normalizeText, parseNumeric } from '@custar/content-schema';

/** Unit words a child may add around a number ("5 naira", "₦5", "12 cm"). Only these are ever ignored. */
export const LITE_UNITS: readonly string[] = [
  '₦', 'naira', 'kobo', 'kg', 'g', 'cm', 'mm', 'm', 'km', 'l', 'ml',
  'years', 'year', 'yrs', 'minutes', 'minute', 'mins', 'hours', 'hour', 'seconds', 'second', 'secs',
  'days', 'day', 'pieces', 'piece',
];

const ONES = [
  'zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven',
  'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen',
];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** "seven" -> "7", "twenty five" / "twenty-five" -> "25", "one hundred" -> "100"; null when it is not a number word. */
export function numberWordToDigits(text: string): string | null {
  const words = text.toLowerCase().replace(/-/g, ' ').trim().split(/\s+/).filter(Boolean);
  if (words.length === 0 || words.length > 3) return null;
  if (words.length === 1) {
    const one = ONES.indexOf(words[0] as string);
    if (one !== -1) return String(one);
    const ten = TENS.indexOf(words[0] as string);
    if (ten > 1) return String(ten * 10);
    return words[0] === 'hundred' ? '100' : null;
  }
  if (words.length === 2) {
    const ten = TENS.indexOf(words[0] as string);
    const one = ONES.indexOf(words[1] as string);
    if (ten > 1 && one > 0 && one < 10) return String(ten * 10 + one);
    if (words[0] === 'one' && words[1] === 'hundred') return '100';
  }
  return null;
}

/** True when the reply matches one of the accepted answers, with the rules of a fill-in-the-blank blank. */
export function matchesAccepted(reply: string, accepted: readonly string[]): boolean {
  if (normalizeText(reply) === '') return false;
  const numeric = accepted.some((value) => parseNumeric(value, { units: LITE_UNITS }) !== null);
  const spoken = numeric ? numberWordToDigits(reply) : null;
  return [reply, ...(spoken === null ? [] : [spoken])].some((candidate) =>
    gradeBlank(candidate, { accepted, numeric, units: LITE_UNITS }),
  );
}

/** Splits "kitchen, bedroom and bath" into its parts. */
export function splitList(text: string): string[] {
  return text
    .split(/\s*(?:[,;\n]|&|\band\b)\s*/i)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

/** "I am not sure" and the like: the child says they do not have an answer. */
export function isNegativeSelfReport(text: string): boolean {
  return /^(?:no|nope|nah|not yet|not sure|i do not know|i don'?t know|dont know|idk|no idea|i can'?t|cant|skip|help)\b/i.test(
    normalizeText(text),
  );
}

