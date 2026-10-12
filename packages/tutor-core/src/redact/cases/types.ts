// Shared shape of the redaction case tables. All personal data in the tables is obviously fake.
export interface RedactCase {
  input: string;
  expected: string;
  knownNames?: string[];
}

export type RedactRow = [input: string, expected: string, knownNames?: string[]];

export function rows(table: RedactRow[]): RedactCase[] {
  return table.map(([input, expected, knownNames]) => ({
    input,
    expected,
    ...(knownNames ? { knownNames } : {}),
  }));
}

/** Text that must pass through unchanged (optionally with known names configured). */
export type KeepRow = [input: string, knownNames?: string[]];
