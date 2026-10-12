/** Scrolls the page to an element showing this text. Only the web build can; elsewhere it does nothing. */
export function scrollToText(_text: string, _within?: string): void {
  // Native builds do not use this (the admin app is not shipped to phones).
}

/** Scrolls the element with this testID into view (the progress panel when a job starts). Web only. */
export function scrollToTestId(_testId: string): void {
  // Native builds do not use this.
}
