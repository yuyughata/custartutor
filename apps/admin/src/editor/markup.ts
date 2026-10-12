// The one inline markup a unit's text fields allow: `**bold**` and nothing else. Pure helpers for the editor's Bold
// button and shortcut, the live preview and the character count. `splitBold` agrees with the lesson renderer's
// (an odd number of `**` markers means nothing is bold: the markers stay literal), `plainText` with content-schema's
// `stripInlineMarkup` (what the tutor speaks and the reading-level rule reads).
import { stripInlineMarkup } from '@custar/content-schema';

export interface Segment {
  text: string;
  bold: boolean;
}

export function splitBold(input: string): Segment[] {
  const parts = input.split('**');
  if (parts.length % 2 === 0) return input === '' ? [] : [{ text: input, bold: false }];
  return parts
    .map((text, index) => ({ text, bold: index % 2 === 1 }))
    .filter((part) => part.text.length > 0);
}

/** True when the text has a `**` marker that has no partner (it will show as two stars). */
export function hasUnmatchedMarker(text: string): boolean {
  return (text.split('**').length - 1) % 2 === 1;
}

export function plainText(text: string): string {
  return stripInlineMarkup(text);
}

/** Characters as a person counts them (code points, so an accented letter or an emoji is one). */
export function charCount(text: string): number {
  return Array.from(text).length;
}

export function wordCount(text: string): number {
  return plainText(text)
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export interface Selection {
  start: number;
  end: number;
}

export interface Edit {
  text: string;
  selection: Selection;
}

const MARK = '**';

/**
 * The Bold button / Ctrl+B. With nothing selected it inserts an empty pair and puts the caret between the stars.
 * With a selection it wraps it (the markers sit just inside any spaces at the ends, and stars already inside the
 * selection are removed first so spans never nest), and it UNWRAPS a selection that is already bold: either the
 * stars are just outside the selection or the selection includes them.
 */
export function toggleBold(text: string, selection: Selection): Edit {
  const start = Math.max(0, Math.min(selection.start, selection.end, text.length));
  const end = Math.max(0, Math.min(Math.max(selection.start, selection.end), text.length));

  if (start === end) {
    return {
      text: `${text.slice(0, start)}${MARK}${MARK}${text.slice(end)}`,
      selection: { start: start + 2, end: start + 2 },
    };
  }

  const selected = text.slice(start, end);
  // Unwrap: the stars are just outside the selection ...
  if (text.slice(start - 2, start) === MARK && text.slice(end, end + 2) === MARK && start >= 2) {
    return {
      text: `${text.slice(0, start - 2)}${selected}${text.slice(end + 2)}`,
      selection: { start: start - 2, end: end - 2 },
    };
  }
  // ... or the selection includes them.
  if (selected.length >= 4 && selected.startsWith(MARK) && selected.endsWith(MARK)) {
    const inner = selected.slice(2, -2);
    return {
      text: `${text.slice(0, start)}${inner}${text.slice(end)}`,
      selection: { start, end: start + inner.length },
    };
  }

  const leading = selected.length - selected.trimStart().length;
  const trailing = selected.length - selected.trimEnd().length;
  if (leading + trailing >= selected.length) {
    // Only spaces selected: treat it as a caret.
    return toggleBold(text, { start: end, end });
  }
  const innerStart = start + leading;
  const innerEnd = end - trailing;
  const inner = text.slice(innerStart, innerEnd).split(MARK).join('');
  const next = `${text.slice(0, innerStart)}${MARK}${inner}${MARK}${text.slice(innerEnd)}`;
  return { text: next, selection: { start: innerStart + 2, end: innerStart + 2 + inner.length } };
}
