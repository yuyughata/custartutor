import { createContext, useContext } from 'react';

/**
 * The integration point for anything that wants to know a HELPER (a grown-up beside a child who cannot read yet) is
 * present. The helper lesson screen provides it; a component anywhere inside reads it with `useHelperPresent()`.
 *
 *   const helperPresent = useHelperPresent();   // true only inside a helper session
 *
 * Intended use: the tutor panel (M3.3a) can show that "your helper can type for you" and let the helper type the
 * child's reply when `helperPresent` is true. It is LOCAL UI STATE ONLY: it is never sent to the server, never part
 * of an event, and never changes grading or mastery.
 */
export interface HelperPresence {
  helperPresent: true;
  childId: string;
  unitId: string;
  /** The child's `reading_mode`. */
  readingMode: string;
  /** The section on screen, or null on the get-ready or result pages. */
  sectionId: string | null;
}

export const HelperPresenceContext = createContext<HelperPresence | null>(null);

/** The presence details inside a helper session, or null everywhere else. */
export function useHelperPresence(): HelperPresence | null {
  return useContext(HelperPresenceContext);
}

/** True only inside a helper session. */
export function useHelperPresent(): boolean {
  return useContext(HelperPresenceContext) !== null;
}
