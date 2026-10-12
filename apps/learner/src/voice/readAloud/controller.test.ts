import { describe, expect, it } from 'vitest';
import type { SpeakOptions, SpeechSynthesizer } from '@custar/tutor-core/client';
import { ReadAloudController, controllerFor } from './controller';

/** A synthesizer you can finish by hand. */
function fakeSynth(available = true) {
  const calls: Array<{ text: string; options?: SpeakOptions }> = [];
  const waiting: Array<() => void> = [];
  let stops = 0;
  const synth: SpeechSynthesizer = {
    isAvailable: () => Promise.resolve(available),
    speak: (text, options) => {
      calls.push({ text, ...(options ? { options } : {}) });
      return new Promise<void>((resolve) => waiting.push(resolve));
    },
    stop: () => {
      stops += 1;
      while (waiting.length > 0) waiting.shift()?.();
      return Promise.resolve();
    },
  };
  return {
    synth,
    calls,
    finish: () => waiting.shift()?.(),
    stops: () => stops,
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('ReadAloudController', () => {
  it('starts with unknown availability and nothing speaking', () => {
    const controller = new ReadAloudController(fakeSynth().synth);
    expect(controller.getSnapshot()).toEqual({ available: null, speakingKey: null });
  });

  it('learns whether the device can speak, and tells subscribers', async () => {
    const controller = new ReadAloudController(fakeSynth(true).synth);
    let notified = 0;
    controller.subscribe(() => {
      notified += 1;
    });
    expect(await controller.checkAvailability()).toBe(true);
    expect(controller.getSnapshot().available).toBe(true);
    expect(notified).toBe(1);

    const none = new ReadAloudController(fakeSynth(false).synth);
    expect(await none.checkAvailability()).toBe(false);
    expect(none.getSnapshot().available).toBe(false);
  });

  it('treats a throwing isAvailable as unavailable', async () => {
    const synth = fakeSynth().synth;
    synth.isAvailable = () => Promise.reject(new Error('boom'));
    const controller = new ReadAloudController(synth);
    expect(await controller.checkAvailability()).toBe(false);
  });

  it('goes idle -> speaking -> idle around a reading, with the key of the speaker', async () => {
    const fake = fakeSynth();
    const controller = new ReadAloudController(fake.synth);
    const seen: Array<string | null> = [];
    controller.subscribe(() => seen.push(controller.getSnapshot().speakingKey));

    const run = controller.speak('We **learn** here.', { key: 'section-1', rate: 0.7 });
    expect(controller.getSnapshot().speakingKey).toBe('section-1');
    expect(fake.calls).toEqual([{ text: 'We learn here.', options: { rate: 0.7 } }]);

    fake.finish();
    await run.done;
    expect(controller.getSnapshot().speakingKey).toBeNull();
    expect(seen).toEqual(['section-1', null]);
  });

  it('stop() ends the reading and returns to idle', async () => {
    const fake = fakeSynth();
    const controller = new ReadAloudController(fake.synth);
    const run = controller.speak('Hello there', { key: 'a' });
    await controller.stop();
    await run.done;
    expect(controller.getSnapshot().speakingKey).toBeNull();
    expect(fake.stops()).toBe(1);
  });

  it('a new reading replaces the old one, and the old one finishing does not clear the new key', async () => {
    const fake = fakeSynth();
    const controller = new ReadAloudController(fake.synth);
    const first = controller.speak('First', { key: 'a' });
    const second = controller.speak('Second', { key: 'b' });
    expect(controller.getSnapshot().speakingKey).toBe('b');
    fake.finish(); // the FIRST finishes (stopped by the engine)
    await first.done;
    expect(controller.getSnapshot().speakingKey).toBe('b');
    fake.finish();
    await second.done;
    expect(controller.getSnapshot().speakingKey).toBeNull();
  });

  it('empty text does nothing', async () => {
    const fake = fakeSynth();
    const controller = new ReadAloudController(fake.synth);
    const run = controller.speak('   ', { key: 'a' });
    await run.done;
    expect(fake.calls).toEqual([]);
    expect(controller.getSnapshot().speakingKey).toBeNull();
  });

  it('never throws when the synthesizer rejects', async () => {
    const synth = fakeSynth().synth;
    synth.speak = () => Promise.reject(new Error('engine down'));
    synth.stop = () => Promise.reject(new Error('engine down'));
    const controller = new ReadAloudController(synth);
    await controller.speak('Hello', { key: 'a' }).done;
    expect(controller.getSnapshot().speakingKey).toBeNull();
    await expect(controller.stop()).resolves.toBeUndefined();
  });

  it('stopIfCurrent only stops the reading it started', async () => {
    const fake = fakeSynth();
    const controller = new ReadAloudController(fake.synth);
    const mine = controller.speak('Mine', { key: 'mine' });
    const theirs = controller.speak('Theirs', { key: 'theirs' });
    controller.stopIfCurrent(mine.token); // not current any more: ignored
    await flush();
    expect(controller.getSnapshot().speakingKey).toBe('theirs');
    controller.stopIfCurrent(theirs.token);
    await flush();
    expect(controller.getSnapshot().speakingKey).toBeNull();
  });
});

describe('controllerFor', () => {
  it('gives every caller the same controller for the same synthesizer', () => {
    const { synth } = fakeSynth();
    expect(controllerFor(synth)).toBe(controllerFor(synth));
    expect(controllerFor(fakeSynth().synth)).not.toBe(controllerFor(synth));
  });
});
