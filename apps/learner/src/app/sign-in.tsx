import { useState } from 'react';
import { useRouter } from 'expo-router';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, Screen, TextField, Title } from '../ui';

export default function SignIn() {
  const { runtime } = useRuntime();
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await runtime.households.signInWithEmail(email.trim());
      router.push({ pathname: '/verify', params: { email: email.trim() } });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not send the code.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen>
      <Title>Welcome to CUSTAR Tutor</Title>
      <Body>A grown-up signs in with their email. We will send a 6-digit code.</Body>
      <TextField
        label="Grown-up's email"
        value={email}
        onChangeText={setEmail}
        keyboardType="email-address"
        autoCapitalize="none"
        autoComplete="email"
        autoCorrect={false}
      />
      {error ? <ErrorText>{error}</ErrorText> : null}
      <Button label="Send me a code" onPress={submit} busy={busy} disabled={!email.includes('@')} />
      {runtime.demoHint ? (
        <Body muted>Demo mode: use any email. The code is {runtime.demoHint.code}.</Body>
      ) : null}
    </Screen>
  );
}
