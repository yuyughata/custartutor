/**
 * Finds the first element whose own text is `text` (a section heading in the preview) and scrolls it into view,
 * then outlines it briefly so the eye finds it. Section headings are plain text on the page, so this matches
 * by text instead of needing ids from the shared renderer.
 */
export function scrollToText(text: string, within = '[data-preview-frame]'): void {
  if (typeof document === 'undefined') return;
  const root = document.querySelector(within) ?? document.body;
  const wanted = text.trim();
  if (wanted === '') return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if ((node.textContent ?? '').trim() === wanted && node.parentElement) {
      const target = node.parentElement;
      target.scrollIntoView({ block: 'center', behavior: 'smooth' });
      const previous = target.style.outline;
      target.style.outline = '3px solid #c6791e';
      target.style.outlineOffset = '4px';
      window.setTimeout(() => {
        target.style.outline = previous;
        target.style.outlineOffset = '';
      }, 2200);
      return;
    }
    node = walker.nextNode();
  }
}

/** Scrolls the element with this testID into view (the progress panel when a job starts). */
export function scrollToTestId(testId: string): void {
  if (typeof document === 'undefined') return;
  const target = document.querySelector(`[data-testid="${testId}"]`);
  if (target) target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}
