import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Body, Screen, Title } from '../ui';
import { createRuntime } from './createRuntime';
import type { Runtime } from './types';

interface RuntimeValue {
  runtime: Runtime;
  /** The signed-in email, `null` when signed out, `undefined` while it is still being read. */
  email: string | null | undefined;
  /** Bumps whenever local data may have changed (after sync, a download or a mastery check). */
  tick: number;
  refresh: () => void;
  /** Until when grown-up elevation is live (epoch ms), or null. */
  elevatedUntil: number | null;
  setElevatedUntil: (until: number | null) => void;
}

const Context = createContext<RuntimeValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }): ReactNode {
  const [runtime, setRuntime] = useState<Runtime | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  const [tick, setTick] = useState(0);
  const [elevatedUntil, setElevatedUntil] = useState<number | null>(null);

  useEffect(() => {
    let alive = true;
    createRuntime().then(
      (created) => alive && setRuntime(created),
      (cause: unknown) => alive && setError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return undefined;
    let alive = true;
    void runtime.auth.currentEmail().then((current) => alive && setEmail(current));
    const off = runtime.auth.onChange((current) => {
      setEmail(current);
      if (current === null) setElevatedUntil(null);
    });
    return () => {
      alive = false;
      off();
    };
  }, [runtime]);

  const refresh = useCallback(() => setTick((value) => value + 1), []);
  const value = useMemo(
    () => (runtime ? { runtime, email, tick, refresh, elevatedUntil, setElevatedUntil } : null),
    [runtime, email, tick, refresh, elevatedUntil],
  );

  if (error) {
    return (
      <Screen>
        <Title>Something went wrong</Title>
        <Body>The app could not start: {error}</Body>
      </Screen>
    );
  }
  if (!value) {
    return (
      <Screen>
        <Body role="lead">Getting ready…</Body>
      </Screen>
    );
  }
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useRuntime(): RuntimeValue {
  const value = useContext(Context);
  if (!value) throw new Error('useRuntime must be used inside RuntimeProvider');
  return value;
}
