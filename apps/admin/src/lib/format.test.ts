import { describe, expect, it } from 'vitest';
import {
  formatCost,
  formatCount,
  formatDate,
  formatDateTime,
  formatDuration,
  formatRelative,
  formatTokens,
  formatUsd,
  pluralize,
  shortId,
} from './format';

const utc = { timeZone: 'UTC' };

describe('dates', () => {
  it('formats a date and time in the given zone', () => {
    expect(formatDateTime('2026-10-12T14:05:00Z', utc)).toBe('12 Oct 2026, 14:05');
    expect(formatDateTime('2026-10-12T14:05:00Z', { timeZone: 'Africa/Lagos' })).toBe('12 Oct 2026, 15:05');
    expect(formatDate('2026-01-03T23:30:00Z', utc)).toBe('3 Jan 2026');
  });

  it('shows an en dash for a missing or invalid date', () => {
    expect(formatDateTime(null)).toBe('–');
    expect(formatDateTime('not a date')).toBe('–');
    expect(formatRelative(undefined)).toBe('–');
  });

  it('formats relative times', () => {
    const now = new Date('2026-10-12T12:00:00Z');
    expect(formatRelative('2026-10-12T11:59:40Z', now)).toBe('just now');
    expect(formatRelative('2026-10-12T11:55:00Z', now)).toBe('5 min ago');
    expect(formatRelative('2026-10-12T09:00:00Z', now)).toBe('3 h ago');
    expect(formatRelative('2026-10-10T12:00:00Z', now)).toBe('2 days ago');
    expect(formatRelative('2026-10-11T12:00:00Z', now)).toBe('1 day ago');
    expect(formatRelative('2026-08-01T12:00:00Z', now, utc)).toBe('1 Aug 2026');
    expect(formatRelative('2026-10-12T13:00:00Z', now, utc)).toBe('12 Oct 2026, 13:00');
  });
});

describe('numbers', () => {
  it('formats counts and tokens', () => {
    expect(formatCount(1234567)).toBe('1,234,567');
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(9_999)).toBe('9,999');
    expect(formatTokens(12_400)).toBe('12.4k');
    expect(formatTokens(2_000_000)).toBe('2M');
    expect(formatTokens(2_560_000)).toBe('2.6M');
  });

  it('never shows an unpriced cost as zero', () => {
    expect(formatUsd(null)).toBe('unknown');
    expect(formatUsd(undefined)).toBe('unknown');
    expect(formatUsd(Number.NaN)).toBe('unknown');
    expect(formatUsd(0)).toBe('$0.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(12.5)).toBe('$12.50');
  });

  it('flags a partly priced total', () => {
    expect(formatCost(null, 3)).toBe('unknown');
    expect(formatCost(1.2, 0)).toBe('$1.20');
    expect(formatCost(1.2, 4)).toBe('$1.20+ (4 unpriced)');
  });

  it('formats durations, plurals and short ids', () => {
    expect(formatDuration(400)).toBe('<1 s');
    expect(formatDuration(8_000)).toBe('8 s');
    expect(formatDuration(83_000)).toBe('1 min 23 s');
    expect(pluralize(1, 'unit')).toBe('1 unit');
    expect(pluralize(0, 'unit')).toBe('0 units');
    expect(pluralize(2, 'child', 'children')).toBe('2 children');
    expect(shortId('0b5c0004-0000-4000-8000-000000000003')).toBe('0b5c0004');
    expect(shortId(null)).toBe('–');
  });
});
