import { createContext, useContext, useMemo, type ReactNode } from 'react';
import {
  noopRecognizer,
  plainForSpeech,
  type SpeakOptions,
  type SpeechRecognizer,
  type SpeechSynthesizer,
} from '@custar/tutor-core/client';

/**
 * The voice seam (plan section 7). Screens call `useVoice()`; the provider supplies a `SpeechSynthesizer` (read-aloud)
 * and a `SpeechRecognizer` (text-first milestones: the no-op). The default synthesizer says nothing and reports itself
 * unavailable, so a screen hides its speaker button until a real one is provided.
 */
export const silentSynthesizer: SpeechSynthesizer = {
  isAvailable: () => Promise.resolve(false),
  speak: () => Promise.resolve(),
  stop: () => Promise.resolve(),
};

export interface Voice {
  synthesizer: SpeechSynthesizer;
  recognizer: SpeechRecognizer;
  /** Speaks lesson or tutor text (bold markers removed). Resolves when done or stopped. */
  speak(text: string, options?: SpeakOptions): Promise<void>;
  stop(): Promise<void>;
}

const VoiceContext = createContext<Voice | null>(null);

export function VoiceProvider({
  synthesizer = silentSynthesizer,
  recognizer = noopRecognizer,
  children,
}: {
  synthesizer?: SpeechSynthesizer;
  recognizer?: SpeechRecognizer;
  children: ReactNode;
}) {
  const value = useMemo<Voice>(
    () => ({
      synthesizer,
      recognizer,
      speak: (text, options) => synthesizer.speak(plainForSpeech(text), options),
      stop: () => synthesizer.stop(),
    }),
    [synthesizer, recognizer],
  );
  return <VoiceContext.Provider value={value}>{children}</VoiceContext.Provider>;
}

export function useVoice(): Voice {
  const value = useContext(VoiceContext);
  if (!value) throw new Error('useVoice must be used inside <VoiceProvider>');
  return value;
}
