import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { lintVersionIds, type UnitContent } from '@custar/content-schema';
import type { PublishedSnapshot } from '../api/types';
import { removeNode, removeQuestion, removeSection, sections } from './ops';
import { getAt, setAt } from './path';
import {
  allPublishedIds,
  droppedSoftIds,
  protection,
  publishedIdIssues,
  publishedIdsOf,
} from './stableIds';

const gold = goldenUnit2 as UnitContent;

function snapshot(version: number, content: unknown): PublishedSnapshot {
  return {
    id: `p${version}`,
    version_no: version,
    is_current: false,
    published_at: '2026-10-01T00:00:00Z',
    content: content as never,
  };
}

describe('published ids', () => {
  it('collects every id kind from the published snapshots, with the versions that had them', () => {
    const v2 = removeSection(gold, 0).unit;
    const ids = publishedIdsOf([snapshot(1, gold), snapshot(2, v2)]);
    expect(ids.sections.get('come_and_explore')).toEqual([1]);
    expect(ids.sections.get('remember_senses')).toEqual([1, 2]);
    expect(ids.questions.get('wb_match_places')).toEqual([1, 2]);
    expect(ids.nodes.has('n_intro')).toBe(true);
    expect(ids.variants.has('variant_places')).toBe(true);
    expect(allPublishedIds(ids).has('wb_match_places')).toBe(true);
    expect(publishedIdsOf([]).sections.size).toBe(0);
  });

  it('an id of a published snapshot is protected and says why; others are free to delete', () => {
    const ids = publishedIdsOf([snapshot(3, gold)]);
    const guarded = protection('section', 'practice_time', ids);
    expect(guarded.protected).toBe(true);
    expect(guarded.reason).toContain('version 3');
    expect(guarded.reason).toContain('cannot be deleted');
    expect(protection('question', 'wb_neighbour', ids).protected).toBe(true);
    expect(protection('section', 'brand_new', ids)).toEqual({ protected: false, versions: [], reason: null });
    expect(protection('section', 'practice_time', null).protected).toBe(false);
  });
});

describe('the check against the published history', () => {
  it('is quiet when nothing was dropped, even if text changed', () => {
    const edited = setAt(gold, ['sections', 0, 'heading'], 'A new heading');
    expect(publishedIdIssues(edited, [snapshot(1, gold)])).toEqual([]);
  });

  it('reports a dropped section and a dropped question, naming the versions', () => {
    const index = sections(gold).findIndex((s) => s.id === 'places_in_school');
    const without = removeQuestion(removeSection(gold, index).unit, 'wb_match_places').unit;
    const issues = publishedIdIssues(without, [snapshot(1, gold), snapshot(2, gold)]);
    const codes = issues.map((i) => i.code).sort();
    expect(codes).toEqual(['question_id_dropped', 'section_id_dropped']);
    const section = issues.find((i) => i.code === 'section_id_dropped')!;
    expect(section.severity).toBe('error');
    expect(section.message).toContain('versions 1, 2');
    expect(section.path).toEqual(['sections', 'places_in_school']);
  });

  it('agrees with content-schema lintVersionIds for a single snapshot', () => {
    const without = removeSection(gold, 3).unit;
    const direct = lintVersionIds(gold, without).errors.map((e) => e.code);
    const wrapped = publishedIdIssues(without, [snapshot(1, gold)]).map((e) => e.code);
    expect(wrapped).toEqual(direct);
  });

  it('checks EVERY published snapshot, not only the latest', () => {
    const v2 = removeSection(gold, 0).unit; // version 2 already lacks come_and_explore
    const issues = publishedIdIssues(v2, [snapshot(1, gold), snapshot(2, v2)]);
    expect(issues.map((i) => i.code)).toEqual(['section_id_dropped']);
    expect(issues[0]?.message).toContain('version 1');
  });

  it('a snapshot that no longer parses is still compared by its ids', () => {
    const odd = { ...(gold as object), header: { nonsense: true } };
    const without = removeSection(gold, 0).unit;
    expect(publishedIdIssues(without, [snapshot(1, odd)]).length).toBe(1);
  });

  it('dropping a tutor line, picture area or practice set is a warning, not a block', () => {
    const ids = publishedIdsOf([snapshot(1, gold)]);
    const withoutNode = removeNode(gold, 0, 0).unit;
    const warnings = droppedSoftIds(withoutNode, ids);
    expect(warnings.some((w) => w.code === 'tutor_node_id_dropped' && w.message.includes('n_intro'))).toBe(true);
    expect(warnings.every((w) => w.severity === 'warning')).toBe(true);
    expect(droppedSoftIds(gold, ids)).toEqual([]);
    const noVariants = setAt(gold, ['workbook', 'practice_variants'], []);
    expect(droppedSoftIds(noVariants, ids).map((w) => w.code)).toContain('variant_id_dropped');
    expect(getAt(gold, ['workbook', 'practice_variants'])).toHaveLength(2);
  });
});
