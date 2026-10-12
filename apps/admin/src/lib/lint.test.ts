import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { buildLintView, parseVersionContent } from './lint';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('parseVersionContent', () => {
  it('parses the golden unit', () => {
    const parsed = parseVersionContent(clone(goldenUnit2));
    expect(parsed.unit?.kind).toBe('lesson');
    expect(parsed.parseIssues).toEqual([]);
  });

  it('turns a parse failure into readable issues with paths', () => {
    const broken = clone(goldenUnit2) as unknown as { header: { title: string } };
    broken.header.title = '   ';
    const parsed = parseVersionContent(broken);
    expect(parsed.unit).toBeNull();
    expect(parsed.parseIssues[0]).toMatchObject({ code: 'does_not_parse', path: 'header.title' });
  });

  it('never throws on garbage', () => {
    for (const garbage of [null, 5, 'text', [], {}]) {
      const parsed = parseVersionContent(garbage);
      expect(parsed.unit).toBeNull();
      expect(parsed.parseIssues.length).toBeGreaterThan(0);
    }
  });
});

describe('buildLintView', () => {
  const good = parseVersionContent(clone(goldenUnit2));

  it('lets the golden unit through, with its allowed warnings', () => {
    const view = buildLintView(null, good);
    expect(view.errors).toEqual([]);
    expect(view.blocking).toBe(false);
    expect(view.parseFailed).toBe(false);
    expect(view.hasStoredReport).toBe(false);
    expect(view.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(['no_global_window']));
  });

  it('merges the stored report with a fresh run and removes duplicates', () => {
    const stored = {
      errors: [
        {
          code: 'missing_section',
          severity: 'concern',
          message: 'Required section "practice" is missing.',
        },
      ],
      warnings: [{ code: 'no_global_window', severity: 'note', message: 'stored copy' }],
      ok: false,
      review: [
        {
          code: 'reading_level',
          severity: 'concern',
          message: 'Sentences are long.',
          path: 'sections[1]',
        },
      ],
      summary: 'Drafted all sections.',
    };
    const view = buildLintView(stored, good);
    expect(view.hasStoredReport).toBe(true);
    expect(view.errors).toHaveLength(1);
    expect(view.blocking).toBe(true);
    expect(view.review).toEqual([
      {
        code: 'reading_level',
        severity: 'concern',
        message: 'Sentences are long.',
        path: 'sections[1]',
      },
    ]);
    expect(view.summary).toBe('Drafted all sections.');
    const codes = view.warnings.map((w) => w.code);
    expect(codes.filter((c) => c === 'no_global_window').length).toBeGreaterThanOrEqual(1);
  });

  it('blocks when the content does not parse, whatever the stored report says', () => {
    const view = buildLintView(
      { errors: [], warnings: [], ok: true, review: [] },
      parseVersionContent({}),
    );
    expect(view.parseFailed).toBe(true);
    expect(view.blocking).toBe(true);
    expect(view.errors[0]?.code).toBe('does_not_parse');
  });

  it('defaults review severity to note and survives a malformed stored report', () => {
    const view = buildLintView(
      { review: [{ code: 'facts', message: 'Check the capital.' }] },
      good,
    );
    expect(view.review[0]?.severity).toBe('note');
    const odd = buildLintView('not a report', good);
    expect(odd.hasStoredReport).toBe(false);
    expect(odd.blocking).toBe(false);
  });
});
