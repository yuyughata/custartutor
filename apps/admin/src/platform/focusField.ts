/**
 * Scrolls to the field of the editor with this key and puts the cursor in it. Only the browser can; the first key that
 * names a field on the page wins (the field itself, then the card that holds it). Returns whether one was found.
 */
export function focusField(_keys: readonly string[]): boolean {
  // Native builds do not use this (the admin app is not shipped to phones).
  return false;
}
