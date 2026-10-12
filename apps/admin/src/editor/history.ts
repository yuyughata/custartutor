// Undo and redo for the working copy. The states are immutable values that share structure (path.ts), so keeping
// 200 of them is cheap. Consecutive edits of the same field within a short time collapse into one step, so typing a
// sentence is one undo, not forty; a different field, a structural change or a pause starts a new step.

export interface History<T> {
  past: T[];
  present: T;
  future: T[];
  /** What the last step was (a field path or an operation name) and when, for collapsing. */
  lastKey: string | null;
  lastAt: number;
}

export const HISTORY_LIMIT = 200;
export const COALESCE_MS = 1000;

export function createHistory<T>(initial: T): History<T> {
  return { past: [], present: initial, future: [], lastKey: null, lastAt: 0 };
}

/**
 * Makes `next` the present. With a `key` (the path of the field being typed in), a change that follows another
 * change of the same key within COALESCE_MS replaces the present instead of adding a step.
 */
export function push<T>(
  history: History<T>,
  next: T,
  options: { key?: string | null; now?: number } = {},
): History<T> {
  if (Object.is(next, history.present)) return history;
  const now = options.now ?? Date.now();
  const key = options.key ?? null;
  const merge =
    key !== null && key === history.lastKey && now - history.lastAt <= COALESCE_MS && history.past.length > 0;
  const past = merge ? history.past : [...history.past, history.present].slice(-HISTORY_LIMIT);
  return { past, present: next, future: [], lastKey: key, lastAt: now };
}

export function canUndo<T>(history: History<T>): boolean {
  return history.past.length > 0;
}

export function canRedo<T>(history: History<T>): boolean {
  return history.future.length > 0;
}

export function undo<T>(history: History<T>): History<T> {
  const previous = history.past[history.past.length - 1];
  if (previous === undefined) return history;
  return {
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
    lastKey: null,
    lastAt: 0,
  };
}

export function redo<T>(history: History<T>): History<T> {
  const [next, ...rest] = history.future;
  if (next === undefined) return history;
  return {
    past: [...history.past, history.present].slice(-HISTORY_LIMIT),
    present: next,
    future: rest,
    lastKey: null,
    lastAt: 0,
  };
}

/** A fresh history around `next` (loading, or restoring autosaved work). */
export function reset<T>(next: T): History<T> {
  return createHistory(next);
}
