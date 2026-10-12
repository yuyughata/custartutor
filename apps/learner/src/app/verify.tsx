import { useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, Screen, TextField, Title, TopBar } from '../ui';
import { View } from 'react-native';

export default function Verify() {
  const { runtime } = useRuntime();
  const router = useRouter();
  const { email = '' } = useLocalSearchParams<{ email?: string }>();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await runtime.households.verifyEmailCode(email, code.trim());
      router.replace('/');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'That code did not work.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
      <TopBar title="Enter your code" />
      <Screen>
        <Title>Check your email</Title>
        <Body>We sent a 6-digit code to {email}.</Body>
        <TextField
          label="6-digit code"
          value={code}
          onChangeText={setCode}
          keyboardType="number-pad"
          maxLength={6}
          autoComplete="one-time-code"
        />
        {error ? <ErrorText>{error}</ErrorText> : null}
        <Button label="Sign in" onPress={submit} busy={busy} disabled={code.trim().length < 6} />
      </Screen>
    </View>
  );
}
