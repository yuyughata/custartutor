import { useState } from 'react';
import { Body, Button, Card, ErrorText, TextField } from '../ui';
import { useRuntime } from '../runtime/RuntimeProvider';

/**
 * Asks for the grown-up PIN again when the elevation (about 10 minutes, ADR 0002) has lapsed or was never
 * confirmed. Same steps as the grown-ups dashboard: check the PIN on this phone, then have the server confirm it.
 * The server check is the real control; the PIN is never kept.
 */
export function ElevationGate({ reason }: { reason: string }) {
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
        setElevatedUntil(null);
        setError('We could not confirm your PIN with the server. This needs the internet.');
      }
    } catch {
      setError('Something went wrong. Please try again.');
    } finally {
      setBusy(false);
      setPin('');
    }
  }

  return (
    <Card tone="core">
      <Body role="lead">Enter your PIN</Body>
      <Body>{reason}</Body>
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
      <Button label="Open" onPress={submit} busy={busy} disabled={pin.length < 4} />
    </Card>
  );
}
