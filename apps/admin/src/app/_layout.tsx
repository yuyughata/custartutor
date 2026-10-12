import { Slot } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RuntimeProvider, useRuntime } from '../runtime/RuntimeProvider';
import { UnsavedGuardProvider } from '../runtime/UnsavedGuard';
import { SignInFlow } from '../screens/SignInFlow';
import { Shell } from '../ui/Shell';

/** Nothing but the sign-in journey is shown until the session is `ready` (aal2 and a row in admin_users). */
function AuthGate() {
  const { auth } = useRuntime();
  if (auth?.step !== 'ready') return <SignInFlow state={auth} />;
  return (
    <Shell>
      <Slot />
    </Shell>
  );
}

export default function RootLayout() {
  return (
    <RuntimeProvider>
      <UnsavedGuardProvider>
        <StatusBar style="dark" />
        <AuthGate />
      </UnsavedGuardProvider>
    </RuntimeProvider>
  );
}
