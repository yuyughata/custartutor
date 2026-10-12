import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RuntimeProvider } from '../runtime/RuntimeProvider';

export default function RootLayout() {
  return (
    <RuntimeProvider>
      <StatusBar style="dark" />
      <Stack screenOptions={{ headerShown: false }} />
    </RuntimeProvider>
  );
}
