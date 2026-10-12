// Finds phone numbers and other long digit runs in free text.
//
// A phone number is typed in a dozen ways ("0803 123 4567", "+234 (803) 123-4567", "0803.123.4567", "O8O3..."), so
// this is a scanner rather than one regular expression: it collects a maximal run of digits and the separators
// people put between them, then decides what the run is. The decision is where the care is, because lesson
// maths is full of digit runs that must survive: "12 + 13 = 25", "5 000 kobo", "1 000 000", "10 20 30 40 50",
// "3.141592" and "1000000 naira" are not anybody's phone number.
//
// What it will NOT catch (documented in redact.ts): numbers split by words ("0803 my number 1234567"), numbers
// written in words other than the spoken-digits form handled below, and anything shorter than the thresholds.

export type DigitRunKind = 'phone' | 'number';

export interface DigitRun {
  start: number;
  end: number;
  kind: DigitRunKind;
}

const SEPARATORS = new Set([' ', '-', '–', '—', '.', '(', ')', '_', ' ', ' ', ' ']);

function isDigit(char: string | undefined): boolean {
  return char !== undefined && char >= '0' && char <= '9';
}

function isLetter(char: string | undefined): boolean {
  return char !== undefined && /\p{L}/u.test(char);
}

function isOLike(char: string | undefined): boolean {
  return char === 'o' || char === 'O';
}

/**
 * A letter O typed instead of a zero ("O8O3") counts as a digit when it touches a digit. The rule is local on
 * purpose: "10 o'clock" and "go8" are not digit runs.
 */
function digitLikeAt(text: string, index: number): boolean {
  const char = text[index];
  if (isDigit(char)) return true;
  if (!isOLike(char)) return false;
  const before = text[index - 1];
  const after = text[index + 1];
  // "O" must touch a digit or another O that touches a digit; do not eat the "o" of a word.
  if (isDigit(before) || isDigit(after)) return !isLetter(before) || isDigit(before);
  return false;
}

interface RawRun {
  start: number;
  end: number;
  plus: boolean;
  /** Maximal blocks of digits, separators removed (letter O read as zero). */
  groups: string[];
  separators: string[];
}

function scan(text: string): RawRun[] {
  const runs: RawRun[] = [];
  const length = text.length;
  let i = 0;
  while (i < length) {
    const char = text[i];
    let startsRun = false;
    let plus = false;
    let cursor = i;
    if (isDigit(char) || (isOLike(char) && digitLikeAt(text, i) && !isLetter(text[i - 1]))) {
      startsRun = true;
    } else if (char === '+') {
      let j = i + 1;
      if (text[j] === ' ') j += 1;
      if (text[j] === '(') j += 1;
      if (digitLikeAt(text, j) && !isDigit(text[i - 1]) && !isLetter(text[i - 1])) {
        startsRun = true;
        plus = true;
        cursor = j;
      }
    } else if (char === '(' && digitLikeAt(text, i + 1) && !isLetter(text[i - 1])) {
      startsRun = true;
      cursor = i + 1;
    }
    if (!startsRun) {
      i += 1;
      continue;
    }

    const groups: string[] = [];
    const separators: string[] = [];
    let group = '';
    let end = cursor;
    let j = cursor;
    while (j < length) {
      if (digitLikeAt(text, j)) {
        group += text[j] === 'o' || text[j] === 'O' ? '0' : (text[j] as string);
        j += 1;
        end = j;
        continue;
      }
      // a separator sequence is only part of the run when a digit follows it
      let k = j;
      let sep = '';
      while (k < length && SEPARATORS.has(text[k] as string) && sep.length < 3) {
        sep += text[k];
        k += 1;
      }
      const nonSpace = sep.replace(/[    ]/g, '');
      if (sep !== '' && nonSpace.length <= 1 && digitLikeAt(text, k)) {
        if (group !== '') groups.push(group);
        group = '';
        separators.push(sep);
        j = k;
        continue;
      }
      break;
    }
    if (group !== '') groups.push(group);
    runs.push({ start: i, end, plus, groups, separators });
    i = Math.max(end, i + 1);
  }
  return runs;
}

/** Numbers that a child legitimately types: 1000, 250000, 3 000 000. Never random enough to be an account number. */
function isRoundNumber(digits: string): boolean {
  return digits.length <= 12 && /^[1-9]\d{0,2}0{3,}$/.test(digits);
}

function isThousandsGrouped(groups: string[]): boolean {
  if (groups.length < 2) return false;
  const first = groups[0] as string;
  if (first.length < 1 || first.length > 3 || first.startsWith('0')) return false;
  return groups.slice(1).every((group) => group.length === 3);
}

/** "10 20 30 40", "2 4 6 8 10", "1 2 3 4 5 6 7 8 9 10": counting, not a phone number. */
function isProgression(groups: string[]): boolean {
  if (groups.length < 3 || groups.some((group) => group.length > 9)) return false;
  const values = groups.map((group) => Number(group));
  const step = (values[1] as number) - (values[0] as number);
  if (step === 0) return false;
  for (let i = 2; i < values.length; i += 1) {
    if ((values[i] as number) - (values[i - 1] as number) !== step) return false;
  }
  return true;
}

function isPlainDecimal(run: RawRun): boolean {
  if (run.plus || run.groups.length !== 2) return false;
  if (run.separators.length !== 1 || run.separators[0] !== '.') return false;
  const [whole, fraction] = run.groups as [string, string];
  const leadingZeroPhone = whole.length > 1 && whole.startsWith('0');
  return !leadingZeroPhone && whole.length <= 6 && fraction.length >= 1;
}

/**
 * Classifies one run. `phone` for anything that is plausibly a telephone number (10 to 13 digits, or any run
 * with a leading plus and 7 or more digits); `number` for a block of 6 or more digits in a row that is not a
 * round number, or a very long run (card-like); null for everything else.
 */
function classify(run: RawRun): DigitRunKind | null {
  const digits = run.groups.join('');
  const total = digits.length;

  if (run.plus && total >= 7) return 'phone';
  if (isPlainDecimal(run)) return null;

  const grouped = run.groups.length > 1;
  if (grouped && (isProgression(run.groups) || (isThousandsGrouped(run.groups) && total <= 15))) {
    return null;
  }
  if (total >= 10 && total <= 13) {
    if (grouped) return 'phone';
    if (isRoundNumber(digits)) return null;
    // one block: a Nigerian mobile (0803..., 803..., 234803...) is a phone, any other 10 to 13 digits an id
    return /^(?:0|234)?[789][01]\d{8}$/.test(digits) ? 'phone' : 'number';
  }
  if (total >= 14) return 'number';

  // A block of six or more digits in a row: account numbers, BVN, one-time codes, ids.
  const longest = run.groups.reduce((best, group) => (group.length > best.length ? group : best), '');
  if (longest.length >= 6 && !isRoundNumber(longest)) return 'number';
  return null;
}

/** Digit runs that look like a phone number or an id, in order, non-overlapping. */
export function findDigitRuns(text: string): DigitRun[] {
  const found: DigitRun[] = [];
  for (const run of scan(text)) {
    const kind = classify(run);
    if (kind !== null) found.push({ start: run.start, end: run.end, kind });
  }
  return found;
}
