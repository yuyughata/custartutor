import { useEffect, useState } from 'react';
import { useRouter } from 'expo-router';
import { getHousehold } from '@custar/learner-core';
import { useRuntime } from '../runtime/RuntimeProvider';
import { Body, Button, ErrorText, Screen, Title } from '../ui';

/**
 * Start-up router. Signed out goes to sign-in; signed in syncs (offline is fine when data is cached), then
 * routes to family setup, PIN setup or the child picker.
 */
export default function Index() {
  const { runtime, email } = useRuntime();
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (email === undefined) return;
    let alive = true;
    void (async () => {
      if (email === null) return router.replace('/sign-in');
      const result = await runtime.sync.syncOnce();
      const household = await getHousehold(runtime.ports.db);
      if (!alive) return;
      if (!household) {
        if (!result.ok) {
          setError(
            'We could not reach the server to set up your family. Check your connection and try again.',
          );
          return;
        }
        return router.replace('/family-setup');
      }
      const hasPin = await runtime.pin.hasPin();
      router.replace(hasPin ? '/children' : '/set-pin');
    })();
    return () => {
      alive = false;
    };
  }, [runtime, email, router, attempt]);

  return (
    <Screen>
      <Title>CUSTAR Tutor</Title>
      {error ? (
        <>
          <ErrorText>{error}</ErrorText>
          <Button
            label="Try again"
            onPress={() => {
              setError(null);
              setAttempt((value) => value + 1);
            }}
          />
        </>
      ) : (
        <Body role="lead">Getting your lessons ready…</Body>
      )}
    </Screen>
  );
}
