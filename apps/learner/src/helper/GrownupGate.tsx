import { useEffect, useState, type ReactNode } from 'react';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Screen } from '../ui';
import { PinPrompt } from './PinPrompt';

/** How long a PIN checked on this phone alone (offline, no server elevation) keeps the door open. */
const LOCAL_WINDOW_MS = 10 * 60_000;

/**
 * Lets grown-ups through. Open while the server elevation is live (`elevatedUntil`, set when the PIN was entered in
 * the grown-ups area) or for 10 minutes after the PIN was checked here. When the elevation has lapsed it asks for the
 * PIN again with the same flow as the grown-ups area. A direct link to a grown-up route therefore never skips the PIN.
 */
export function GrownupGate({
  title = 'Grown-ups only',
  body = 'Enter your PIN to continue.',
  children,
}: {
  title?: string;
  body?: string;
  children: ReactNode;
}): ReactNode {
  const { elevatedUntil } = useRuntime();
  const [localUntil, setLocalUntil] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const until = Math.max(elevatedUntil ?? 0, localUntil);
  const open = until > now;

  // Close the door again when the window ends, even if nothing else re-renders.
  useEffect(() => {
    if (!open) return undefined;
    const timer = setTimeout(() => setNow(Date.now()), Math.max(0, until - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [open, until]);

  if (open) return <>{children}</>;
  return (
    <Screen>
      <PinPrompt
        title={title}
        body={body}
        submitLabel="Open"
        onVerified={() => {
          const checked = Date.now();
          setNow(checked);
          setLocalUntil(checked + LOCAL_WINDOW_MS);
        }}
      />
    </Screen>
  );
}
