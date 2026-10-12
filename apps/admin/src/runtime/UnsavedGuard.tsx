// The "you have unsaved changes" guard. Screens with editable drafts call `useUnsavedChanges(dirty)`. While any is
// dirty, in-app navigation (links, the sidebar, router pushes made through `useGuardedRouter`) asks first, and
// the browser warns before a refresh or a closed tab. The browser's own Back button cannot be intercepted
// reliably, so it is not guarded.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { Platform } from 'react-native';
import { useRouter, type Href } from 'expo-router';
import { ConfirmDialog } from '../ui/Dialog';

interface GuardValue {
  setDirty: (id: string, dirty: boolean) => void;
  isDirty: () => boolean;
  /** Runs `proceed` now, or after the person agrees to leave. */
  confirmLeave: (proceed: () => void) => void;
}

const GuardContext = createContext<GuardValue | null>(null);

export function UnsavedGuardProvider({ children }: { children: ReactNode }): ReactNode {
  const dirtyIds = useRef(new Set<string>());
  const [pending, setPending] = useState<(() => void) | null>(null);

  const setDirty = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyIds.current.add(id);
    else dirtyIds.current.delete(id);
  }, []);
  const isDirty = useCallback(() => dirtyIds.current.size > 0, []);
  const confirmLeave = useCallback((proceed: () => void) => {
    if (dirtyIds.current.size === 0) proceed();
    else setPending(() => proceed);
  }, []);

  useEffect(() => {
    if (Platform.OS !== 'web' || typeof window === 'undefined') return undefined;
    const warn = (event: BeforeUnloadEvent): void => {
      if (dirtyIds.current.size === 0) return;
      event.preventDefault();
      // Some browsers need a return value to show their prompt.
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const value = useMemo(() => ({ setDirty, isDirty, confirmLeave }), [setDirty, isDirty, confirmLeave]);

  return (
    <GuardContext.Provider value={value}>
      {children}
      <ConfirmDialog
        visible={pending !== null}
        title="Leave without saving?"
        confirmLabel="Leave without saving"
        cancelLabel="Stay and keep editing"
        confirmVariant="danger"
        onConfirm={() => {
          const proceed = pending;
          dirtyIds.current.clear();
          setPending(null);
          proceed?.();
        }}
        onCancel={() => setPending(null)}
      >
        You have changes that have not been saved. If you leave now they will be lost.
      </ConfirmDialog>
    </GuardContext.Provider>
  );
}

function useGuard(): GuardValue {
  const value = useContext(GuardContext);
  if (!value) throw new Error('useUnsavedChanges needs UnsavedGuardProvider');
  return value;
}

/** Marks this screen as having unsaved changes while `dirty` is true. */
export function useUnsavedChanges(dirty: boolean): void {
  const guard = useGuard();
  const id = useId();
  useEffect(() => {
    guard.setDirty(id, dirty);
    return () => guard.setDirty(id, false);
  }, [guard, id, dirty]);
}

/** A router whose pushes ask before leaving a screen with unsaved changes. */
export function useGuardedRouter(): {
  push: (href: Href) => void;
  replace: (href: Href) => void;
  back: () => void;
} {
  const router = useRouter();
  const guard = useGuard();
  return useMemo(
    () => ({
      push: (href) => guard.confirmLeave(() => router.push(href)),
      replace: (href) => guard.confirmLeave(() => router.replace(href)),
      back: () =>
        guard.confirmLeave(() => (router.canGoBack() ? router.back() : router.replace('/'))),
    }),
    [guard, router],
  );
}

export function useLeaveGuard(): Pick<GuardValue, 'isDirty' | 'confirmLeave'> {
  const { isDirty, confirmLeave } = useGuard();
  return { isDirty, confirmLeave };
}
