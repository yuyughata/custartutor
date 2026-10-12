import { useCallback, useEffect, useRef, useState } from 'react';
import { toAdminError, type AdminApiError } from '../api/errors';

export interface ActionState<A extends unknown[], R> {
  /** Runs the action. Resolves with its result, or `undefined` if it failed (the error is in `error`). */
  run: (...args: A) => Promise<R | undefined>;
  busy: boolean;
  error: AdminApiError | null;
  clearError: () => void;
}

/**
 * Wraps a mutation: tracks `busy`, keeps the typed error, and never throws into the screen. Callers must
 * only claim success after `run` resolved with a value: that is the "nothing is saved until the RPC
 * resolved" rule.
 */
export function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R>): ActionState<A, R> {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<AdminApiError | null>(null);
  const alive = useRef(true);
  const actionRef = useRef(action);
  actionRef.current = action;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async (...args: A): Promise<R | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await actionRef.current(...args);
    } catch (cause) {
      if (alive.current) setError(toAdminError(cause));
      return undefined;
    } finally {
      if (alive.current) setBusy(false);
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  return { run, busy, error, clearError };
}
