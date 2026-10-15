import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { lintUnit, type UnitContent } from '@custar/content-schema';
import type { PublishedSnapshot } from '../api/types';
import { addQuestion, addSection, removeQuestion, removeSection, sections } from './ops';
import { getAt, setAt } from './path';
import { publishedIdsOf } from './stableIds';
import { countUnder, issuesAt, storedReportFor, validateUnit } from './validate';

const gold = goldenUnit2 as UnitContent;
const none = new Set<string>();
const ctx = { unit_no: 2, week_no: 2, chapter: { number: 1, title: 'Our World Around Us' } };

function codes(result: ReturnType<typeof validateUnit>, severity?: 'error' | 'warning'): string[] {
  return result.issues.filter((i) => !severity || i.severity === severity).map((i) => i.code);
}

describe('validateUnit', () => {
  it('passes the golden unit with its two accepted warnings and nothing else', () => {
    const result = validateUnit(gold, { context: ctx });
    expect(result.canSave).toBe(true);
    expect(result.errors).toBe(0);
    expect(result.parsed).not.toBeNull();
    expect(codes(result, 'warning').sort()).toEqual(['no_global_window', 'reading_level']);
    expect(result.lint?.ok).toBe(true);
  });

  it('gives the same lint warnings as lintUnit', () => {
    const result = validateUnit(gold);
    const direct = lintUnit(gold);
    expect(
      result.issues.filter((i) => i.source === 'lint' && i.severity === 'warning'),
    ).toHaveLength(direct.warnings.length);
  });

  it('a blank heading is a schema error beside the heading field, and blocks saving', () => {
    const blank = setAt(gold, ['sections', 1, 'heading'], '   ');
    const result = validateUnit(blank);
    expect(result.canSave).toBe(false);
    const here = issuesAt(result.issues, ['sections', 1, 'heading']);
    expect(here).toHaveLength(1);
    expect(here[0]).toMatchObject({ severity: 'error', source: 'schema' });
    expect(here[0]?.message).toContain('blank');
    expect(result.parsed).toBeNull();
  });

  it('shows lint beside the field even while the content does not parse', () => {
    const noObjective = setAt(
      setAt(gold, ['header', 'objective'], ''),
      ['sections', 1, 'heading'],
      '',
    );
    const result = validateUnit(noObjective);
    expect(codes(result, 'error')).toContain('objective_empty');
    expect(issuesAt(result.issues, ['header', 'objective']).length).toBeGreaterThan(0);
  });

  it('answer problems are shown once, at the answer editor, with where inside', () => {
    const wrong = setAt(
      gold,
      ['questions', 'wb_fill_cook', 'prompt'],
      'We cook in the ____ and the ____.',
    );
    const result = validateUnit(wrong);
    const here = issuesAt(result.issues, ['questions', 'wb_fill_cook', 'answer']);
    expect(here.length).toBeGreaterThan(0);
    // the schema message and the lint message about the same thing are merged
    const sameThing = result.issues.filter((i) => i.message.includes('2 blank(s)'));
    expect(sameThing).toHaveLength(1);
    expect(result.canSave).toBe(false);
  });

  it('a new empty section is blocked until it has a heading and text', () => {
    const { unit } = addSection(gold, 'concept', none);
    const result = validateUnit(unit);
    expect(result.canSave).toBe(false);
    const index = sections(unit).length - 1;
    expect(issuesAt(result.issues, ['sections', index, 'heading']).length).toBe(1);
    expect(issuesAt(result.issues, ['sections', index, 'blocks', 0, 'text']).length).toBe(1);
    expect(countUnder(result.issues, ['sections', index]).errors).toBe(2);
    expect(countUnder(result.issues, ['sections', 0]).errors).toBe(0);
  });

  it('a question that nothing refers to is fine, but a dangling reference is an error', () => {
    const { unit: withQuestion } = addQuestion(gold, 'draw', none);
    expect(validateUnit(withQuestion).errors).toBeGreaterThan(0); // blank prompt
    const dangling = setAt(gold, ['workbook', 'application_task_id'], 'nobody');
    const result = validateUnit(dangling);
    expect(result.issues.some((i) => i.message.includes('is not defined in questions'))).toBe(true);
    expect(issuesAt(result.issues, ['workbook', 'application_task_id']).length).toBeGreaterThan(0);
  });

  it('an enrichment overflow is a lint error with no field, shown at the unit', () => {
    let unit: UnitContent = gold;
    for (const type of ['across_subjects', 'window_to_world'] as const)
      unit = addSection(unit, type, none).unit;
    expect(codes(validateUnit(unit), 'error')).toContain('enrichment_count');
  });

  it('refuses to save a working copy that lost a published id, and says which', () => {
    const snapshots: PublishedSnapshot[] = [
      {
        id: 'p1',
        version_no: 1,
        is_current: true,
        published_at: '2026-10-01T00:00:00Z',
        content: gold as never,
      },
    ];
    const index = sections(gold).findIndex((s) => s.id === 'quick_fire');
    const without = removeSection(gold, index).unit;
    const result = validateUnit(without, {
      snapshots,
      publishedIds: publishedIdsOf(snapshots),
      context: ctx,
    });
    expect(result.canSave).toBe(false);
    const dropped = result.issues.find((i) => i.code === 'section_id_dropped');
    expect(dropped?.source).toBe('ids');
    expect(dropped?.message).toContain('version 1');
    // the same edit on a unit nobody published is fine for ids
    expect(codes(validateUnit(without, { context: ctx }), 'error')).not.toContain(
      'section_id_dropped',
    );
    // and dropping a question
    const noQuestion = removeQuestion(gold, 'wb_neighbour').unit;
    expect(
      validateUnit(noQuestion, { snapshots }).issues.some((i) => i.code === 'question_id_dropped'),
    ).toBe(true);
  });

  it('warns when the header numbers differ from the unit row (and never blocks)', () => {
    const result = validateUnit(gold, {
      context: { unit_no: 3, week_no: 2, chapter: ctx.chapter },
    });
    const note = result.issues.find((i) => i.code === 'header_differs_from_unit');
    expect(note).toMatchObject({ severity: 'warning', source: 'editor' });
    expect(result.canSave).toBe(true);
  });

  it('warns about a ** with no partner', () => {
    const odd = setAt(gold, ['sections', 0, 'blocks', 0, 'text'], 'Half **bold');
    const note = validateUnit(odd).issues.find((i) => i.code === 'unmatched_bold');
    expect(note?.owner).toEqual(['sections', 0, 'blocks', 0, 'text']);
    expect(note?.severity).toBe('warning');
  });

  it('survives content that is not a unit at all', () => {
    for (const junk of [
      null,
      5,
      'x',
      [],
      {},
      { kind: 'lesson' },
      { kind: 'lesson', schema_version: 99 },
    ]) {
      const result = validateUnit(junk);
      expect(result.canSave).toBe(false);
      expect(result.errors).toBeGreaterThan(0);
    }
  });

  it('keeps issue keys unique', () => {
    const result = validateUnit(
      setAt(
        gold,
        ['sections', 0, 'blocks'],
        [
          { type: 'paragraph', text: '' },
          { type: 'paragraph', text: '' },
        ],
      ),
    );
    const keys = result.issues.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('storedReportFor', () => {
  it('is the deterministic lint in the stored shape, with no model review', () => {
    const report = storedReportFor(validateUnit(gold));
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.review).toEqual([]);
    expect(report.warnings.map((w) => w.code).sort()).toEqual([
      'no_global_window',
      'reading_level',
    ]);
    expect(report.warnings.every((w) => w.severity === 'note')).toBe(true);
    expect(report.summary).toContain('by hand');
  });

  it('carries lint errors as concerns when there are any', () => {
    const report = storedReportFor(validateUnit(setAt(gold, ['header', 'objective'], '  ')));
    expect(report.ok).toBe(false);
    expect(report.errors.every((e) => e.severity === 'concern')).toBe(true);
    expect(getAt(report, ['errors', 0, 'code'])).toBeDefined();
  });
});
