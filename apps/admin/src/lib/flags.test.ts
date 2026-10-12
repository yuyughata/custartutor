import { describe, expect, it } from 'vitest';
import type { Flag } from '@custar/authoring-core';
import { countFlags, flagCodeLabel, flagsForWeek, severityLabel, sortFlags } from './flags';

const flags: Flag[] = [
  { code: 'a', severity: 'note', message: 'n3', week_no: 3 },
  { code: 'b', severity: 'concern', message: 'c5', week_no: 5 },
  { code: 'c', severity: 'concern', message: 'c2', week_no: 2 },
  { code: 'd', severity: 'note', message: 'n-no-week' },
  { code: 'e', severity: 'concern', message: 'c-no-week' },
];

describe('flags', () => {
  it('sorts concerns first, then by week, keeping input order for ties', () => {
    expect(sortFlags(flags).map((f) => f.message)).toEqual(['c2', 'c5', 'c-no-week', 'n3', 'n-no-week']);
  });

  it('counts by severity', () => {
    expect(countFlags(flags)).toEqual({ concerns: 3, notes: 2 });
    expect(countFlags([])).toEqual({ concerns: 0, notes: 0 });
  });

  it('filters by week', () => {
    expect(flagsForWeek(flags, 3).map((f) => f.message)).toEqual(['n3']);
    expect(flagsForWeek(flags, 9)).toEqual([]);
  });

  it('labels severity and codes', () => {
    expect(severityLabel('concern')).toBe('Concern');
    expect(severityLabel('note')).toBe('Note');
    expect(flagCodeLabel('reading_level')).toBe('Reading level');
    expect(flagCodeLabel('')).toBe('');
  });
});
