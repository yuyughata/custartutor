// Deciding what to do with a file the person picked for a scheme: a PDF is uploaded and Claude reads it
// natively; a DOCX is turned into text in the browser; plain text is used as it is. Pure, so it is tested.
import { SchemeSource } from '@custar/authoring-core';

export type DocumentKind = 'pdf' | 'docx' | 'text' | 'unsupported';

/** The largest text the `scheme_ingest` params accept (SchemeSource). */
export const MAX_SOURCE_CHARS = 300_000;
/** The `scheme-uploads` bucket limit. */
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

export function classifyDocument(name: string, mimeType?: string | null): DocumentKind {
  const lower = name.toLowerCase();
  const mime = (mimeType ?? '').toLowerCase();
  if (lower.endsWith('.pdf') || mime === 'application/pdf') return 'pdf';
  if (lower.endsWith('.docx') || mime === DOCX_MIME) return 'docx';
  if (lower.endsWith('.txt') || lower.endsWith('.md') || mime.startsWith('text/')) return 'text';
  return 'unsupported';
}

export function unsupportedMessage(name: string): string {
  return name.toLowerCase().endsWith('.doc')
    ? 'Old Word files (.doc) cannot be read. Open it in Word, save it as .docx, and choose that file.'
    : `“${name}” is not a PDF, a Word (.docx) file or a text file.`;
}

export function sizeProblem(kind: DocumentKind, bytes: number): string | null {
  if (bytes === 0) return 'That file is empty.';
  if (kind === 'pdf' && bytes > MAX_UPLOAD_BYTES) return 'That PDF is larger than 20 MB. Split it or remove pages.';
  if (kind !== 'pdf' && bytes > MAX_UPLOAD_BYTES) return 'That file is larger than 20 MB.';
  return null;
}

export interface TextSourceResult {
  source?: Extract<SchemeSource, { type: 'text' }>;
  problem?: string;
}

/** Text typed, pasted or converted from a DOCX, as a `text` source of the job. */
export function textSource(text: string, filename: string): TextSourceResult {
  const clean = text.replace(/\r\n/g, '\n').trim();
  if (clean === '') return { problem: 'There is no text to read. Paste the scheme of work or choose a file.' };
  if (clean.length > MAX_SOURCE_CHARS) {
    return {
      problem: `That text is ${clean.length.toLocaleString('en-GB')} characters long; the limit is ${MAX_SOURCE_CHARS.toLocaleString('en-GB')}. Use only the pages for this term.`,
    };
  }
  return { source: { type: 'text', text: clean, filename } };
}

/** A short preview for the "this is what was read" box. */
export function previewText(text: string, max = 400): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
