import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { RuntimeProvider } from '../runtime/RuntimeProvider';
import { createExpoSpeechSynthesizer } from '../voice/expoSpeech';
import { VoiceProvider } from '../voice/VoiceProvider';

// One synthesizer for the whole app: every speaker button shares its availability check and "one voice at a time".
const synthesizer = createExpoSpeechSynthesizer();

export default function RootLayout() {
  return (
    <RuntimeProvider>
      <VoiceProvider synthesizer={synthesizer}>
        <StatusBar style="dark" />
        <Stack screenOptions={{ headerShown: false }} />
      </VoiceProvider>
    </RuntimeProvider>
  );
}
