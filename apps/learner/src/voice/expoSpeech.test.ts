import { beforeEach, describe, expect, it, vi } from 'vitest';

const speechModule = vi.hoisted(() => ({
  speak: vi.fn(),
  stop: vi.fn(() => Promise.resolve()),
  getAvailableVoicesAsync: vi.fn(),
}));
const platform = vi.hoisted(() => ({ OS: 'android' as string }));

vi.mock('expo-speech', () => speechModule);
vi.mock('react-native', () => ({ Platform: platform }));

const { createExpoSpeechSynthesizer } = await import('./expoSpeech');

type SpeakArgs = [
  string,
  { language?: string; rate?: number; voice?: string; onDone?: () => void },
];

beforeEach(() => {
  platform.OS = 'android';
  speechModule.speak.mockReset();
  speechModule.stop.mockClear();
  speechModule.getAvailableVoicesAsync.mockReset();
  speechModule.getAvailableVoicesAsync.mockResolvedValue([
    { identifier: 'en-gb-x', name: 'en-gb-x', language: 'en-GB', quality: 'Default' },
    { identifier: 'en-ng-x', name: 'en-ng-x', language: 'en-NG', quality: 'Default' },
  ]);
  // every utterance finishes at once
  speechModule.speak.mockImplementation((...args: SpeakArgs) => args[1].onDone?.());
});

describe('createExpoSpeechSynthesizer (native, expo-speech mocked)', () => {
  it('is available when expo-speech lists voices', async () => {
    expect(await createExpoSpeechSynthesizer().isAvailable()).toBe(true);
  });

  it('is unavailable when there are no voices (no TTS engine installed)', async () => {
    speechModule.getAvailableVoicesAsync.mockResolvedValue([]);
    expect(await createExpoSpeechSynthesizer().isAvailable()).toBe(false);
  });

  it('is unavailable, without throwing, when the native module is missing', async () => {
    speechModule.getAvailableVoicesAsync.mockRejectedValue(new Error('UnavailabilityError'));
    const synth = createExpoSpeechSynthesizer();
    expect(await synth.isAvailable()).toBe(false);
    await expect(synth.speak('Hello')).resolves.toBeUndefined();
    expect(speechModule.speak).not.toHaveBeenCalled();
  });

  it('strips ** markers and speaks with the en-NG voice at the requested rate', async () => {
    await createExpoSpeechSynthesizer().speak('We **learn** here.', { rate: 0.7 });
    expect(speechModule.speak).toHaveBeenCalledTimes(1);
    const [text, options] = speechModule.speak.mock.calls[0] as SpeakArgs;
    expect(text).toBe('We learn here.');
    expect(options).toMatchObject({ language: 'en-NG', voice: 'en-ng-x', rate: 0.7 });
  });

  it('honours an explicit language and falls back to nearby English when it is not installed', async () => {
    await createExpoSpeechSynthesizer().speak('Hello.', { lang: 'en-GB' });
    expect((speechModule.speak.mock.calls[0] as SpeakArgs)[1]).toMatchObject({
      language: 'en-GB',
      voice: 'en-gb-x',
    });

    speechModule.speak.mockClear();
    speechModule.getAvailableVoicesAsync.mockResolvedValue([
      { identifier: 'en-gb-x', name: 'en-gb-x', language: 'en-GB' },
    ]);
    await createExpoSpeechSynthesizer().speak('Hello.'); // en-NG missing: en-GB is next best
    expect((speechModule.speak.mock.calls[0] as SpeakArgs)[1]).toMatchObject({
      language: 'en-GB',
      voice: 'en-gb-x',
    });
  });

  it('stop() calls expo-speech stop', async () => {
    await createExpoSpeechSynthesizer().stop();
    expect(speechModule.stop).toHaveBeenCalled();
  });

  it('speak() resolves when the speech is stopped part way, and never throws', async () => {
    speechModule.speak.mockImplementation(() => undefined); // never reports done by itself
    const synth = createExpoSpeechSynthesizer();
    const speaking = synth.speak('A long enough piece of text to speak.');
    await vi.waitFor(() => expect(speechModule.speak).toHaveBeenCalled());
    await synth.stop();
    await expect(speaking).resolves.toBeUndefined();
  });
});

describe('createExpoSpeechSynthesizer (web)', () => {
  it('reports unavailable and stays silent when the browser has no speech API', async () => {
    platform.OS = 'web';
    const synth = createExpoSpeechSynthesizer();
    expect(await synth.isAvailable()).toBe(false);
    await expect(synth.speak('Hello')).resolves.toBeUndefined();
    expect(speechModule.speak).not.toHaveBeenCalled(); // the web path does not use expo-speech
  });
});
