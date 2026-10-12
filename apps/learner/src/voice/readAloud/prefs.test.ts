import { describe, expect, it } from 'vitest';
import { SPEED_RATES, createSpeedStore, defaultSpeed, resolveRate } from './prefs';

describe('read-aloud speed', () => {
  it('starts pre-readers slower than everybody else', () => {
    expect(defaultSpeed('pre_reader')).toBe('slow');
    expect(defaultSpeed('reader')).toBe('normal');
    expect(defaultSpeed(null)).toBe('normal');
    expect(resolveRate(null, 'pre_reader')).toBeLessThan(resolveRate(null, 'reader'));
    expect(resolveRate(null, 'reader')).toBe(1);
  });

  it('lets a grown-up override the default in either direction', () => {
    expect(resolveRate('normal', 'pre_reader')).toBe(SPEED_RATES.normal);
    expect(resolveRate('slow', 'reader')).toBe(SPEED_RATES.slow);
  });

  it('keeps the choice in a store that notifies subscribers once per change', () => {
    const store = createSpeedStore();
    let calls = 0;
    const off = store.subscribe(() => {
      calls += 1;
    });
    expect(store.get()).toBeNull();
    store.set('slow');
    store.set('slow'); // no change, no notification
    expect(store.get()).toBe('slow');
    expect(calls).toBe(1);
    off();
    store.set('normal');
    expect(calls).toBe(1);
  });
});
