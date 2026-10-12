import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, Screen, TextField, Title } from '../ui';

export default function FamilySetup() {
  const { runtime, refresh } = useRuntime();
  const router = useRouter();
  const [name, setName] = useState('Our family');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await runtime.households.createHousehold(name.trim());
      const result = await runtime.sync.syncOnce();
      if (!result.ok) throw new Error('Created, but we could not load it yet. Please try again.');
      refresh();
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not create your family.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Set up your family</Title>
      <Body>Your children's lessons and progress live under your family.</Body>
      <TextField label="Family name" value={name} onChangeText={setName} />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label="Continue" onPress={submit} busy={busy} disabled={name.trim().length === 0} />
    </Screen>
  );
}
