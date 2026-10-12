import { createElement, type ReactNode } from 'react';

/** The sheet exactly as it will print, in a frame (web only). */
export function WorksheetPreview({ html, title }: { html: string; title: string }): ReactNode {
  return createElement('iframe', {
    title,
    srcDoc: html,
    'data-testid': 'worksheet-preview',
    style: {
      width: '100%',
      height: 620,
      border: '2px solid #c9d6d3',
      borderRadius: 8,
      background: '#fff',
    },
  });
}

export const HAS_PREVIEW = true;
