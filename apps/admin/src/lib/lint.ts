// What the lint panel shows for one unit version: the report stored with the draft (made by the engine, with
// the previous unit's enrichment as context) merged with a fresh deterministic run in the browser, plus the
// advisory AI review flags. Errors from either block submitting and publishing. Pure.
import { z } from 'zod';
import { lintUnit, parseUnit, UnitParseError, type UnitContent } from '@custar/content-schema';

const LooseFlag = z.object({
  code: z.string(),
  message: z.string(),
  severity: z.enum(['note', 'concern']).optional(),
  path: z.string().optional(),
  week_no: z.number().int().optional(),
});

const LooseStoredReport = z.object({
  errors: z.array(LooseFlag).default([]),
  warnings: z.array(LooseFlag).default([]),
  ok: z.boolean().optional(),
  review: z.array(LooseFlag).default([]),
  summary: z.string().optional(),
});

export interface LintIssue {
  code: string;
  message: string;
  path?: string;
}

export interface ReviewNote {
  code: string;
  message: string;
  severity: 'note' | 'concern';
  path?: string;
}

export interface LintView {
  errors: LintIssue[];
  warnings: LintIssue[];
  /** Advisory notes from the AI review. Never blocking. */
  review: ReviewNote[];
  summary: string | null;
  /** The content does not parse as a unit; the issues are listed in `errors`. */
  parseFailed: boolean;
  /** True when there is any error from either source. */
  blocking: boolean;
  /** Whether a report was stored with the version. */
  hasStoredReport: boolean;
}

function issue(entry: { code: string; message: string; path?: string | undefined }): LintIssue {
  return {
    code: entry.code,
    message: entry.message,
    ...(entry.path !== undefined ? { path: entry.path } : {}),
  };
}

function mergeIssues(...lists: LintIssue[][]): LintIssue[] {
  const seen = new Set<string>();
  const out: LintIssue[] = [];
  for (const entry of lists.flat()) {
    const key = `${entry.code}|${entry.path ?? ''}|${entry.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out;
}

export interface ParsedVersion {
  unit: UnitContent | null;
  parseIssues: LintIssue[];
}

/** Parses version content strictly. Never throws. */
export function parseVersionContent(content: unknown): ParsedVersion {
  try {
    return { unit: parseUnit(content), parseIssues: [] };
  } catch (error) {
    if (error instanceof UnitParseError) {
      return {
        unit: null,
        parseIssues: error.issues.map((entry) => ({
          code: 'does_not_parse',
          message: entry.message,
          ...(entry.path ? { path: entry.path } : {}),
        })),
      };
    }
    return {
      unit: null,
      parseIssues: [
        {
          code: 'does_not_parse',
          message: error instanceof Error ? error.message : 'The content could not be read.',
        },
      ],
    };
  }
}

export function buildLintView(stored: unknown, parsed: ParsedVersion): LintView {
  const report = LooseStoredReport.safeParse(stored ?? {});
  const hasStoredReport = stored !== null && stored !== undefined && report.success;
  const storedReport = report.success ? report.data : LooseStoredReport.parse({});

  const fresh = parsed.unit ? lintUnit(parsed.unit) : null;
  const errors = mergeIssues(
    parsed.parseIssues,
    storedReport.errors.map(issue),
    (fresh?.errors ?? []).map(issue),
  );
  const warnings = mergeIssues(storedReport.warnings.map(issue), (fresh?.warnings ?? []).map(issue));
  const review: ReviewNote[] = storedReport.review.map((entry) => ({
    code: entry.code,
    message: entry.message,
    severity: entry.severity ?? 'note',
    ...(entry.path !== undefined ? { path: entry.path } : {}),
  }));
  return {
    errors,
    warnings,
    review,
    summary: storedReport.summary ?? null,
    parseFailed: parsed.unit === null,
    blocking: errors.length > 0,
    hasStoredReport,
  };
}
