import { useCallback, useEffect, useRef, useState } from 'react';
import { useVoice } from '../voice/VoiceProvider';

/**
 * Read-aloud for tutor bubbles, through the voice seam (`useVoice`). It only CALLS the synthesizer: the
 * implementation belongs to the voice provider. Buttons stay hidden until the synthesizer says it is available.
 */
export function useReadAloud() {
  const voice = useVoice();
  const [available, setAvailable] = useState(false);
  const [speakingId, setSpeakingId] = useState<string | null>(null);
  const current = useRef<string | null>(null);

  useEffect(() => {
    let alive = true;
    voice.synthesizer
      .isAvailable()
      .then((value) => alive && setAvailable(value))
      .catch(() => alive && setAvailable(false));
    return () => {
      alive = false;
      void voice.stop().catch(() => undefined);
    };
  }, [voice]);

  const toggle = useCallback(
    (id: string, text: string) => {
      if (current.current === id) {
        current.current = null;
        setSpeakingId(null);
        void voice.stop().catch(() => undefined);
        return;
      }
      current.current = id;
      setSpeakingId(id);
      void voice
        .speak(text)
        .catch(() => undefined)
        .finally(() => {
          if (current.current === id) {
            current.current = null;
            setSpeakingId(null);
          }
        });
    },
    [voice],
  );

  const stop = useCallback(() => {
    current.current = null;
    setSpeakingId(null);
    void voice.stop().catch(() => undefined);
  }, [voice]);

  return { available, speakingId, toggle, stop };
}
