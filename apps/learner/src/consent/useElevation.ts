import { useCallback, useState } from 'react';
import { useRuntime } from '../runtime/RuntimeProvider';

/**
 * Whether a live grown-up elevation is in force, for screens that read transcripts or turn the tutor on.
 * `needsPin` is true when there is none, or the server said the one we had has lapsed: the screen then shows the
 * PIN gate. Check again at the moment of each action with `ensure`, because an elevation ends after minutes.
 */
export function useElevation() {
  const { elevatedUntil } = useRuntime();
  // The elevation (by its end time) that the server or the clock showed to be over.
  const [lapsedFor, setLapsedFor] = useState<number | null | undefined>(undefined);
  const live = elevatedUntil !== null && elevatedUntil > Date.now();
  // A fresh elevation has a different end time, so it clears the lapse by itself.
  const needsPin = !live || lapsedFor === elevatedUntil;

  /** True when an action that needs the elevation may go ahead; otherwise opens the gate. */
  const ensure = useCallback((): boolean => {
    if (elevatedUntil !== null && elevatedUntil > Date.now()) return true;
    setLapsedFor(elevatedUntil);
    return false;
  }, [elevatedUntil]);

  /** The server refused with `elevation_required`. */
  const markLapsed = useCallback(() => setLapsedFor(elevatedUntil), [elevatedUntil]);

  return { needsPin, ensure, markLapsed };
}
