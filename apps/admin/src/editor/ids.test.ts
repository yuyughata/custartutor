import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { Id } from '@custar/content-schema';
import { allIdsIn, nextFreeId, questionIdPrefix, sectionIdPrefix } from './ids';

describe('nextFreeId', () => {
  it('is the prefix plus the next free number', () => {
    expect(nextFreeId('practice', new Set())).toBe('practice_1');
    expect(nextFreeId('practice', new Set(['practice_1']))).toBe('practice_2');
    expect(nextFreeId('practice', new Set(['practice_1', 'practice_3']))).toBe('practice_2');
  });

  it('is deterministic: the same taken set always gives the same id', () => {
    const taken = new Set(['q_mcq_1', 'q_mcq_2']);
    expect(nextFreeId('q_mcq', taken)).toBe(nextFreeId('q_mcq', new Set(taken)));
    expect(nextFreeId('q_mcq', taken)).toBe('q_mcq_3');
  });

  it('always produces a valid id', () => {
    for (const prefix of ['Weird Prefix!', '9lives', '__x', 'a-b']) {
      expect(Id.safeParse(nextFreeId(prefix, new Set())).success).toBe(true);
    }
    expect(Id.safeParse(nextFreeId(sectionIdPrefix('think_deeper'), new Set())).success).toBe(true);
    expect(Id.safeParse(nextFreeId(questionIdPrefix('fill_blank'), new Set())).success).toBe(true);
  });

  it('never reuses an id that was ever published', () => {
    const published = new Set(['concept_1', 'concept_2']);
    expect(nextFreeId('concept', published)).toBe('concept_3');
  });
});

describe('allIdsIn', () => {
  it('collects section, question, node, hotspot and variant ids', () => {
    const ids = allIdsIn(goldenUnit2);
    for (const id of [
      'come_and_explore',
      'wb_match_places',
      'n_intro',
      'variant_places',
      'qf_gutter',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('copes with junk', () => {
    expect(allIdsIn(null).size).toBe(0);
    expect(allIdsIn('x').size).toBe(0);
    expect(allIdsIn({ questions: { a: {} } }).has('a')).toBe(true);
  });
});
