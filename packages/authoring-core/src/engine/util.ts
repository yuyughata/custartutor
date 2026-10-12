// Small pure helpers shared by the engine. No I/O, no Node built-ins.
import type { Json } from '../contract';

/** JSON round trip: a deep, plain copy that is safe to store in `state.outputs`. */
export function toJson<T>(value: T): Json {
  return JSON.parse(JSON.stringify(value)) as Json;
}

export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** NFC, trimmed. Used on every string a model returns. */
export function clean(value: string): string {
  return value.normalize('NFC').replace(/\r\n?/g, '\n').trim();
}

export function cleanAll(values: readonly string[]): string[] {
  return values.map(clean).filter((value) => value !== '');
}

/** JSON with sorted keys, for equality checks and diffs. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = sortKeys(value[key]);
    }
    return out;
  }
  return value;
}

export function sameJson(a: unknown, b: unknown): boolean {
  return stableStringify(a) === stableStringify(b);
}

/** `a_b-c d` -> `a_b_c_d`; lowercase; only [a-z0-9_]. Empty when nothing usable is left. */
export function toSnake(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/** `Solar System!` -> `solar-system`. Empty when nothing usable is left. */
export function toSlug(value: string): string {
  return toSnake(value).replace(/_/g, '-');
}

/** A tag for `skill_tag`: `^[a-z][a-z0-9_.-]{1,63}$`, or undefined when the text cannot be made into one. */
export function toSkillTag(value: string): string | undefined {
  const tag = toSnake(value).slice(0, 60).replace(/_+$/g, '');
  return /^[a-z][a-z0-9_.-]{1,63}$/.test(tag) ? tag : undefined;
}

/** Whole-word, English ordinal for small counts, used in generated text ("Two 60-minute periods"). */
export function wordForCount(n: number): string {
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];
  return words[n] ?? String(n);
}

export function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

/** Redacts e-mail addresses and phone-like digit runs from free text an admin typed, before it reaches a model. */
export function redactPii(text: string): string {
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email removed]')
    .replace(/(?<![\d.])(?:\+?\d[\d\s().-]{7,}\d)(?![\d.])/g, (match) =>
      match.replace(/\D/g, '').length >= 9 ? '[number removed]' : match,
    );
}

/** Removes anything that looks like an API key from text that is about to be echoed back to a model. */
export function scrubSecrets(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[secret removed]');
}

export function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[... cut ...]`;
}

/** A mutable slot for a value a `check` callback computes, so the step can use it after the call. */
export interface Slot<T> {
  value: T | null;
}

export function slot<T>(): Slot<T> {
  return { value: null };
}
