import { useSyncExternalStore } from 'react';

/**
 * The read-aloud speed setting. Two speeds are enough for a grown-up to choose between: a child who cannot read
 * yet starts on SLOW (young listeners follow slower speech), everyone else on NORMAL. `1` is the engine's normal rate.
 *
 * NOT PERSISTED: learner-core has no general settings store yet (its `meta` table takes only its own typed keys),
 * so the choice lives in memory and returns to the default when the app restarts. If the owner wants it kept,
 * learner-core needs a `META` key for it (see the work-package report); this module is the only place to change.
 */
export type SpeedChoice = 'slow' | 'normal';

export const SPEED_RATES: Record<SpeedChoice, number> = { slow: 0.7, normal: 1 };

export const SPEED_LABELS: Record<SpeedChoice, string> = {
  slow: 'Slow',
  normal: 'Normal',
};

/** What a child gets when the grown-up has chosen nothing: pre-readers slow, everybody else normal. */
export function defaultSpeed(readingMode: string | null | undefined): SpeedChoice {
  return readingMode === 'pre_reader' ? 'slow' : 'normal';
}

/** The engine rate to use: the grown-up's choice, or the default for the child's reading mode. */
export function resolveRate(
  choice: SpeedChoice | null,
  readingMode: string | null | undefined,
): number {
  return SPEED_RATES[choice ?? defaultSpeed(readingMode)];
}

export interface SpeedStore {
  get(): SpeedChoice | null;
  set(choice: SpeedChoice | null): void;
  subscribe(listener: () => void): () => void;
}

/** A tiny observable value. `null` means "no choice made: use the default for the child". */
export function createSpeedStore(initial: SpeedChoice | null = null): SpeedStore {
  let value = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(choice) {
      if (choice === value) return;
      value = choice;
      for (const listener of [...listeners]) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The app-wide store (in memory, see above). */
export const readAloudSpeed: SpeedStore = createSpeedStore();

/** The grown-up's speed choice (or null for "default") and a setter. */
export function useSpeedChoice(
  store: SpeedStore = readAloudSpeed,
): [SpeedChoice | null, (choice: SpeedChoice | null) => void] {
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  return [value, store.set];
}
