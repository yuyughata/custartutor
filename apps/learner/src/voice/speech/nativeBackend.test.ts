import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeSpeechBackend, type ExpoSpeechModule } from './nativeBackend';

type SpeakCall = Parameters<ExpoSpeechModule['speak']>;

function mockSpeech() {
  const calls: SpeakCall[] = [];
  const module: ExpoSpeechModule = {
    speak: vi.fn((...args: SpeakCall) => {
      calls.push(args);
    }),
    stop: vi.fn(() => Promise.resolve()),
    getAvailableVoicesAsync: vi.fn(() =>
      Promise.resolve([{ identifier: 'v1', language: 'en-NG' }]),
    ),
  };
  return { module, calls };
}

describe('native speech backend (expo-speech)', () => {
  it('lists the installed voices, and no voices when the call fails', async () => {
    const { module } = mockSpeech();
    expect(await createNativeSpeechBackend(module).getVoices()).toEqual([
      { identifier: 'v1', language: 'en-NG' },
    ]);
    module.getAvailableVoicesAsync = vi.fn(() => Promise.reject(new Error('Unavailable')));
    expect(await createNativeSpeechBackend(module).getVoices()).toEqual([]);
    module.getAvailableVoicesAsync = vi.fn(() => Promise.resolve(null as never));
    expect(await createNativeSpeechBackend(module).getVoices()).toEqual([]);
  });

  it('passes language, rate and voice to expo-speech and resolves on onDone', async () => {
    const { module, calls } = mockSpeech();
    const backend = createNativeSpeechBackend(module);
    const spoken = backend.speakChunk('Hello', { lang: 'en-NG', rate: 0.7, voice: 'v1' });
    expect(calls).toHaveLength(1);
    const [text, options] = calls[0] as SpeakCall;
    expect(text).toBe('Hello');
    expect(options).toMatchObject({ language: 'en-NG', rate: 0.7, voice: 'v1' });
    options.onDone?.();
    await spoken;
  });

  it.each(['onStopped', 'onError'] as const)('resolves on %s too', async (callback) => {
    const { module, calls } = mockSpeech();
    const spoken = createNativeSpeechBackend(module).speakChunk('Hi', {});
    const options = (calls[0] as SpeakCall)[1];
    if (callback === 'onError') options.onError?.(new Error('x'));
    else options.onStopped?.();
    await spoken;
  });

  it('omits options it was not given', async () => {
    const { module, calls } = mockSpeech();
    const spoken = createNativeSpeechBackend(module).speakChunk('Hi', {});
    const options = (calls[0] as SpeakCall)[1];
    expect(options).not.toHaveProperty('language');
    expect(options).not.toHaveProperty('rate');
    expect(options).not.toHaveProperty('voice');
    options.onDone?.();
    await spoken;
  });

  it('resolves when expo-speech throws synchronously', async () => {
    const { module } = mockSpeech();
    module.speak = vi.fn(() => {
      throw new Error('native module missing');
    });
    await expect(createNativeSpeechBackend(module).speakChunk('Hi', {})).resolves.toBeUndefined();
  });

  it('stop() calls expo-speech stop and releases a speech that never reports back', async () => {
    const { module } = mockSpeech();
    const backend = createNativeSpeechBackend(module);
    const spoken = backend.speakChunk('Hello there', {});
    await backend.stop();
    await spoken;
    expect(module.stop).toHaveBeenCalledTimes(1);
  });

  it('stop() survives an engine that throws', async () => {
    const { module } = mockSpeech();
    module.stop = vi.fn(() => Promise.reject(new Error('not running')));
    await expect(createNativeSpeechBackend(module).stop()).resolves.toBeUndefined();
  });

  describe('watchdog', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('gives up on an engine that never says it is done, and stops it', async () => {
      const { module } = mockSpeech();
      const backend = createNativeSpeechBackend(module);
      let done = false;
      const spoken = backend.speakChunk('One two three', {}).then(() => {
        done = true;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(20_000);
      await spoken;
      expect(done).toBe(true);
      expect(module.stop).toHaveBeenCalled();
    });
  });

  it('keeps pieces well under the Android limit of about 4000 characters', () => {
    expect(createNativeSpeechBackend(mockSpeech().module).maxChunkLength).toBeLessThan(1000);
  });
});
