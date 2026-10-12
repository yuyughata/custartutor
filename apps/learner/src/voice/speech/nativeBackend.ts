import { speechWatchdogMs, type SpeechBackend } from './synthesizer';
import type { VoiceInfo } from './pickVoice';

/** The part of `expo-speech` the native backend uses, so tests can pass a mock module. */
export interface ExpoSpeechModule {
  speak(
    text: string,
    options: {
      language?: string;
      rate?: number;
      voice?: string;
      onDone?: () => void;
      onStopped?: () => void;
      onError?: (error: Error) => void;
    },
  ): void;
  stop(): Promise<void>;
  getAvailableVoicesAsync(): Promise<VoiceInfo[]>;
}

/**
 * Text-to-speech on Android and iOS through `expo-speech`. Each piece resolves when the engine reports done,
 * stopped or error, or when the watchdog fires (a silent engine failure must not leave the screen "speaking"
 * forever). NOT VERIFIED ON A DEVICE from here: see apps/learner/README.md.
 */
export function createNativeSpeechBackend(speech: ExpoSpeechModule): SpeechBackend {
  const pending = new Set<() => void>();

  return {
    // Android refuses more than about 4000 characters; stay far below.
    maxChunkLength: 600,

    async getVoices(): Promise<VoiceInfo[]> {
      try {
        const list = await speech.getAvailableVoicesAsync();
        return Array.isArray(list) ? list : [];
      } catch {
        return [];
      }
    },

    speakChunk(text, options): Promise<void> {
      return new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          pending.delete(finish);
          resolve();
        };
        const timer = setTimeout(() => {
          void speech.stop().catch(() => undefined);
          finish();
        }, speechWatchdogMs(text, options.rate));
        pending.add(finish);
        try {
          speech.speak(text, {
            ...(options.lang ? { language: options.lang } : {}),
            ...(options.rate !== undefined ? { rate: options.rate } : {}),
            ...(options.voice ? { voice: options.voice } : {}),
            onDone: finish,
            onStopped: finish,
            onError: finish,
          });
        } catch {
          finish();
        }
      });
    },

    async stop(): Promise<void> {
      try {
        await speech.stop();
      } catch {
        // the engine may not be running
      }
      for (const finish of [...pending]) finish();
    },
  };
}
