import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { SpeechSynthesizer } from '@custar/tutor-core/client';

vi.mock('react-native', async () => (await import('../testing/rnMock')).reactNativeMock);

const { SpeakerButton } = await import('./SpeakerButton');
const { VoiceProvider } = await import('./VoiceProvider');
const { controllerFor } = await import('./readAloud/controller');

function synth(available: boolean): SpeechSynthesizer {
  return {
    isAvailable: () => Promise.resolve(available),
    speak: () => new Promise<void>(() => undefined), // speaks until stopped
    stop: () => Promise.resolve(),
  };
}

function render(synthesizer: SpeechSynthesizer, props: Parameters<typeof SpeakerButton>[0]) {
  return renderToStaticMarkup(
    createElement(VoiceProvider, { synthesizer, children: createElement(SpeakerButton, props) }),
  );
}

describe('SpeakerButton', () => {
  it('renders nothing until the device is known to be able to speak', () => {
    expect(render(synth(true), { text: 'Hello' })).toBe(''); // availability not checked yet
  });

  it('renders nothing when read-aloud is unavailable (no voice, headless browser)', async () => {
    const s = synth(false);
    await controllerFor(s).checkAvailability();
    expect(render(s, { text: 'Hello' })).toBe('');
  });

  it('renders a labelled, pressable button when read-aloud is available', async () => {
    const s = synth(true);
    await controllerFor(s).checkAvailability();
    const out = render(s, { text: 'Hello', speakKey: 'k' });
    expect(out).toContain('aria-label="Read this aloud"');
    expect(out).toContain('role="button"');
    expect(out).toContain('aria-pressed="false"');
    expect(out).toContain('🔊');
  });

  it('shows the visible label next to the icon but keeps the accessible name', async () => {
    const s = synth(true);
    await controllerFor(s).checkAvailability();
    const out = render(s, { text: 'Hello', speakKey: 'k', label: 'Listen' });
    expect(out).toContain('Listen');
    expect(out).toContain('aria-label="Read this aloud"');
  });

  it('turns into a stop button while its own text is being read, and only then', async () => {
    const s = synth(true);
    const controller = controllerFor(s);
    await controller.checkAvailability();
    controller.speak('Hello', { key: 'mine' });

    const mine = render(s, { text: 'Hello', speakKey: 'mine' });
    expect(mine).toContain('aria-label="Stop reading aloud"');
    expect(mine).toContain('aria-pressed="true"');
    expect(mine).toContain('■');
    expect(mine).not.toContain('🔊');

    const other = render(s, { text: 'Other', speakKey: 'other' });
    expect(other).toContain('aria-label="Read this aloud"');
    expect(other).toContain('aria-pressed="false"');
  });
});
