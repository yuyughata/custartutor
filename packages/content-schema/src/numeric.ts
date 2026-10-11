/**
 * Exact numeric matching for answers such as "12", "0.5", "1/2", "1,000" and "1 1/2".
 *
 * Numbers are parsed into exact rationals (BigInt numerator and denominator) and compared by value.
 * There is NO edit distance anywhere in this module: "12" never matches "21", and "0.5" matches "1/2"
 * because they are the same number, not because they look alike.
 *
 * Accepted notations:
 *  - integers and decimals: "12", "0.5", ".5", "05"
 *  - thousands separators: "1,000" or "1 000" (groups of exactly three digits), "1,234.50"
 *  - fractions: "1/2", "3 / 4"; mixed numbers: "1 1/2"
 *  - vulgar fractions: "½", "¾", "1½"
 *  - a leading "+" or "-" (also the Unicode minus sign)
 *  - optional unit words or symbols before or after the number, only when listed in `units`
 *    (for example ["naira", "₦"] so that "₦5" and "5 naira" both read as 5)
 * Not accepted (returns null): a decimal comma ("0,5"), exponents, anything else.
 */

export interface Rational {
  /** Numerator (carries the sign). */
  n: bigint;
  /** Denominator, always greater than zero. */
  d: bigint;
}

const VULGAR: Record<string, readonly [number, number]> = {
  '½': [1, 2],
  '⅓': [1, 3],
  '⅔': [2, 3],
  '¼': [1, 4],
  '¾': [3, 4],
  '⅕': [1, 5],
  '⅖': [2, 5],
  '⅗': [3, 5],
  '⅘': [4, 5],
  '⅙': [1, 6],
  '⅚': [5, 6],
  '⅛': [1, 8],
  '⅜': [3, 8],
  '⅝': [5, 8],
  '⅞': [7, 8],
};

const MAX_LENGTH = 40;

function gcd(a: bigint, b: bigint): bigint {
  let x = a < 0n ? -a : a;
  let y = b < 0n ? -b : b;
  while (y !== 0n) {
    [x, y] = [y, x % y];
  }
  return x;
}

function rational(n: bigint, d: bigint): Rational | null {
  if (d === 0n) return null;
  const sign = d < 0n ? -1n : 1n;
  const divisor = gcd(n, d) || 1n;
  return { n: (sign * n) / divisor, d: (sign * d) / divisor };
}

function add(a: Rational, b: Rational): Rational | null {
  return rational(a.n * b.d + b.n * a.d, a.d * b.d);
}

function stripUnits(input: string, units: readonly string[]): string {
  let value = input;
  const ordered = [...units]
    .map((u) => u.normalize('NFC').toLowerCase())
    .sort((a, b) => b.length - a.length);
  for (const unit of ordered) {
    if (unit === '') continue;
    const lower = value.toLowerCase();
    if (lower.startsWith(unit)) {
      const rest = value.slice(unit.length).trim();
      if (/^[-+\d.]/.test(rest) || (rest !== '' && VULGAR[rest.charAt(0)] !== undefined)) {
        value = rest;
        break;
      }
    }
    if (lower.endsWith(unit)) {
      const rest = value.slice(0, value.length - unit.length);
      if (rest !== '' && /[\d\s.]$|[½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞]$/.test(rest)) {
        value = rest.trim();
        break;
      }
    }
  }
  return value;
}

function parseUnsigned(body: string): Rational | null {
  // vulgar fraction, optionally after a whole number: "½", "1½", "1 ½"
  const vulgar = /^(?:(\d+)\s*)?([½⅓⅔¼¾⅕⅖⅗⅘⅙⅚⅛⅜⅝⅞])$/u.exec(body);
  if (vulgar) {
    const pair = VULGAR[vulgar[2] ?? ''];
    if (!pair) return null;
    const fraction = rational(BigInt(pair[0]), BigInt(pair[1]));
    if (!fraction) return null;
    return vulgar[1] === undefined ? fraction : add({ n: BigInt(vulgar[1]), d: 1n }, fraction);
  }
  // mixed number: "1 1/2"
  const mixed = /^(\d+)\s+(\d+)\s*\/\s*(\d+)$/.exec(body);
  if (mixed) {
    const fraction = rational(BigInt(mixed[2] ?? '0'), BigInt(mixed[3] ?? '0'));
    if (!fraction) return null;
    return add({ n: BigInt(mixed[1] ?? '0'), d: 1n }, fraction);
  }
  // fraction: "1/2"
  const fraction = /^(\d+)\s*\/\s*(\d+)$/.exec(body);
  if (fraction) {
    return rational(BigInt(fraction[1] ?? '0'), BigInt(fraction[2] ?? '0'));
  }
  // integer or decimal, with optional thousands separators
  let decimal = body;
  const grouped = /^\d{1,3}(?:([, ])\d{3}(?:\1\d{3})*)(\.\d+)?$/.exec(body);
  if (grouped) {
    decimal = body.replace(/[, ]/g, '');
  }
  const plain = /^(\d*)(?:\.(\d+))?$/.exec(decimal);
  if (plain && (plain[1] !== '' || plain[2] !== undefined)) {
    const whole = plain[1] ?? '';
    const frac = plain[2] ?? '';
    const digits = BigInt(`${whole}${frac}` || '0');
    return rational(digits, 10n ** BigInt(frac.length));
  }
  return null;
}

/** Parses a numeric answer into an exact rational, or returns null when it is not a number. */
export function parseNumeric(
  input: string,
  options: { units?: readonly string[] } = {},
): Rational | null {
  let value = input
    .normalize('NFC')
    .replace(/[−‒–]/g, '-')
    .replace(/\s+/g, ' ') // \s also covers no-break, narrow no-break and thin spaces
    .trim();
  if (value.length === 0 || value.length > MAX_LENGTH) return null;
  value = value.replace(/[.!?,;:\s]+$/, '');
  if (options.units && options.units.length > 0) {
    value = stripUnits(value, options.units).replace(/[.!?,;:\s]+$/, '');
  }
  let sign = 1n;
  if (value.startsWith('-') || value.startsWith('+')) {
    sign = value.startsWith('-') ? -1n : 1n;
    value = value.slice(1);
  }
  const parsed = parseUnsigned(value);
  if (!parsed) return null;
  return { n: sign * parsed.n, d: parsed.d };
}

/** True when two rationals are exactly the same number. */
export function rationalEquals(a: Rational, b: Rational): boolean {
  return a.n * b.d === b.n * a.d;
}

/**
 * True when the response and the expected answer are both numbers and equal in value.
 * Returns false (never a fuzzy match) when either side is not a number.
 */
export function numbersMatch(
  response: string,
  expected: string,
  options: { units?: readonly string[] } = {},
): boolean {
  const left = parseNumeric(response, options);
  const right = parseNumeric(expected, options);
  return left !== null && right !== null && rationalEquals(left, right);
}
