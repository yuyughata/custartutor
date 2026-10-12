import { describe, expect, it, vi } from 'vitest';
import { printHtmlInBrowser, type BrowserDocument, type FrameLike } from './browserPrint';

function fakeDocument(options: { windowMissing?: boolean; printThrows?: boolean } = {}) {
  const frames: FrameLike[] = [];
  const printed = vi.fn();
  const afterprint: Array<() => void> = [];
  const removed = vi.fn();
  const doc: BrowserDocument = {
    body: {
      appendChild(frame) {
        frames.push(frame);
        // the browser loads the srcdoc, then fires onload
        queueMicrotask(() => frame.onload?.());
      },
    },
    createElement() {
      const attrs = new Map<string, string>();
      const frame: FrameLike = {
        srcdoc: '',
        onload: null,
        style: { cssText: '' },
        setAttribute: (name, value) => void attrs.set(name, value),
        remove: removed,
        contentWindow: options.windowMissing
          ? null
          : {
              focus: () => undefined,
              print: () => {
                if (options.printThrows) throw new Error('print blocked');
                printed();
              },
              addEventListener: (_type, listener) => void afterprint.push(listener),
            },
      };
      return frame;
    },
  };
  return { doc, frames, printed, afterprint, removed };
}

describe('printHtmlInBrowser', () => {
  it('loads the page into a hidden frame and prints only that frame', async () => {
    const { doc, frames, printed } = fakeDocument();
    await printHtmlInBrowser('<p>Sheet</p>', doc);
    expect(frames).toHaveLength(1);
    expect(frames[0]?.srcdoc).toBe('<p>Sheet</p>');
    expect(frames[0]?.style.cssText).toContain('visibility:hidden');
    expect(printed).toHaveBeenCalledTimes(1);
  });

  it('removes the frame once printing is over', async () => {
    const { doc, afterprint, removed } = fakeDocument();
    await printHtmlInBrowser('<p>x</p>', doc);
    expect(removed).not.toHaveBeenCalled();
    afterprint.forEach((listener) => listener());
    expect(removed).toHaveBeenCalledTimes(1);
  });

  it('rejects, and cleans up, when the browser refuses to print', async () => {
    const { doc, removed } = fakeDocument({ printThrows: true });
    await expect(printHtmlInBrowser('<p>x</p>', doc)).rejects.toThrow('print blocked');
    expect(removed).toHaveBeenCalled();
  });

  it('rejects when the frame has no window', async () => {
    const { doc } = fakeDocument({ windowMissing: true });
    await expect(printHtmlInBrowser('<p>x</p>', doc)).rejects.toThrow(/did not open/);
  });

  it('rejects when there is no page to print into', async () => {
    await expect(printHtmlInBrowser('<p>x</p>', undefined)).rejects.toThrow(/cannot print/);
    await expect(
      printHtmlInBrowser('<p>x</p>', { body: null, createElement: () => ({}) as FrameLike }),
    ).rejects.toThrow(/cannot print/);
  });
});
