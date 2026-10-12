import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RuntimeProvider } from '../runtime/RuntimeProvider';
import { VoiceProvider } from '../voice/VoiceProvider';

export default function RootLayout() {
  return (
    <RuntimeProvider>
      <VoiceProvider>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }} />
      </VoiceProvider>
    </RuntimeProvider>
  );
}
