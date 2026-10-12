/** The few browser objects the print helper touches (also what a test fakes). */
export interface FrameLike {
  srcdoc: string;
  onload: (() => void) | null;
  contentWindow: {
    focus(): void;
    print(): void;
    addEventListener(type: 'afterprint', listener: () => void): void;
  } | null;
  setAttribute(name: string, value: string): void;
  remove(): void;
  style: { cssText: string };
}

export interface BrowserDocument {
  body: { appendChild(frame: FrameLike): void } | null;
  createElement(tag: 'iframe'): FrameLike;
}

/** How long the hidden page is kept after printing starts, in case the browser never reports "afterprint". */
const KEEP_FOR_MS = 60_000;

/**
 * Prints an HTML page in a browser WITHOUT replacing the app's own page: the HTML goes into a hidden frame and
 * only that frame is printed (the browser's print dialog also offers "Save as PDF"). Resolves once the print dialog
 * has been asked for; rejects when there is no page to print into or the browser refuses.
 *
 * (`expo-print`'s web version prints the whole current page, not the HTML it is given, so it cannot be used here.)
 */
export function printHtmlInBrowser(
  html: string,
  doc: BrowserDocument | undefined = (globalThis as { document?: BrowserDocument }).document,
): Promise<void> {
  const body = doc?.body;
  if (!doc || !body) return Promise.reject(new Error('This browser cannot print from here.'));

  return new Promise<void>((resolve, reject) => {
    const frame = doc.createElement('iframe');
    frame.setAttribute('aria-hidden', 'true');
    frame.setAttribute('title', 'Print preview');
    frame.style.cssText =
      'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden;';
    const cleanup = (): void => frame.remove();
    frame.onload = () => {
      try {
        const win = frame.contentWindow;
        if (!win) throw new Error('The print page did not open.');
        win.addEventListener('afterprint', cleanup);
        win.focus();
        win.print();
        setTimeout(cleanup, KEEP_FOR_MS);
        resolve();
      } catch (error) {
        cleanup();
        reject(error instanceof Error ? error : new Error('Printing failed.'));
      }
    };
    frame.srcdoc = html;
    body.appendChild(frame);
  });
}
