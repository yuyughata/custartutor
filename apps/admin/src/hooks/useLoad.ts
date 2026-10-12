import { useCallback, useEffect, useRef, useState } from 'react';
import { toAdminError, type AdminApiError } from '../api/errors';

export interface LoadState<T> {
  data: T | undefined;
  error: AdminApiError | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Runs `loader` when `deps` change and again on `reload()`. Late answers from an older request are ignored,
 * and nothing is set after the screen has gone. The previous data stays visible while a reload is running.
 */
export function useLoad<T>(loader: () => Promise<T>, deps: readonly unknown[]): LoadState<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<AdminApiError | null>(null);
  const [loading, setLoading] = useState(true);
  const [tick, setTick] = useState(0);
  const latest = useRef(0);
  const loaderRef = useRef(loader);
  loaderRef.current = loader;

  useEffect(() => {
    const request = latest.current + 1;
    latest.current = request;
    setLoading(true);
    loaderRef.current().then(
      (value) => {
        if (latest.current !== request) return;
        setData(value);
        setError(null);
        setLoading(false);
      },
      (cause: unknown) => {
        if (latest.current !== request) return;
        setError(toAdminError(cause));
        setLoading(false);
      },
    );
    return () => {
      // A newer request (or an unmount) makes this answer stale.
      if (latest.current === request) latest.current = request + 1;
    };
  }, [...deps, tick]);

  const reload = useCallback(() => setTick((value) => value + 1), []);
  return { data, error, loading, reload };
}
