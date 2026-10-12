import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-native', async () => (await import('./rn-mock')).reactNativeMock);

const { HelperScriptView } = await import('./HelperScriptView');

function html(props: Parameters<typeof HelperScriptView>[0]): string {
  return renderToStaticMarkup(createElement(HelperScriptView, props));
}

describe('HelperScriptView', () => {
  it('shows numbered steps and the say / ask / watch-for lines', () => {
    const out = html({
      steps: ['Read the story aloud.', 'Point to the **picture**.'],
      say: 'Read slowly.',
      ask: 'Where did they go?',
      watchFor: 'A child who names only one place.',
    });
    expect(out).toContain('For the helper');
    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('Read the story aloud.');
    expect(out).toContain('<span>picture</span>'); // the bold run is its own span
    expect(out).toContain('SAY');
    expect(out).toContain('Read slowly.');
    expect(out).toContain('ASK');
    expect(out).toContain('WATCH FOR');
    expect(out).not.toContain('**');
  });

  it('uses a custom title', () => {
    expect(html({ steps: ['One.'], title: 'Helper steps' })).toContain('Helper steps');
  });

  it('says so when nothing is scripted for the section', () => {
    const out = html({});
    expect(out).toContain('Nothing is scripted for this part');
    expect(out).not.toContain('SAY');
  });

  it('renders text as text, never as markup', () => {
    const out = html({ steps: ['<img src=x onerror=alert(1)>'] });
    expect(out).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(out).not.toContain('<img');
  });
});
