import { plainForSpeech } from '@custar/tutor-core/client';
import type { SpeakOptions, SpeechSynthesizer } from '@custar/tutor-core/client';
import { splitForSpeech } from './chunks';
import { pickVoice, type VoiceInfo } from './pickVoice';

/**
 * One text-to-speech engine, reduced to what the synthesizer needs. The native backend wraps `expo-speech`, the
 * web backend wraps the browser's Web Speech API; tests use a scripted fake.
 */
export interface SpeechBackend {
  /** The voices installed on this device. May be empty; rejection counts as empty. */
  getVoices(): Promise<VoiceInfo[]>;
  /**
   * Speaks ONE piece of text. Resolves when it finishes, is stopped, fails, or runs far longer than it should
   * (a watchdog). Never rejects.
   */
  speakChunk(
    text: string,
    options: { lang?: string; rate?: number; voice?: string },
  ): Promise<void>;
  /** Stops what is speaking and resolves every pending `speakChunk`. Never rejects. */
  stop(): Promise<void>;
  /** The longest piece this engine should be given. */
  readonly maxChunkLength: number;
}

export interface SynthesizerOptions {
  /** Used when the caller gives no language. Default `en-NG`. */
  defaultLang?: string;
  /** Tried when no installed voice speaks `lang` at all. Default `en`. */
  fallbackLang?: string;
  /** How long to wait for the device's voice list before calling read-aloud unavailable. Default 4000. */
  voiceListTimeoutMs?: number;
  /** After a "no voices" answer, how long before asking again. Default 15000. */
  recheckAfterMs?: number;
  now?: () => number;
}

const DEFAULTS = {
  defaultLang: 'en-NG',
  fallbackLang: 'en',
  voiceListTimeoutMs: 4000,
  recheckAfterMs: 15_000,
} as const;

function withTimeout<T>(work: Promise<T>, ms: number, onTimeout: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(onTimeout), ms);
    work.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(onTimeout);
      },
    );
  });
}

/**
 * Builds the app's `SpeechSynthesizer` over an engine. Behaviour (all of it tested with a fake engine):
 *  - `isAvailable` is true only when the device has at least one voice; a "no" is re-checked later, a "yes" is kept;
 *  - `speak` removes `**bold**` markers (`plainForSpeech`), stops whatever is speaking first (one voice at a time),
 *    picks the best installed voice for `lang` (default `en-NG`, falling back to nearby English, then plain `en`),
 *    and reads long text as a run of short pieces;
 *  - `speak` resolves when the speech finishes OR is stopped, and NEVER throws: a broken engine just says nothing.
 */
export function createSynthesizer(
  backend: SpeechBackend,
  options: SynthesizerOptions = {},
): SpeechSynthesizer {
  const { defaultLang, fallbackLang, voiceListTimeoutMs, recheckAfterMs } = {
    ...DEFAULTS,
    ...options,
  };
  const now = options.now ?? (() => Date.now());

  let voices: VoiceInfo[] | null = null;
  let checkedAt = 0;
  let inflight: Promise<VoiceInfo[]> | null = null;
  let generation = 0;

  function loadVoices(): Promise<VoiceInfo[]> {
    inflight ??= withTimeout(backend.getVoices(), voiceListTimeoutMs, [] as VoiceInfo[])
      .then((list) => {
        voices = list;
        checkedAt = now();
        return list;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  }

  async function currentVoices(): Promise<VoiceInfo[]> {
    if (voices && (voices.length > 0 || now() - checkedAt < recheckAfterMs)) return voices;
    return loadVoices();
  }

  return {
    async isAvailable(): Promise<boolean> {
      try {
        return (await currentVoices()).length > 0;
      } catch {
        return false;
      }
    },

    async speak(text: string, speakOptions: SpeakOptions = {}): Promise<void> {
      const token = ++generation;
      try {
        const clean = plainForSpeech(text);
        if (clean === '') return;
        await backend.stop(); // one voice at a time: this resolves any earlier speak()
        if (token !== generation) return;

        const installed = await currentVoices();
        if (token !== generation || installed.length === 0) return;

        const lang = speakOptions.lang ?? defaultLang;
        const voice = pickVoice(installed, lang) ?? pickVoice(installed, fallbackLang);
        const engineOptions = {
          lang: voice ? voice.language : fallbackLang,
          ...(voice ? { voice: voice.identifier } : {}),
          ...(speakOptions.rate !== undefined ? { rate: speakOptions.rate } : {}),
        };
        for (const piece of splitForSpeech(clean, backend.maxChunkLength)) {
          if (token !== generation) return;
          await backend.speakChunk(piece, engineOptions);
        }
      } catch {
        // Read-aloud is a convenience: a failing engine must never break the lesson screen.
      }
    },

    async stop(): Promise<void> {
      generation += 1;
      try {
        await backend.stop();
      } catch {
        // nothing to do
      }
    },
  };
}

/**
 * A rough upper bound for how long `text` takes to speak at `rate`, used as the engine watchdog: about 2.5
 * words a second at normal speed, doubled for safety, plus a few seconds for the engine to start.
 */
export function speechWatchdogMs(text: string, rate = 1): number {
  const words = text.trim().split(/\s+/).filter(Boolean).length;
  const seconds = words / (2.5 * Math.max(0.3, rate));
  return Math.round(seconds * 2 * 1000) + 8000;
}
