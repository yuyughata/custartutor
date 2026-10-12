// Fencing for text that came from an uploaded document, and context blocks for everything else.
//
// Everything that originates in an upload (the scheme text, topics, subtopics, and the unit titles and
// objectives derived from them) goes between DOCUMENT_DATA markers. The system prompt tells the model that
// anything between those markers is DATA, never instructions. The markers cannot be forged from inside the data:
// every `<` and `>` of JSON data is written as a \u escape, and runs of three or more in plain text are replaced
// by look-alike characters.
//
// Trusted, code-built context (stage, ids, counts, errors found by the checker) goes in `<context>` blocks.
// The demo model reads both kinds back with `parseDataBlocks` / `parseContextBlocks`.

export const DATA_OPEN = '<<<DOCUMENT_DATA';
export const DATA_CLOSE = 'DOCUMENT_DATA>>>';

function safeName(name: string): string {
  return name.replace(/[^A-Za-z0-9_.-]/g, '_');
}

function escapeJson(json: string): string {
  return json.replace(/</g, '\\u003c').replace(/>/g, '\\u003e');
}

function neutralise(text: string): string {
  return text.replace(/<{3,}/g, '\u2039\u2039\u2039').replace(/>{3,}/g, '\u203a\u203a\u203a');
}

/** Untrusted structured data (from an upload) as a fenced JSON block. */
export function dataBlock(name: string, value: unknown): string {
  return `${DATA_OPEN} name="${safeName(name)}">>>\n${escapeJson(JSON.stringify(value, null, 1))}\n${DATA_CLOSE}`;
}

/** Untrusted plain text (for example a pasted scheme) as a fenced block. */
export function dataText(name: string, text: string): string {
  return `${DATA_OPEN} name="${safeName(name)}">>>\n${neutralise(text)}\n${DATA_CLOSE}`;
}

/** Trusted structured context built by the engine. */
export function contextBlock(name: string, value: unknown): string {
  return `<context name="${safeName(name)}">\n${escapeJson(JSON.stringify(value, null, 1))}\n</context>`;
}

const DATA_RE = /<<<DOCUMENT_DATA name="([^"]*)">>>\n([\s\S]*?)\nDOCUMENT_DATA>>>/g;
const CONTEXT_RE = /<context name="([^"]*)">\n([\s\S]*?)\n<\/context>/g;

function parseBlocks(re: RegExp, text: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const match of text.matchAll(re)) {
    try {
      out[match[1]!] = JSON.parse(match[2]!) as unknown;
    } catch {
      out[match[1]!] = match[2]!;
    }
  }
  return out;
}

export function parseDataBlocks(text: string): Record<string, unknown> {
  return parseBlocks(DATA_RE, text);
}

export function parseContextBlocks(text: string): Record<string, unknown> {
  return parseBlocks(CONTEXT_RE, text);
}

/** The text with every fenced data region removed. Used by tests and by the injection check. */
export function stripDataBlocks(text: string): string {
  return text.replace(DATA_RE, '[data removed]');
}
