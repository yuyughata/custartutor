import { describe, expect, it } from 'vitest';
import {
  capText,
  emptyPriceRow,
  modelsMissingPrice,
  parseCap,
  pricesEqual,
  pricesFromRows,
  rowsFromPrices,
  usageRange,
  validatePriceRows,
} from './usage';

describe('usageRange', () => {
  const now = new Date('2026-10-12T15:30:00Z');
  it('covers whole UTC days up to the end of today', () => {
    expect(usageRange('7d', now)).toEqual({ from: '2026-10-06T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' });
    expect(usageRange('30d', now).from).toBe('2026-09-13T00:00:00.000Z');
    expect(usageRange('90d', now).from).toBe('2026-07-15T00:00:00.000Z');
  });
  it('starts the month on the 1st', () => {
    expect(usageRange('month', now)).toEqual({ from: '2026-10-01T00:00:00.000Z', to: '2026-10-13T00:00:00.000Z' });
  });
});

describe('price rows', () => {
  const prices = {
    'claude-opus-5-5': { input_per_mtok: 5, output_per_mtok: 25, cache_read_per_mtok: 0.5, cache_write_per_mtok: 6.25 },
  };

  it('round-trips the prices', () => {
    const rows = rowsFromPrices(prices);
    expect(rows).toEqual([{ model: 'claude-opus-5-5', input: '5', output: '25', cacheRead: '0.5', cacheWrite: '6.25' }]);
    expect(pricesFromRows(rows)).toEqual(prices);
    expect(pricesEqual(rows, prices)).toBe(true);
    expect(pricesEqual([...rows, emptyPriceRow('x')], prices)).toBe(false);
  });

  it('validates every row', () => {
    const rows = [
      emptyPriceRow(''),
      { model: 'a', input: '1', output: '2', cacheRead: '0', cacheWrite: '' },
      { model: 'b', input: '1', output: '2', cacheRead: '0', cacheWrite: '3' },
      { model: 'b', input: '1', output: '2', cacheRead: '0', cacheWrite: '3' },
      { model: 'c', input: '-1', output: '2', cacheRead: '0', cacheWrite: '3' },
    ];
    const result = validatePriceRows(rows);
    expect(result.ok).toBe(false);
    expect(result.rows[0]).toBe('Enter the model name.');
    expect(result.rows[1]).toMatch(/all four prices/);
    expect(result.rows[2]).toBeUndefined();
    expect(result.rows[3]).toBe('b is listed twice.');
    expect(result.rows[4]).toMatch(/all four prices/);
    expect(validatePriceRows([]).ok).toBe(true);
  });

  it('names the models that have no price (their cost is unknown)', () => {
    const models = { authoring: 'claude-opus-5-5', tutor: 'claude-sonnet-5-5', moderation: 'claude-sonnet-5-5' };
    expect(modelsMissingPrice(models, prices)).toEqual(['claude-sonnet-5-5']);
    expect(modelsMissingPrice(models, {})).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5']);
  });
});

describe('caps', () => {
  it('parses a cap', () => {
    expect(parseCap('')).toEqual({ value: null });
    expect(parseCap(' 2.5 ')).toEqual({ value: 2.5 });
    expect(parseCap('0').problem).toBeDefined();
    expect(parseCap('-3').problem).toBeDefined();
    expect(parseCap('lots').problem).toBeDefined();
    expect(capText(null)).toBe('');
    expect(capText(5)).toBe('5');
  });
});
