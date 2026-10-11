import type { z } from 'zod';
import { degradeUnknownBlock, isKnownBlockType } from './blocks';
import { migrateToCurrent } from './migrate';
import { UnitContent } from './unit';

/**
 * Entry points for turning raw JSON (from the database, a pack file or an AI response) into a typed
 * `UnitContent`.
 *
 *  - `parseUnit`        strict: migrate, normalise, reject unrecognised block types, validate with Zod.
 *  - `parseUnitLenient` for READERS (the learner app, old builds): unrecognised block types degrade to
 *                       `{ type: 'unknown' }` instead of failing, so a lesson from a newer pack still opens.
 *
 * Both migrate old `schema_version`s first, normalise every string to Unicode NFC (Yoruba, Igbo and Hausa
 * letters may arrive composed or decomposed), and throw `UnitParseError` with readable paths.
 */

export interface ParseIssue {
  /** For example `sections[2].blocks[0].text`. */
  path: string;
  message: string;
}

export class UnitParseError extends Error {
  readonly issues: ParseIssue[];

  constructor(issues: ParseIssue[]) {
    const shown = issues
      .slice(0, 20)
      .map((issue) => `  ${issue.path || '(root)'}: ${issue.message}`);
    const more = issues.length > 20 ? [`  ... and ${issues.length - 20} more`] : [];
    super(`Invalid unit content (${issues.length} problem(s)):\n${[...shown, ...more].join('\n')}`);
    this.name = 'UnitParseError';
    this.issues = issues;
  }
}

export function formatPath(path: readonly PropertyKey[]): string {
  return path.reduce<string>((out, segment) => {
    if (typeof segment === 'number') return `${out}[${segment}]`;
    const key = String(segment);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return `${out}[${JSON.stringify(key)}]`;
    return out === '' ? key : `${out}.${key}`;
  }, '');
}

function flattenIssue(issue: z.core.$ZodIssue, prefix: readonly PropertyKey[] = []): ParseIssue[] {
  const path = [...prefix, ...issue.path];
  if (issue.code === 'invalid_key') {
    const inner = issue.issues[0]?.message;
    return [
      { path: formatPath(path), message: inner ? `${issue.message}: ${inner}` : issue.message },
    ];
  }
  if (issue.code === 'invalid_union' && issue.errors.length > 0) {
    const first = issue.errors[0];
    if (first && first.length > 0) return first.flatMap((inner) => flattenIssue(inner, path));
  }
  return [{ path: formatPath(path), message: issue.message }];
}

/** Turns a ZodError into a flat list of `{ path, message }`. */
export function formatZodIssues(error: z.ZodError): ParseIssue[] {
  return error.issues.flatMap((issue) => flattenIssue(issue));
}

/** Returns a copy of `value` with every string (and object key) normalised to Unicode NFC. */
export function normalizeDeep(value: unknown): unknown {
  if (typeof value === 'string') return value.normalize('NFC');
  if (Array.isArray(value)) return value.map(normalizeDeep);
  if (typeof value === 'object' && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key.normalize('NFC')] = normalizeDeep(item);
    }
    return out;
  }
  return value;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Applies `fn` to every block of every section of a raw unit, leaving anything malformed alone. */
function mapBlocks(unit: Rec, fn: (block: unknown) => unknown): Rec {
  if (!Array.isArray(unit.sections)) return unit;
  return {
    ...unit,
    sections: unit.sections.map((section: unknown) =>
      isRec(section) && Array.isArray(section.blocks)
        ? { ...section, blocks: section.blocks.map(fn) }
        : section,
    ),
  };
}

function unrecognisedBlockIssues(unit: Rec): ParseIssue[] {
  const issues: ParseIssue[] = [];
  if (!Array.isArray(unit.sections)) return issues;
  unit.sections.forEach((section: unknown, sectionIndex: number) => {
    if (!isRec(section) || !Array.isArray(section.blocks)) return;
    section.blocks.forEach((block: unknown, blockIndex: number) => {
      if (!isKnownBlockType(block)) {
        const type = isRec(block) ? block.type : undefined;
        issues.push({
          path: formatPath(['sections', sectionIndex, 'blocks', blockIndex, 'type']),
          message: `Unrecognised block type ${JSON.stringify(type ?? null)}`,
        });
      }
    });
  });
  return issues;
}

function validate(raw: Rec): UnitContent {
  const result = UnitContent.safeParse(raw);
  if (!result.success) {
    throw new UnitParseError(formatZodIssues(result.error));
  }
  return result.data;
}

/**
 * Strict parse. Throws `SchemaVersionError` (newer or invalid version) or `UnitParseError` (with every
 * problem and its path). A block whose `type` is not recognised is an error here.
 */
export function parseUnit(raw: unknown): UnitContent {
  const { unit } = migrateToCurrent(raw);
  const normalised = normalizeDeep(unit) as Rec;
  const unrecognised = unrecognisedBlockIssues(normalised);
  if (unrecognised.length > 0) throw new UnitParseError(unrecognised);
  return validate(normalised);
}

/**
 * Lenient parse for readers. Same as `parseUnit`, except that blocks with an unrecognised `type` become
 * `{ type: 'unknown', original_type, raw }` (see `parseBlocksLenient`). Everything else is still
 * validated strictly. `lintUnit` reports leftover unknown blocks as errors, so they cannot be published.
 */
export function parseUnitLenient(raw: unknown): UnitContent {
  const { unit } = migrateToCurrent(raw);
  const normalised = normalizeDeep(unit) as Rec;
  return validate(mapBlocks(normalised, degradeUnknownBlock));
}
