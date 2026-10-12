import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, Screen, TextField, Title } from '../ui';

/**
 * First-time PIN creation, or (on a new phone for a guardian who already has a PIN) entering the existing
 * one to set this phone up. The PIN is checked by the server; this screen never stores it.
 */
export default function SetPin() {
  const { runtime } = useRuntime();
  const router = useRouter();
  const [existing, setExisting] = useState<boolean | null>(null);
  const [pin, setPin] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void runtime.households
      .pinStatus()
      .then((status) => setExisting(status.hasPin))
      .catch(() => setExisting(false));
  }, [runtime]);

  const valid = /^\d{4,6}$/.test(pin) && (existing === true || pin === confirm);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (existing) await runtime.pin.adoptServerPin(pin);
      else await runtime.pin.setPin(pin);
      router.replace('/');
    } catch (cause) {
      setError(
        cause instanceof Error && cause.message
          ? cause.message
          : 'That PIN did not work. Try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  if (existing === null) {
    return (
      <Screen>
        <Body role="lead">One moment…</Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <Title>{existing ? 'Enter your grown-up PIN' : 'Create a grown-up PIN'}</Title>
      <Body>
        {existing
          ? 'Enter the PIN you already use so this phone can open the grown-ups area.'
          : "The PIN keeps settings and your children's details away from little fingers. Choose 4 to 6 digits."}
      </Body>
      <TextField
        label={existing ? 'Your PIN' : 'New PIN'}
        value={pin}
        onChangeText={setPin}
        keyboardType="number-pad"
        secureTextEntry
        maxLength={6}
      />
      {!existing ? (
        <TextField
          label="Type it again"
          value={confirm}
          onChangeText={setConfirm}
          keyboardType="number-pad"
          secureTextEntry
          maxLength={6}
          error={confirm.length > 0 && confirm !== pin ? 'The two PINs are different.' : null}
        />
      ) : null}
      {error ? <ErrorText>{error}</ErrorText> : null}
      {runtime.demoHint && existing ? <Body muted>Demo PIN: {runtime.demoHint.pin}</Body> : null}
      <Button
        label={existing ? 'Continue' : 'Save my PIN'}
        onPress={submit}
        busy={busy}
        disabled={!valid}
      />
    </Screen>
  );
}
