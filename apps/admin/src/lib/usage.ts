// Pure helpers for the usage and settings screen: date ranges, price rows and caps.
import type { AiSettings, LlmModels } from '@custar/authoring-core';

export type RangePreset = '7d' | '30d' | '90d' | 'month';

export const RANGE_LABELS: Record<RangePreset, string> = {
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  month: 'This month',
};

/** UTC day boundaries; `to` is exclusive (the start of tomorrow), so today's calls are included. */
export function usageRange(preset: RangePreset, now: Date = new Date()): { from: string; to: string } {
  const dayStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const to = new Date(dayStart + 86_400_000);
  let from: Date;
  if (preset === 'month') from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  else {
    const days = preset === '7d' ? 7 : preset === '30d' ? 30 : 90;
    from = new Date(dayStart - (days - 1) * 86_400_000);
  }
  return { from: from.toISOString(), to: to.toISOString() };
}

export interface PriceRow {
  model: string;
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
}

export function emptyPriceRow(model = ''): PriceRow {
  return { model, input: '', output: '', cacheRead: '', cacheWrite: '' };
}

export function rowsFromPrices(prices: AiSettings['prices']): PriceRow[] {
  return Object.entries(prices).map(([model, price]) => ({
    model,
    input: String(price.input_per_mtok),
    output: String(price.output_per_mtok),
    cacheRead: String(price.cache_read_per_mtok),
    cacheWrite: String(price.cache_write_per_mtok),
  }));
}

function parseAmount(text: string): number | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  const value = Number(trimmed);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

export interface PriceProblems {
  /** Row index -> message. */
  rows: Record<number, string>;
  ok: boolean;
}

export function validatePriceRows(rows: readonly PriceRow[]): PriceProblems {
  const problems: Record<number, string> = {};
  const seen = new Set<string>();
  rows.forEach((row, index) => {
    const model = row.model.trim();
    if (model === '') problems[index] = 'Enter the model name.';
    else if (seen.has(model)) problems[index] = `${model} is listed twice.`;
    else if (
      [row.input, row.output, row.cacheRead, row.cacheWrite].some((value) => parseAmount(value) === null)
    ) {
      problems[index] = 'Enter all four prices as numbers of 0 or more (US dollars per million tokens).';
    }
    seen.add(model);
  });
  return { rows: problems, ok: Object.keys(problems).length === 0 };
}

/** The `ai.prices` value. Call only when `validatePriceRows` is ok. */
export function pricesFromRows(rows: readonly PriceRow[]): AiSettings['prices'] {
  const out: AiSettings['prices'] = {};
  for (const row of rows) {
    out[row.model.trim()] = {
      input_per_mtok: parseAmount(row.input) ?? 0,
      output_per_mtok: parseAmount(row.output) ?? 0,
      cache_read_per_mtok: parseAmount(row.cacheRead) ?? 0,
      cache_write_per_mtok: parseAmount(row.cacheWrite) ?? 0,
    };
  }
  return out;
}

export function pricesEqual(rows: readonly PriceRow[], prices: AiSettings['prices']): boolean {
  const a = rowsFromPrices(prices);
  return JSON.stringify(a) === JSON.stringify(rows.map((row) => ({ ...row, model: row.model.trim() })));
}

/** Models in use that have no price entered: their cost is shown as "unknown". */
export function modelsMissingPrice(models: LlmModels, prices: AiSettings['prices']): string[] {
  return [...new Set(Object.values(models))].filter((model) => prices[model] === undefined);
}

export interface CapParse {
  value: number | null;
  problem?: string;
}

/** A spending cap: empty means no cap; otherwise a number above 0. */
export function parseCap(text: string): CapParse {
  const trimmed = text.trim();
  if (trimmed === '') return { value: null };
  const value = Number(trimmed);
  if (!Number.isFinite(value) || value <= 0) return { value: null, problem: 'Enter an amount above 0, or leave it empty for no cap.' };
  return { value };
}

export function capText(value: number | null): string {
  return value === null ? '' : String(value);
}
