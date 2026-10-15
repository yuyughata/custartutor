/**
 * Scrolls to the field of the editor with this key and puts the cursor in it. The first key that names a field on the
 * page wins (the field itself, then the card that holds it). Returns whether one was found.
 */
const FOCUSABLE = 'input, textarea, select, button, [tabindex]:not([tabindex="-1"])';

export function focusField(keys: readonly string[]): boolean {
  if (typeof document === 'undefined') return false;
  for (const key of keys) {
    const escaped = key.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const target = document.querySelector<HTMLElement>(`[data-field="${escaped}"]`);
    if (!target) continue;
    target.scrollIntoView({ block: 'center', behavior: 'smooth' });
    const focusable = target.matches(FOCUSABLE)
      ? target
      : target.querySelector<HTMLElement>(FOCUSABLE);
    focusable?.focus({ preventScroll: true });
    const previous = target.style.outline;
    target.style.outline = '3px solid #c6791e';
    target.style.outlineOffset = '3px';
    window.setTimeout(() => {
      target.style.outline = previous;
      target.style.outlineOffset = '';
    }, 2200);
    return true;
  }
  return false;
}
