// Display formatting: dates, relative times, tokens and money. Pure, with an injectable clock and time zone so
// the tests do not depend on where they run.

export interface DateOptions {
  /** IANA zone; defaults to the browser's. Tests pass 'UTC'. */
  timeZone?: string;
}

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** "12 Oct 2026, 14:05". Returns an en dash for a missing or invalid value. */
export function formatDateTime(iso: string | null | undefined, options: DateOptions = {}): string {
  const date = parse(iso);
  if (!date) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

/** "12 Oct 2026". */
export function formatDate(iso: string | null | undefined, options: DateOptions = {}): string {
  const date = parse(iso);
  if (!date) return '–';
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    ...(options.timeZone ? { timeZone: options.timeZone } : {}),
  }).format(date);
}

/** "just now", "5 min ago", "3 h ago", "2 days ago"; older than 30 days falls back to the date. */
export function formatRelative(
  iso: string | null | undefined,
  now: Date = new Date(),
  options: DateOptions = {},
): string {
  const date = parse(iso);
  if (!date) return '–';
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (seconds < -60) return formatDateTime(iso, options);
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days <= 30) return `${days} day${days === 1 ? '' : 's'} ago`;
  return formatDate(iso, options);
}

/** 1234567 -> "1,234,567". */
export function formatCount(value: number): string {
  return new Intl.NumberFormat('en-GB').format(value);
}

/** 1234 -> "1.2k", 2_500_000 -> "2.5M"; small numbers stay exact. */
export function formatTokens(value: number): string {
  if (value >= 1_000_000) return `${trim1(value / 1_000_000)}M`;
  if (value >= 10_000) return `${trim1(value / 1000)}k`;
  return formatCount(value);
}

function trim1(value: number): string {
  return value.toFixed(1).replace(/\.0$/, '');
}

/**
 * Money for the usage panel. A null cost means "no price was entered for the model": that is shown as
 * "unknown" and never as 0, because 0 would read as "free".
 */
export function formatUsd(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return 'unknown';
  if (value === 0) return '$0.00';
  if (Math.abs(value) < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

/** Cost with a hint when only some of the calls were priced. */
export function formatCost(value: number | null | undefined, unpricedCalls = 0): string {
  const base = formatUsd(value);
  if (base === 'unknown') return base;
  return unpricedCalls > 0 ? `${base}+ (${unpricedCalls} unpriced)` : base;
}

/** 83_000 -> "1 min 23 s"; under a second "<1 s". */
export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1 s';
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return minutes === 0 ? `${seconds} s` : `${minutes} min ${seconds} s`;
}

export function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${formatCount(count)} ${count === 1 ? singular : plural}`;
}

/** First 8 characters of an id, for places where a full uuid would be noise. */
export function shortId(id: string | null | undefined): string {
  return id ? id.slice(0, 8) : '–';
}
