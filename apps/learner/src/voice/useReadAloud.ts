import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { controllerFor } from './readAloud/controller';
import { resolveRate, useSpeedChoice } from './readAloud/prefs';
import { useVoice } from './VoiceProvider';

export interface UseReadAloudOptions {
  /** The child's `reading_mode`: a child who cannot read yet is read to more slowly by default. */
  readingMode?: string | null;
  /** BCP 47 tag; default `en-NG` (the synthesizer falls back to nearby English). */
  lang?: string;
}

/**
 * Read-aloud for a screen, over the voice seam (`useVoice`). All speaker buttons share one controller, so only
 * one thing is read at a time and each button knows whether IT is the one speaking.
 *
 *  - `available` is false until the device is known to have a voice: hide speaker buttons then;
 *  - `speak(text, key)` reads text; `toggle(key, text)` reads it or, if that key is speaking, stops;
 *  - leaving the screen stops the reading this screen started (and nothing else).
 *
 * `speakingId` and `toggle(id, text)` mirror the tutor panel's own read-aloud hook, so either can replace the other.
 */
export function useReadAloud(options: UseReadAloudOptions = {}) {
  const { synthesizer } = useVoice();
  const controller = controllerFor(synthesizer);
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  const [choice] = useSpeedChoice();
  const rate = resolveRate(choice, options.readingMode);
  const lang = options.lang;
  const myToken = useRef<number | null>(null);

  useEffect(() => {
    void controller.checkAvailability();
  }, [controller]);

  useEffect(
    () => () => {
      if (myToken.current !== null) controller.stopIfCurrent(myToken.current);
    },
    [controller],
  );

  const speak = useCallback(
    (text: string, key = 'default'): Promise<void> => {
      const run = controller.speak(text, { key, rate, ...(lang ? { lang } : {}) });
      myToken.current = run.token;
      return run.done;
    },
    [controller, rate, lang],
  );

  const stop = useCallback((): Promise<void> => controller.stop(), [controller]);

  const toggle = useCallback(
    (key: string, text: string): void => {
      if (controller.getSnapshot().speakingKey === key) void controller.stop();
      else void speak(text, key);
    },
    [controller, speak],
  );

  return {
    /** True once the device is known to be able to speak. */
    available: snapshot.available === true,
    speakingKey: snapshot.speakingKey,
    speakingId: snapshot.speakingKey,
    speaking: snapshot.speakingKey !== null,
    isSpeaking: (key: string): boolean => snapshot.speakingKey === key,
    speak,
    toggle,
    stop,
    /** The engine rate in use (1 is normal). */
    rate,
  };
}
