// Live validation of the working copy: the strict parse (readable paths), the publish-gate lint, the stable-id check
// against the published history, and a few editor-only notes, merged into one list of issues, each with the field it
// is shown beside. Errors block "Save as new version"; warnings never do. Pure: the editor calls it on every
// (debounced) change.
import {
  UnitParseError,
  lintUnit,
  parseUnit,
  type LintReport,
  type UnitContent,
} from '@custar/content-schema';
import type { StoredLintReport } from '@custar/authoring-core';
import type { PublishedSnapshot } from '../api/types';
import { parsePath } from '../lib/lintPaths';
import { headerDrift, type HeaderContext } from './headerStamp';
import { ownerOf, remainder } from './owners';
import { hasUnmatchedMarker } from './markup';
import { pathKey, type Path } from './path';
import { droppedSoftIds, publishedIdIssues, type PublishedIds } from './stableIds';

export type IssueSource = 'schema' | 'lint' | 'ids' | 'editor';

export interface EditorIssue {
  key: string;
  severity: 'error' | 'warning';
  source: IssueSource;
  code: string;
  message: string;
  /** Where the schema or lint put it. */
  path: Path;
  /** The field or card it is shown beside. */
  owner: Path;
  /** What was cut off between `path` and `owner`, for the message. */
  where: string;
}

export interface ValidateOptions {
  snapshots?: readonly PublishedSnapshot[];
  publishedIds?: PublishedIds | null;
  context?: HeaderContext | null;
}

export interface ValidationResult {
  issues: EditorIssue[];
  errors: number;
  warnings: number;
  /** Errors block saving; warnings do not. */
  canSave: boolean;
  /** The unit in canonical form (what is saved) when it parses. */
  parsed: UnitContent | null;
  lint: LintReport | null;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Lint names a section by id (`sections.places_in_home`); the editor addresses it by position. */
function normalizePath(path: Path, unit: unknown): Path {
  if (
    path[0] === 'sections' &&
    typeof path[1] === 'string' &&
    isRec(unit) &&
    Array.isArray(unit.sections)
  ) {
    const index = unit.sections.findIndex((s) => isRec(s) && s.id === path[1]);
    if (index >= 0) return ['sections', index, ...path.slice(2)];
  }
  return path;
}

function schemaIssues(raw: unknown): {
  parsed: UnitContent | null;
  problems: { path: string; message: string }[];
} {
  try {
    return { parsed: parseUnit(raw), problems: [] };
  } catch (error) {
    if (error instanceof UnitParseError) return { parsed: null, problems: error.issues };
    return {
      parsed: null,
      problems: [
        {
          path: '',
          message: error instanceof Error ? error.message : 'The content could not be read.',
        },
      ],
    };
  }
}

function walkStrings(
  value: unknown,
  path: (string | number)[],
  visit: (path: Path, text: string) => void,
): void {
  if (typeof value === 'string') visit(path, value);
  else if (Array.isArray(value))
    value.forEach((item, index) => walkStrings(item, [...path, index], visit));
  else if (isRec(value))
    for (const [key, item] of Object.entries(value)) walkStrings(item, [...path, key], visit);
}

export function validateUnit(working: unknown, options: ValidateOptions = {}): ValidationResult {
  const issues: EditorIssue[] = [];
  const counts = new Map<string, number>();
  const add = (
    severity: EditorIssue['severity'],
    source: IssueSource,
    code: string,
    message: string,
    rawPath: Path,
  ): void => {
    const path = normalizePath(rawPath, working);
    const owner = ownerOf(path);
    const base = `${source}:${code}:${pathKey(path)}`;
    const n = (counts.get(base) ?? 0) + 1;
    counts.set(base, n);
    issues.push({
      key: n === 1 ? base : `${base}#${n}`,
      severity,
      source,
      code,
      message,
      path,
      owner,
      where: remainder(path, owner),
    });
  };

  // 1. the strict parse
  const { parsed, problems } = schemaIssues(working);
  for (const problem of problems)
    add('error', 'schema', 'does_not_parse', problem.message, parsePath(problem.path));

  // 2. the publish-gate lint (on the parsed unit; on the raw one while it does not parse, as far as it can)
  let lint: LintReport | null = null;
  try {
    lint = lintUnit((parsed ?? working) as UnitContent);
  } catch {
    lint = null;
  }
  if (lint) {
    const schemaMessages = issues.filter((i) => i.source === 'schema');
    const duplicate = (message: string, path: Path): boolean =>
      schemaMessages.some(
        (s) =>
          pathKey(s.path) === pathKey(path) &&
          (message.toLowerCase().includes(s.message.toLowerCase().replace(/\.$/, '')) ||
            s.message.toLowerCase().includes(message.toLowerCase().replace(/\.$/, ''))),
      );
    for (const issue of lint.errors) {
      const path = issue.path ? parsePath(issue.path) : [];
      if (!duplicate(issue.message, normalizePath(path, working)))
        add('error', 'lint', issue.code, issue.message, path);
    }
    for (const issue of lint.warnings) {
      add('warning', 'lint', issue.code, issue.message, issue.path ? parsePath(issue.path) : []);
    }
  }

  // 3. ids that were published must still be there
  if (options.snapshots && options.snapshots.length > 0) {
    for (const issue of publishedIdIssues(working, options.snapshots)) {
      add('error', 'ids', issue.code, issue.message, issue.path);
    }
    if (options.publishedIds) {
      for (const issue of droppedSoftIds(working, options.publishedIds)) {
        add('warning', 'ids', issue.code, issue.message, issue.path);
      }
    }
  }

  // 4. editor notes
  if (options.context && isRec(working) && isRec(working.header)) {
    for (const drift of headerDrift(working as UnitContent, options.context)) {
      add(
        'warning',
        'editor',
        'header_differs_from_unit',
        `${drift.label} in the header is ${drift.have}; the unit is now ${drift.want}. Saving updates the header.`,
        ['header'],
      );
    }
  }
  walkStrings(working, [], (path, text) => {
    if (hasUnmatchedMarker(text)) {
      add(
        'warning',
        'editor',
        'unmatched_bold',
        'A ** marker has no partner, so it will show as two stars. Close the bold with another ** or remove it.',
        path,
      );
    }
  });

  const errors = issues.filter((i) => i.severity === 'error').length;
  return {
    issues,
    errors,
    warnings: issues.length - errors,
    canSave: errors === 0,
    parsed,
    lint,
  };
}

/** The report stored with a hand-made version: the deterministic lint, nothing from Claude. */
export function storedReportFor(result: ValidationResult): StoredLintReport {
  const flag = (
    issue: { code: string; message: string; path?: string | undefined },
    severity: 'note' | 'concern',
  ): StoredLintReport['errors'][number] => ({
    code: issue.code,
    message: issue.message,
    severity,
    ...(issue.path ? { path: issue.path } : {}),
  });
  const errors = (result.lint?.errors ?? []).map((issue) => flag(issue, 'concern'));
  const warnings = (result.lint?.warnings ?? []).map((issue) => flag(issue, 'note'));
  return {
    errors,
    warnings,
    ok: errors.length === 0,
    review: [],
    summary: 'Edited by hand in the admin editor. No model was involved.',
  };
}

/** The issues beside one owner path (exact match), errors first. */
export function issuesAt(issues: readonly EditorIssue[], owner: Path): EditorIssue[] {
  const key = pathKey(owner);
  return issues
    .filter((issue) => pathKey(issue.owner) === key)
    .sort((a, b) => (a.severity === b.severity ? 0 : a.severity === 'error' ? -1 : 1));
}

/** Count of issues at or below a path, for a card's "N problems inside" roll-up. */
export function countUnder(
  issues: readonly EditorIssue[],
  prefix: Path,
): { errors: number; warnings: number } {
  const key = pathKey(prefix);
  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    const owner = pathKey(issue.owner);
    if (owner === key || owner.startsWith(`${key}.`) || owner.startsWith(`${key}[`)) {
      if (issue.severity === 'error') errors += 1;
      else warnings += 1;
    }
  }
  return { errors, warnings };
}
