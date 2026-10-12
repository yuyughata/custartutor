import type { ReactNode } from 'react';

/** Phones have no in-app page preview (no web view is bundled): printing and sharing are the way to see the sheet. */
export function WorksheetPreview(_props: { html: string; title: string }): ReactNode {
  return null;
}

export const HAS_PREVIEW = false;
