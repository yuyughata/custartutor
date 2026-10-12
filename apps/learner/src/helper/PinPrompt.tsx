import { useState, type ReactNode } from 'react';
import { View } from 'react-native';
import { space } from '@custar/design-tokens';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, TextField, Title } from '../ui';

/**
 * Asks for the grown-up PIN. The same check as the grown-ups area (apps/learner/src/app/grownups.tsx): the local
 * gate first (works offline, with its lockout), then the server elevation, which is the real control (ADR 0002). Offline
 * the elevation fails and the local check alone opens the door, exactly as in the grown-ups area.
 */
export function PinPrompt({
  title,
  body,
  submitLabel,
  onVerified,
  onCancel,
  cancelLabel = 'Cancel',
}: {
  title: string;
  body: string;
  submitLabel: string;
  onVerified: () => void;
  onCancel?: () => void;
  cancelLabel?: string;
}): ReactNode {
  const { runtime, setElevatedUntil } = useRuntime();
  const [pin, setPin] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const lock = await runtime.pin.lockStatus();
      if (lock.locked) {
        setError(`Too many tries. Wait ${Math.ceil(lock.retryAfterMs / 1000)} seconds.`);
        return;
      }
      if (!(await runtime.pin.verifyLocal(pin))) {
        setError('That PIN is not right.');
        return;
      }
      try {
        const elevation = await runtime.pin.elevate(pin);
        setElevatedUntil(elevation.expires_at_ms);
      } catch {
        // Offline or the server said no: the local check already passed, as in the grown-ups area.
      }
      onVerified();
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  return (
    <View style={{ gap: space[4] }}>
      <Title>{title}</Title>
      <Body>{body}</Body>
      <TextField
        label="Grown-up PIN"
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={6}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      {runtime.demoHint ? <Body muted>Demo PIN: {runtime.demoHint.pin}</Body> : null}
      <Button label={submitLabel} onPress={submit} busy={busy} disabled={pin.length < 4} />
      {onCancel ? <Button label={cancelLabel} variant="ghost" onPress={onCancel} /> : null}
    </View>
  );
}
