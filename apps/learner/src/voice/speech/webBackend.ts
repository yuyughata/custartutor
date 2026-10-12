import { speechWatchdogMs, type SpeechBackend } from './synthesizer';
import type { VoiceInfo } from './pickVoice';

/** The slice of the browser's Web Speech API the web backend uses (also what tests fake). */
export interface WebVoiceLike {
  voiceURI: string;
  name: string;
  lang: string;
}

export interface WebUtteranceLike {
  text: string;
  lang: string;
  rate: number;
  voice: WebVoiceLike | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
}

export interface WebSpeechSynthesisLike {
  getVoices(): WebVoiceLike[];
  speak(utterance: WebUtteranceLike): void;
  cancel(): void;
  addEventListener?(type: 'voiceschanged', listener: () => void): void;
  removeEventListener?(type: 'voiceschanged', listener: () => void): void;
}

export interface WebSpeechEnv {
  synth: WebSpeechSynthesisLike;
  createUtterance(text: string): WebUtteranceLike;
}

/** The browser's speech environment, or null when there is none (old browser, server rendering). */
export function browserSpeechEnv(): WebSpeechEnv | null {
  const scope = globalThis as unknown as {
    speechSynthesis?: WebSpeechSynthesisLike;
    SpeechSynthesisUtterance?: new (text: string) => WebUtteranceLike;
  };
  const { speechSynthesis: synth, SpeechSynthesisUtterance: Utterance } = scope;
  if (!synth || !Utterance) return null;
  return { synth, createUtterance: (text) => new Utterance(text) };
}

/** How long to wait for the browser to load its voice list (Chrome fills it in after the page loads). */
const VOICE_LIST_WAIT_MS = 1500;

/**
 * Text-to-speech in a browser through the Web Speech API directly (not through `expo-speech`'s web module, whose
 * voice lookup waits forever when the browser has no voices). With no speech API, or no voices, read-aloud is
 * simply unavailable.
 */
export function createWebSpeechBackend(env: WebSpeechEnv | null): SpeechBackend {
  const pending = new Set<() => void>();

  const toInfo = (voice: WebVoiceLike): VoiceInfo => ({
    identifier: voice.voiceURI,
    name: voice.name,
    language: voice.lang,
  });

  return {
    // Chrome stops long utterances after about 15 seconds: keep each piece short.
    maxChunkLength: 200,

    getVoices(): Promise<VoiceInfo[]> {
      if (!env) return Promise.resolve([]);
      const { synth } = env;
      try {
        const now = synth.getVoices();
        if (now.length > 0) return Promise.resolve(now.map(toInfo));
      } catch {
        return Promise.resolve([]);
      }
      return new Promise<VoiceInfo[]>((resolve) => {
        const done = (): void => {
          clearTimeout(timer);
          synth.removeEventListener?.('voiceschanged', done);
          try {
            resolve(synth.getVoices().map(toInfo));
          } catch {
            resolve([]);
          }
        };
        const timer = setTimeout(done, VOICE_LIST_WAIT_MS);
        synth.addEventListener?.('voiceschanged', done);
      });
    },

    speakChunk(text, options): Promise<void> {
      if (!env) return Promise.resolve();
      const { synth } = env;
      return new Promise<void>((resolve) => {
        let finished = false;
        const finish = (): void => {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          pending.delete(finish);
          resolve();
        };
        const timer = setTimeout(
          () => {
            try {
              synth.cancel();
            } catch {
              // ignore
            }
            finish();
          },
          speechWatchdogMs(text, options.rate),
        );
        pending.add(finish);
        try {
          const utterance = env.createUtterance(text);
          if (options.lang) utterance.lang = options.lang;
          if (options.rate !== undefined) utterance.rate = options.rate;
          if (options.voice) {
            const voice = synth
              .getVoices()
              .find((candidate) => candidate.voiceURI === options.voice);
            if (voice) utterance.voice = voice;
          }
          utterance.onend = finish;
          utterance.onerror = finish;
          synth.speak(utterance);
        } catch {
          finish();
        }
      });
    },

    async stop(): Promise<void> {
      try {
        env?.synth.cancel();
      } catch {
        // ignore
      }
      for (const finish of [...pending]) finish();
    },
  };
}
