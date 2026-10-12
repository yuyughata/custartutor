import { describe, expect, it } from 'vitest';
import { ADDRESS_CASES, SCHOOL_CASES } from './cases/addresses';
import { EMAIL_CASES, HANDLE_CASES, LINK_CASES } from './cases/contact';
import { KEEP_MATHS } from './cases/keep';
import { KEEP_WITH_NAMES, KEEP_WORDS } from './cases/keepWords';
import { KNOWN_NAME_CASES, NAME_CASES } from './cases/names';
import { OBFUSCATION_CASES } from './cases/obfuscation';
import { NUMBER_CASES, PHONE_CASES } from './cases/phones';
import { redactPii } from './redact';

const REDACT_TABLES = {
  phones: PHONE_CASES,
  numbers: NUMBER_CASES,
  emails: EMAIL_CASES,
  links: LINK_CASES,
  handles: HANDLE_CASES,
  addresses: ADDRESS_CASES,
  schools: SCHOOL_CASES,
  names: NAME_CASES,
  'known names': KNOWN_NAME_CASES,
  obfuscation: OBFUSCATION_CASES,
};

const allRedact = Object.values(REDACT_TABLES).flat();
const allKeep = [
  ...KEEP_MATHS.map(([input]) => ({ input, knownNames: undefined as string[] | undefined })),
  ...KEEP_WORDS.map(([input]) => ({ input, knownNames: undefined as string[] | undefined })),
  ...KEEP_WITH_NAMES.map(([input, knownNames]) => ({ input, knownNames })),
];

describe('the tables', () => {
  it('have at least 80 cases each way', () => {
    expect(allRedact.length).toBeGreaterThanOrEqual(80);
    expect(allKeep.length).toBeGreaterThanOrEqual(80);
  });
});

describe('redactPii replaces personal data', () => {
  for (const [theme, table] of Object.entries(REDACT_TABLES)) {
    describe(theme, () => {
      it.each(table.map((row) => [row.input, row.expected, row.knownNames] as const))(
        '%s',
        (input, expected, knownNames) => {
          const result = redactPii(input, knownNames ? { knownNames } : {});
          expect(result.text).toBe(expected);
          expect(result.count).toBeGreaterThan(0);
        },
      );
    });
  }

  it('is idempotent: redacting redacted text changes nothing', () => {
    for (const row of allRedact) {
      const once = redactPii(row.input, row.knownNames ? { knownNames: row.knownNames } : {});
      const twice = redactPii(once.text, row.knownNames ? { knownNames: row.knownNames } : {});
      expect(twice.text, row.input).toBe(once.text);
      expect(twice.count, row.input).toBe(0);
    }
  });
});

describe('redactPii leaves lesson content and ordinary talk alone', () => {
  it.each(allKeep.map((row) => [row.input, row.knownNames] as const))('%s', (input, knownNames) => {
    const result = redactPii(input, knownNames ? { knownNames } : {});
    expect(result.text).toBe(input);
    expect(result.count).toBe(0);
    expect(result.kinds).toEqual([]);
  });
});

describe('redactPii bookkeeping', () => {
  it('counts replaced spans and lists the kinds in order of appearance', () => {
    const result = redactPii('call 0800 000 0000 or name@example.com or 0900 000 0000');
    expect(result.count).toBe(3);
    expect(result.kinds).toEqual(['email', 'phone']);
  });

  it('can be restricted to some kinds', () => {
    const text = 'my name is Testa and my number is 0800 000 0000';
    expect(redactPii(text, { kinds: ['phone'] }).text).toBe(
      'my name is Testa and my number is [phone]',
    );
    expect(redactPii(text, { kinds: ['name'] }).text).toBe(
      'my name is [name] and my number is 0800 000 0000',
    );
  });

  it('never throws on odd input', () => {
    for (const text of ['', ' ', '\n\n', '😀😀😀', '[[[[', '((((', '+', '@', '...', '\u0000']) {
      expect(() => redactPii(text, { knownNames: ['', ' ', '.*'] })).not.toThrow();
    }
  });

  it('treats known names as literal text, not as a pattern', () => {
    const result = redactPii('anything at all', { knownNames: ['.*', '(a|b)+', '['] });
    expect(result.text).toBe('anything at all');
  });
});
