import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  browserSpeechEnv,
  createWebSpeechBackend,
  type WebSpeechEnv,
  type WebUtteranceLike,
  type WebVoiceLike,
} from './webBackend';

function fakeEnv(voices: WebVoiceLike[] = [{ voiceURI: 'uri-ng', name: 'Ezinne', lang: 'en-NG' }]) {
  const spoken: WebUtteranceLike[] = [];
  const listeners = new Set<() => void>();
  const state = { voices, cancels: 0 };
  const env: WebSpeechEnv = {
    synth: {
      getVoices: () => state.voices,
      speak: (utterance) => {
        spoken.push(utterance);
      },
      cancel: () => {
        state.cancels += 1;
      },
      addEventListener: (_type, listener) => listeners.add(listener),
      removeEventListener: (_type, listener) => listeners.delete(listener),
    },
    createUtterance: (text) => ({
      text,
      lang: '',
      rate: 1,
      voice: null,
      onend: null,
      onerror: null,
    }),
  };
  return { env, spoken, state, fireVoicesChanged: () => [...listeners].forEach((l) => l()) };
}

describe('web speech backend', () => {
  it('has no voices and does not throw when the browser has no speech API', async () => {
    const backend = createWebSpeechBackend(null);
    expect(await backend.getVoices()).toEqual([]);
    await expect(backend.speakChunk('Hello', {})).resolves.toBeUndefined();
    await expect(backend.stop()).resolves.toBeUndefined();
  });

  it('browserSpeechEnv is null when the browser lacks the API', () => {
    expect(browserSpeechEnv()).toBeNull(); // Node has no speechSynthesis
  });

  it('lists the browser voices with their language', async () => {
    const { env } = fakeEnv();
    expect(await createWebSpeechBackend(env).getVoices()).toEqual([
      { identifier: 'uri-ng', name: 'Ezinne', language: 'en-NG' },
    ]);
  });

  it('speaks with lang, rate and the chosen voice, and resolves on end', async () => {
    const { env, spoken } = fakeEnv();
    const backend = createWebSpeechBackend(env);
    const done = backend.speakChunk('Hello', { lang: 'en-NG', rate: 0.7, voice: 'uri-ng' });
    const utterance = spoken[0] as WebUtteranceLike;
    expect(utterance).toMatchObject({ text: 'Hello', lang: 'en-NG', rate: 0.7 });
    expect(utterance.voice?.voiceURI).toBe('uri-ng');
    utterance.onend?.();
    await done;
  });

  it('resolves on error (a cancelled utterance reports an error in Chrome)', async () => {
    const { env, spoken } = fakeEnv();
    const done = createWebSpeechBackend(env).speakChunk('Hello', {});
    spoken[0]?.onerror?.();
    await done;
  });

  it('stop() cancels the browser queue and releases what was speaking', async () => {
    const { env, state } = fakeEnv();
    const backend = createWebSpeechBackend(env);
    const done = backend.speakChunk('Hello', {});
    await backend.stop();
    await done;
    expect(state.cancels).toBe(1);
  });

  it('keeps pieces short for browsers that cut long speech off', () => {
    expect(createWebSpeechBackend(fakeEnv().env).maxChunkLength).toBeLessThanOrEqual(250);
  });

  describe('voices that arrive late', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('waits for voiceschanged, then reports the voices', async () => {
      const fake = fakeEnv([]);
      const pending = createWebSpeechBackend(fake.env).getVoices();
      fake.state.voices = [{ voiceURI: 'late', name: 'Late', lang: 'en-GB' }];
      fake.fireVoicesChanged();
      expect(await pending).toEqual([{ identifier: 'late', name: 'Late', language: 'en-GB' }]);
    });

    it('gives up and reports none when the browser never loads voices (headless Chromium)', async () => {
      const fake = fakeEnv([]);
      const pending = createWebSpeechBackend(fake.env).getVoices();
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual([]);
    });
  });
});
