// Small pure helpers for the block editors: what a block says in one line (for its collapsed card) and the table
// operations that keep every row as wide as the header (the schema refuses a ragged table).
import { stripInlineMarkup } from '@custar/content-schema';

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function clip(text: string, max = 80): string {
  const plain = stripInlineMarkup(text).replace(/\s+/g, ' ').trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trimEnd()}…` : plain;
}

/** One line that says what a block is about, for its collapsed card. Empty when the block has no words yet. */
export function blockSummary(block: unknown): string {
  if (!isRec(block)) return '';
  switch (block.type) {
    case 'paragraph':
    case 'callout':
      return clip(str(block.text));
    case 'bullets': {
      const items = Array.isArray(block.items) ? block.items.filter(isRec) : [];
      return clip(`${items.length} item${items.length === 1 ? '' : 's'}: ${str(items[0]?.text)}`);
    }
    case 'definition':
      return clip(`${str(block.term)}: ${str(block.meaning)}`);
    case 'example':
      return clip(`${str(block.label)}: ${str(block.text)}`);
    case 'dialogue': {
      const lines = Array.isArray(block.lines) ? block.lines.filter(isRec) : [];
      return clip(`${lines.length} line${lines.length === 1 ? '' : 's'}: ${str(lines[0]?.text)}`);
    }
    case 'illustration':
      return clip(str(block.brief) || str(block.alt));
    case 'activity_steps': {
      const steps = Array.isArray(block.steps) ? block.steps.filter(isRec) : [];
      return clip(`${steps.length} step${steps.length === 1 ? '' : 's'}: ${str(steps[0]?.text)}`);
    }
    case 'table': {
      const headers = Array.isArray(block.headers) ? block.headers.length : 0;
      const rows = Array.isArray(block.rows) ? block.rows.length : 0;
      return `${headers} column${headers === 1 ? '' : 's'}, ${rows} row${rows === 1 ? '' : 's'}`;
    }
    case 'question':
      return str(block.question_id);
    case 'unknown':
      return `unrecognised block type "${str(block.original_type)}"`;
    default:
      return '';
  }
}

function headersOf(table: Rec): string[] {
  return Array.isArray(table.headers) ? table.headers.map(str) : [];
}

function rowsOf(table: Rec): string[][] {
  return Array.isArray(table.rows) ? table.rows.map((row) => (Array.isArray(row) ? row.map(str) : [])) : [];
}

export const TABLE_MAX_COLUMNS = 8;
export const TABLE_MAX_ROWS = 40;

export function tableAddColumn(table: Rec): Rec {
  const headers = headersOf(table);
  if (headers.length >= TABLE_MAX_COLUMNS) return table;
  return { ...table, headers: [...headers, ''], rows: rowsOf(table).map((row) => [...row, '']) };
}

/** Removes a column from the header and from every row; the last column cannot go (a table needs a header). */
export function tableRemoveColumn(table: Rec, column: number): Rec {
  const headers = headersOf(table);
  if (headers.length <= 1 || column < 0 || column >= headers.length) return table;
  return {
    ...table,
    headers: headers.filter((_, i) => i !== column),
    rows: rowsOf(table).map((row) => row.filter((_, i) => i !== column)),
  };
}

export function tableAddRow(table: Rec): Rec {
  const rows = rowsOf(table);
  if (rows.length >= TABLE_MAX_ROWS) return table;
  return { ...table, rows: [...rows, headersOf(table).map(() => '')] };
}

/** At least one row stays. */
export function tableRemoveRow(table: Rec, row: number): Rec {
  const rows = rowsOf(table);
  if (rows.length <= 1 || row < 0 || row >= rows.length) return table;
  return { ...table, rows: rows.filter((_, i) => i !== row) };
}
