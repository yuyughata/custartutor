import { describe, expect, it } from 'vitest';
import { SchemeSource } from '@custar/authoring-core';
import {
  DOCX_MIME,
  MAX_SOURCE_CHARS,
  MAX_UPLOAD_BYTES,
  classifyDocument,
  previewText,
  sizeProblem,
  textSource,
  unsupportedMessage,
} from './documents';

describe('classifyDocument', () => {
  it('goes by extension or mime type', () => {
    expect(classifyDocument('Scheme.PDF', '')).toBe('pdf');
    expect(classifyDocument('x', 'application/pdf')).toBe('pdf');
    expect(classifyDocument('scheme.docx', null)).toBe('docx');
    expect(classifyDocument('x', DOCX_MIME)).toBe('docx');
    expect(classifyDocument('notes.txt')).toBe('text');
    expect(classifyDocument('notes.md', 'text/markdown')).toBe('text');
    expect(classifyDocument('page', 'text/plain')).toBe('text');
    expect(classifyDocument('old.doc', 'application/msword')).toBe('unsupported');
    expect(classifyDocument('photo.png', 'image/png')).toBe('unsupported');
  });

  it('explains an unsupported file in words', () => {
    expect(unsupportedMessage('old.doc')).toMatch(/save it as .docx/);
    expect(unsupportedMessage('photo.png')).toMatch(/not a PDF, a Word/);
  });
});

describe('sizeProblem', () => {
  it('rejects empty and oversized files', () => {
    expect(sizeProblem('pdf', 0)).toMatch(/empty/);
    expect(sizeProblem('pdf', MAX_UPLOAD_BYTES + 1)).toMatch(/20 MB/);
    expect(sizeProblem('docx', MAX_UPLOAD_BYTES + 1)).toMatch(/20 MB/);
    expect(sizeProblem('pdf', 1024)).toBeNull();
  });
});

describe('textSource', () => {
  it('builds a source the job schema accepts', () => {
    const result = textSource('  Week 1: Colours\r\nWeek 2: Shapes  ', 'pasted-text.txt');
    expect(result.problem).toBeUndefined();
    expect(result.source).toEqual({
      type: 'text',
      text: 'Week 1: Colours\nWeek 2: Shapes',
      filename: 'pasted-text.txt',
    });
    expect(SchemeSource.safeParse(result.source).success).toBe(true);
  });

  it('refuses empty text and text over the limit, with a reason', () => {
    expect(textSource('   \n ', 'x.txt').problem).toMatch(/no text to read/);
    const long = textSource('a'.repeat(MAX_SOURCE_CHARS + 1), 'x.txt');
    expect(long.source).toBeUndefined();
    expect(long.problem).toMatch(/limit is 300,000/);
    expect(textSource('a'.repeat(MAX_SOURCE_CHARS), 'x.txt').source).toBeDefined();
  });

  it('previews a short start of the text', () => {
    expect(previewText('one   two\n three')).toBe('one two three');
    expect(previewText('x'.repeat(500), 10)).toBe(`${'x'.repeat(10)}…`);
  });
});
