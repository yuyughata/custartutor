import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSynthesizer, speechWatchdogMs, type SpeechBackend } from './synthesizer';
import type { VoiceInfo } from './pickVoice';

interface Spoken {
  text: string;
  lang?: string;
  rate?: number;
  voice?: string;
}

/** A scripted engine: speakChunk stays pending until `finishCurrent()` (or stop). */
function fakeBackend(voices: VoiceInfo[] = [{ identifier: 'ng', language: 'en-NG' }]) {
  const spoken: Spoken[] = [];
  const waiting: Array<() => void> = [];
  const state = { voices, voiceError: false, stops: 0, auto: false, maxChunkLength: 60 };
  const backend: SpeechBackend = {
    get maxChunkLength() {
      return state.maxChunkLength;
    },
    getVoices: () =>
      state.voiceError ? Promise.reject(new Error('no engine')) : Promise.resolve(state.voices),
    speakChunk: (text, options) => {
      spoken.push({ text, ...options });
      if (state.auto) return Promise.resolve();
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    stop: () => {
      state.stops += 1;
      while (waiting.length > 0) waiting.shift()?.();
      return Promise.resolve();
    },
  };
  return {
    backend,
    spoken,
    state,
    finishCurrent: () => waiting.shift()?.(),
    pendingCount: () => waiting.length,
  };
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('createSynthesizer', () => {
  it('is available only when the device has at least one voice', async () => {
    expect(await createSynthesizer(fakeBackend([]).backend).isAvailable()).toBe(false);
    expect(await createSynthesizer(fakeBackend().backend).isAvailable()).toBe(true);
  });

  it('treats a failing engine as unavailable instead of throwing', async () => {
    const fake = fakeBackend();
    fake.state.voiceError = true;
    const synth = createSynthesizer(fake.backend);
    expect(await synth.isAvailable()).toBe(false);
    await expect(synth.speak('Hello there')).resolves.toBeUndefined();
    expect(fake.spoken).toEqual([]);
  });

  it('keeps a "yes" and re-checks a "no" only after a while', async () => {
    let time = 0;
    const fake = fakeBackend([]);
    let calls = 0;
    const original = fake.backend.getVoices;
    fake.backend.getVoices = () => {
      calls += 1;
      return original();
    };
    const synth = createSynthesizer(fake.backend, { recheckAfterMs: 1000, now: () => time });
    expect(await synth.isAvailable()).toBe(false);
    expect(await synth.isAvailable()).toBe(false);
    expect(calls).toBe(1);
    fake.state.voices = [{ identifier: 'x', language: 'en-GB' }];
    time = 1500;
    expect(await synth.isAvailable()).toBe(true);
    expect(calls).toBe(2);
    expect(await synth.isAvailable()).toBe(true);
    expect(calls).toBe(2);
  });

  it('strips bold markers, uses en-NG by default and the voice that matches', async () => {
    const fake = fakeBackend([
      { identifier: 'us', language: 'en-US' },
      { identifier: 'ng', language: 'en-NG' },
    ]);
    fake.state.auto = true;
    await createSynthesizer(fake.backend).speak('We **learn** here.');
    expect(fake.spoken).toEqual([{ text: 'We learn here.', lang: 'en-NG', voice: 'ng' }]);
  });

  it('honours lang and rate, and falls back to nearby English then plain en', async () => {
    const fake = fakeBackend([{ identifier: 'gb', language: 'en-GB' }]);
    fake.state.auto = true;
    const synth = createSynthesizer(fake.backend);
    await synth.speak('Hello.', { rate: 0.7 });
    expect(fake.spoken[0]).toEqual({ text: 'Hello.', lang: 'en-GB', voice: 'gb', rate: 0.7 });

    const french = fakeBackend([{ identifier: 'fr', language: 'fr-FR' }]);
    french.state.auto = true;
    await createSynthesizer(french.backend).speak('Bonjour.', { lang: 'yo' });
    // no Yoruba and no English voice: the engine is asked for plain English with no named voice
    expect(french.spoken[0]).toEqual({ text: 'Bonjour.', lang: 'en' });
  });

  it('says nothing for empty text and when the device has no voice', async () => {
    const fake = fakeBackend([]);
    fake.state.auto = true;
    const synth = createSynthesizer(fake.backend);
    await synth.speak('   ');
    await synth.speak('Hello');
    expect(fake.spoken).toEqual([]);
  });

  it('reads long text as a run of short pieces, in order', async () => {
    const fake = fakeBackend();
    fake.state.auto = true;
    const text = 'First sentence is here. Second sentence is here. Third sentence is here.';
    await createSynthesizer(fake.backend).speak(text);
    expect(fake.spoken.length).toBeGreaterThan(1);
    expect(fake.spoken.map((s) => s.text).join(' ')).toBe(text);
    expect(fake.spoken.every((s) => s.text.length <= 60)).toBe(true);
  });

  it('resolves only when the speech finishes', async () => {
    const fake = fakeBackend();
    const synth = createSynthesizer(fake.backend);
    let done = false;
    const speaking = synth.speak('Short one.').then(() => {
      done = true;
    });
    await tick();
    expect(fake.spoken).toHaveLength(1);
    expect(done).toBe(false);
    fake.finishCurrent();
    await speaking;
    expect(done).toBe(true);
  });

  it('stop() ends the speech, resolves speak() and skips the rest of the text', async () => {
    const fake = fakeBackend();
    const synth = createSynthesizer(fake.backend);
    const speaking = synth.speak(
      'First sentence is here. Second sentence is here. Third sentence is here.',
    );
    await tick();
    expect(fake.spoken).toHaveLength(1);
    await synth.stop();
    await speaking;
    expect(fake.spoken).toHaveLength(1); // the later pieces were never spoken
  });

  it('speaking again stops the earlier speech first (one voice at a time)', async () => {
    const fake = fakeBackend();
    const synth = createSynthesizer(fake.backend);
    const first = synth.speak('A long first thing to say here. And a second part of it too.');
    await tick();
    const second = synth.speak('Second.');
    await tick();
    expect(fake.state.stops).toBeGreaterThanOrEqual(1);
    await first; // resolved because the engine was stopped
    expect(fake.spoken[fake.spoken.length - 1]?.text).toBe('Second.');
    fake.finishCurrent();
    await second;
    expect(fake.spoken.map((s) => s.text)).not.toContain('And a second part of it too.');
  });

  it('never throws when the engine blows up', async () => {
    const fake = fakeBackend();
    fake.backend.speakChunk = () => {
      throw new Error('engine crashed');
    };
    fake.backend.stop = () => Promise.reject(new Error('cannot stop'));
    const synth = createSynthesizer(fake.backend);
    await expect(synth.speak('Hello there')).resolves.toBeUndefined();
    await expect(synth.stop()).resolves.toBeUndefined();
  });

  describe('voice list timeout', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('calls read-aloud unavailable when the engine never reports its voices', async () => {
      const fake = fakeBackend();
      fake.backend.getVoices = () => new Promise<VoiceInfo[]>(() => undefined);
      const synth = createSynthesizer(fake.backend, { voiceListTimeoutMs: 500 });
      const answer = synth.isAvailable();
      await vi.advanceTimersByTimeAsync(600);
      expect(await answer).toBe(false);
    });
  });
});

describe('speechWatchdogMs', () => {
  it('grows with the text and with a slower rate', () => {
    const short = speechWatchdogMs('one two three');
    const long = speechWatchdogMs('one two three '.repeat(40));
    expect(long).toBeGreaterThan(short);
    expect(speechWatchdogMs('one two three four five six', 0.5)).toBeGreaterThan(
      speechWatchdogMs('one two three four five six', 1),
    );
    expect(short).toBeGreaterThan(8000);
  });
});
