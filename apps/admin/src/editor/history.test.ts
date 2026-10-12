import { describe, expect, it } from 'vitest';
import {
  COALESCE_MS,
  HISTORY_LIMIT,
  canRedo,
  canUndo,
  createHistory,
  push,
  redo,
  reset,
  undo,
} from './history';

describe('history', () => {
  it('undoes and redoes whole steps', () => {
    let h = createHistory('a');
    h = push(h, 'b', { now: 0 });
    h = push(h, 'c', { now: 10_000 });
    expect(h.present).toBe('c');
    h = undo(h);
    expect(h.present).toBe('b');
    h = undo(h);
    expect(h.present).toBe('a');
    expect(canUndo(h)).toBe(false);
    expect(undo(h)).toBe(h);
    h = redo(h);
    expect(h.present).toBe('b');
    expect(canRedo(h)).toBe(true);
    h = redo(redo(h));
    expect(h.present).toBe('c');
    expect(redo(h)).toBe(h);
  });

  it('a new edit after an undo drops the redo branch', () => {
    let h = createHistory(0);
    h = push(h, 1, { now: 0 });
    h = push(h, 2, { now: 5000 });
    h = undo(h);
    h = push(h, 3, { now: 9000 });
    expect(canRedo(h)).toBe(false);
    expect(h.present).toBe(3);
  });

  it('typing in one field collapses into one step; another field or a pause starts a new one', () => {
    let h = createHistory('');
    h = push(h, 'h', { key: 'heading', now: 0 });
    h = push(h, 'he', { key: 'heading', now: 200 });
    h = push(h, 'hel', { key: 'heading', now: 400 });
    expect(h.past).toHaveLength(1);
    h = push(h, 'helX', { key: 'objective', now: 600 });
    expect(h.past).toHaveLength(2);
    h = push(h, 'helXY', { key: 'objective', now: 600 + COALESCE_MS + 1 });
    expect(h.past).toHaveLength(3);
    h = undo(h);
    expect(h.present).toBe('helX');
    h = undo(undo(h));
    expect(h.present).toBe('');
  });

  it('keeps at least 100 steps (200 by design) and never grows past that', () => {
    expect(HISTORY_LIMIT).toBeGreaterThanOrEqual(100);
    let h = createHistory(0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i += 1) h = push(h, i, { now: i * 10_000 });
    expect(h.past).toHaveLength(HISTORY_LIMIT);
    for (let i = 0; i < 100; i += 1) h = undo(h);
    expect(h.present).toBe(HISTORY_LIMIT + 50 - 100);
  });

  it('ignores a change to the same value and can be reset', () => {
    const h = createHistory({ a: 1 });
    expect(push(h, h.present)).toBe(h);
    expect(reset('x').present).toBe('x');
    expect(canUndo(reset('x'))).toBe(false);
  });
});
