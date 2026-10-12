import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { View } from 'react-native';
import { toAdminError } from '../api/errors';
import type { AdminApi, AdminRole, AuthState } from '../api/types';
import { can, type Capability } from '../lib/roles';
import { Banner } from '../ui/Banner';
import { DemoBanner } from '../ui/DemoBanner';
import { Loading } from '../ui/States';
import { colors, space } from '../ui/theme';
import { createRuntime } from './createRuntime';
import type { AdminRuntime } from './types';

interface RuntimeValue {
  runtime: AdminRuntime;
  /** `undefined` until the first read of the session finishes. */
  auth: AuthState | undefined;
  /** Re-reads the session (after an `mfa_required` error, say). */
  recheckAuth: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Context = createContext<RuntimeValue | null>(null);

export function RuntimeProvider({ children }: { children: ReactNode }): ReactNode {
  const [runtime, setRuntime] = useState<AdminRuntime | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [auth, setAuth] = useState<AuthState | undefined>(undefined);
  const [authError, setAuthError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    createRuntime().then(
      (created) => alive && setRuntime(created),
      (cause: unknown) =>
        alive && setStartError(cause instanceof Error ? cause.message : String(cause)),
    );
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    if (!runtime) return undefined;
    let alive = true;
    const read = (): void => {
      runtime.api.auth.state().then(
        (state) => {
          if (!alive) return;
          setAuthError(null);
          setAuth(state);
        },
        (cause: unknown) => {
          if (!alive) return;
          setAuthError(toAdminError(cause).message);
          setAuth({ step: 'signed_out' });
        },
      );
    };
    read();
    const off = runtime.api.auth.subscribe((state) => alive && setAuth(state));
    return () => {
      alive = false;
      off();
    };
  }, [runtime]);

  const recheckAuth = useCallback(async () => {
    if (!runtime) return;
    try {
      setAuth(await runtime.api.auth.state());
    } catch (cause) {
      setAuthError(toAdminError(cause).message);
      setAuth({ step: 'signed_out' });
    }
  }, [runtime]);

  const signOut = useCallback(async () => {
    if (!runtime) return;
    await runtime.api.auth.signOut();
    setAuth({ step: 'signed_out' });
  }, [runtime]);

  const value = useMemo(
    () => (runtime ? { runtime, auth, recheckAuth, signOut } : null),
    [runtime, auth, recheckAuth, signOut],
  );

  if (startError) {
    return (
      <View style={{ flex: 1, padding: space[6], backgroundColor: colors.page }}>
        <Banner tone="danger" title="The admin app could not start">
          {startError}
        </Banner>
      </View>
    );
  }
  if (!value) {
    return (
      <View style={{ flex: 1, backgroundColor: colors.page, justifyContent: 'center' }}>
        <Loading label="Starting…" />
      </View>
    );
  }
  return (
    <Context.Provider value={value}>
      <View style={{ flex: 1, backgroundColor: colors.page }}>
        {value.runtime.mode === 'demo' ? (
          <DemoBanner
            role={auth?.step === 'ready' ? auth.role : null}
            onRoleChange={value.runtime.api.auth.setDemoRole?.bind(value.runtime.api.auth)}
          />
        ) : null}
        {authError ? (
          <View style={{ padding: space[3] }}>
            <Banner tone="danger" title="Could not check your sign-in">
              {authError}
            </Banner>
          </View>
        ) : null}
        <View style={{ flex: 1 }}>{children}</View>
      </View>
    </Context.Provider>
  );
}

export function useRuntime(): RuntimeValue {
  const value = useContext(Context);
  if (!value) throw new Error('useRuntime must be used inside RuntimeProvider');
  return value;
}

export function useApi(): AdminApi {
  return useRuntime().runtime.api;
}

export interface SessionInfo {
  email: string;
  userId: string;
  role: AdminRole;
}

/** The signed-in admin. Screens are only rendered after sign-in, so this is never null inside them. */
export function useSession(): SessionInfo {
  const { auth } = useRuntime();
  if (auth?.step !== 'ready') throw new Error('useSession used before sign-in finished');
  return { email: auth.email, userId: auth.userId, role: auth.role };
}

export function useCan(capability: Capability): boolean {
  const { auth } = useRuntime();
  return auth?.step === 'ready' && can(auth.role, capability);
}
