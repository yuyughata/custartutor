import { Platform } from 'react-native';
import * as Speech from 'expo-speech';
import type { SpeechSynthesizer } from '@custar/tutor-core/client';
import { createNativeSpeechBackend } from './speech/nativeBackend';
import { createSynthesizer, type SynthesizerOptions } from './speech/synthesizer';
import { browserSpeechEnv, createWebSpeechBackend } from './speech/webBackend';

/**
 * The app's real `SpeechSynthesizer` (plan section 7, text-first milestones). On Android and iOS it speaks through
 * `expo-speech`; in a browser it uses the Web Speech API when the browser has it and some voice, and reports
 * itself unavailable otherwise (screens then hide their speaker buttons). English for Nigeria (`en-NG`) is the
 * default language with a graceful fall back to nearby English. See `speech/synthesizer.ts` for the behaviour.
 */
export function createExpoSpeechSynthesizer(options: SynthesizerOptions = {}): SpeechSynthesizer {
  const backend =
    Platform.OS === 'web'
      ? createWebSpeechBackend(browserSpeechEnv())
      : createNativeSpeechBackend(Speech);
  return createSynthesizer(backend, options);
}
