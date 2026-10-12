import { describe, expect, it } from 'vitest';
import { diffUnits as coreDiffUnits } from '@custar/authoring-core';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { diffFields, diffUnits, humanPath, summarize, wordDiff } from './diff';

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe('diffUnits', () => {
  it('finds no difference between a unit and its copy', () => {
    const result = diffUnits(goldenUnit2, clone(goldenUnit2));
    expect(result.same).toBe(true);
    expect(result.items).toEqual([]);
    expect(result.counts).toEqual({ added: 0, removed: 0, changed: 0, moved: 0 });
  });

  it('reports a changed paragraph inside a section, with before and after text', () => {
    const next = clone(goldenUnit2) as unknown as { sections: { blocks: { type: string; text?: string }[] }[] };
    const section = next.sections[0]!;
    const index = section.blocks.findIndex((b) => b.type === 'paragraph');
    const before = section.blocks[index]!.text!;
    section.blocks[index]!.text = `${before} Zuri laughs.`;
    const result = diffUnits(goldenUnit2, next);
    expect(result.items).toHaveLength(1);
    const item = result.items[0]!;
    expect(item).toMatchObject({ area: 'section', change: 'changed', id: goldenUnit2.sections[0]!.id });
    expect(item.fields).toHaveLength(1);
    expect(item.fields[0]).toMatchObject({ path: `blocks[${index}].text`, before, after: `${before} Zuri laughs.` });
    expect(item.fields[0]?.label).toBe(`Block ${index + 1} › text`);
  });

  it('reports an added and a removed section by id and heading', () => {
    const next = clone(goldenUnit2) as unknown as { sections: { id: string; heading: string }[] };
    const removed = next.sections.splice(1, 1)[0]!;
    next.sections.push({ ...clone(next.sections[0]!), id: 'extra_one', heading: 'Extra One' });
    const result = diffUnits(goldenUnit2, next);
    const byChange = Object.fromEntries(result.items.filter((i) => i.area === 'section').map((i) => [i.change, i]));
    expect(byChange.removed).toMatchObject({ id: removed.id, title: removed.heading });
    expect(byChange.added).toMatchObject({ id: 'extra_one', title: 'Extra One' });
    expect(result.counts.added).toBeGreaterThanOrEqual(1);
    expect(result.counts.removed).toBeGreaterThanOrEqual(1);
  });

  it('reports a section that only moved', () => {
    const next = clone(goldenUnit2) as unknown as { sections: unknown[] };
    const [first] = next.sections.splice(0, 1);
    next.sections.push(first);
    const result = diffUnits(goldenUnit2, next);
    const moved = result.items.filter((i) => i.change === 'moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ id: goldenUnit2.sections[0]!.id, movedFrom: 1, movedTo: goldenUnit2.sections.length });
    expect(moved[0]?.fields).toEqual([]);
  });

  it('matches questions by id and workbook and manual as their own areas', () => {
    const next = clone(goldenUnit2) as unknown as {
      questions: Record<string, { prompt: string }>;
      workbook: { take_it_home: string };
      teacher_manual: { timing: string };
    };
    const questionId = Object.keys(next.questions)[0]!;
    next.questions[questionId]!.prompt = 'A brand new prompt?';
    next.workbook.take_it_home = 'Take a walk.';
    next.teacher_manual.timing = 'Fifty minutes.';
    const areas = diffUnits(goldenUnit2, next).items.map((i) => `${i.area}:${i.change}`);
    expect(areas).toEqual(['question:changed', 'workbook:changed', 'manual:changed']);
  });

  it('reports header changes', () => {
    const next = clone(goldenUnit2) as unknown as { header: { title: string } };
    next.header.title = 'Exploring Our Environment (Part Two)';
    const result = diffUnits(goldenUnit2, next);
    expect(result.items[0]).toMatchObject({ area: 'header' });
    expect(result.items[0]?.fields[0]).toMatchObject({ path: 'title', after: 'Exploring Our Environment (Part Two)' });
  });

  it('tolerates content that is not a unit', () => {
    expect(diffUnits(null, { kind: 'lesson' }).items[0]).toMatchObject({ area: 'meta', change: 'changed' });
    expect(diffUnits(undefined, undefined).same).toBe(true);
  });
});

describe('diffFields', () => {
  it('aligns arrays so an inserted element does not shift the rest', () => {
    const before = { blocks: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'b' }, { type: 'paragraph', text: 'c' }] };
    const after = { blocks: [{ type: 'paragraph', text: 'a' }, { type: 'paragraph', text: 'NEW' }, { type: 'paragraph', text: 'b' }, { type: 'paragraph', text: 'c' }] };
    const changes = diffFields(before, after);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ path: 'blocks[1]', before: null, after: '[paragraph] NEW' });
  });

  it('pairs a replaced element with its old version as a change', () => {
    const changes = diffFields({ items: [{ text: 'one' }] }, { items: [{ text: 'uno' }] });
    expect(changes).toEqual([{ path: 'items[0].text', label: 'Item 1 › text', before: 'one', after: 'uno' }]);
  });

  it('matches elements with an id by id', () => {
    const before = { nodes: [{ id: 'a', say: 'hi' }, { id: 'b', say: 'bye' }] };
    const after = { nodes: [{ id: 'b', say: 'bye!' }, { id: 'a', say: 'hi' }] };
    expect(diffFields(before, after)).toEqual([
      { path: 'nodes[0].say', label: 'Tutor node 1 › say', before: 'bye', after: 'bye!' },
    ]);
  });
});

describe('helpers', () => {
  it('summarises values for display', () => {
    expect(summarize(null)).toBe('');
    expect(summarize(5)).toBe('5');
    expect(summarize(['x', 'y'])).toBe('x · y');
    expect(summarize({ type: 'callout', text: 'Careful' })).toBe('[callout] Careful');
    expect(summarize({ n: 1 })).toBe('{"n":1}');
    expect(summarize('x'.repeat(400)).length).toBe(400); // strings are shown whole
    expect(summarize({ text: 'x'.repeat(400) }).length).toBeLessThanOrEqual(280);
  });

  it('turns paths into words', () => {
    expect(humanPath('blocks[2].text')).toBe('Block 3 › text');
    expect(humanPath('tutor_script.nodes[1].say')).toBe('tutor script › Tutor node 2 › say');
    expect(humanPath('heading')).toBe('heading');
  });

  it('highlights changed words', () => {
    const segments = wordDiff('Zari walks to school', 'Zari runs to the school');
    expect(segments.map((s) => `${s.kind}:${s.text}`)).toEqual([
      'same:Zari ',
      'removed:walks',
      'added:runs',
      'same: to ',
      'added:the ',
      'same:school',
    ]);
    expect(wordDiff('same', 'same')).toEqual([{ text: 'same', kind: 'same' }]);
    expect(wordDiff('', 'new')).toEqual([{ text: 'new', kind: 'added' }]);
  });
});

// The engine package has its own, coarser diff (which ids changed). The admin diff must agree with it about
// WHICH sections and questions changed; it adds the before/after text on top.
describe('agreement with the engine package diff', () => {
  it('reports the same changed, added and removed ids', () => {
    const next = clone(goldenUnit2) as unknown as {
      sections: { id: string; blocks: { type: string; text?: string }[] }[];
      questions: Record<string, { prompt: string }>;
    };
    const paragraph = next.sections[0]!.blocks.findIndex((b) => b.type === 'paragraph');
    next.sections[0]!.blocks[paragraph]!.text += ' Extra.';
    const removed = next.sections.splice(2, 1)[0]!;
    const firstQuestion = Object.keys(next.questions)[0]!;
    next.questions[firstQuestion]!.prompt = 'Changed?';

    const core = coreDiffUnits(goldenUnit2, next as never);
    const mine = diffUnits(goldenUnit2, next);
    const ids = (area: string, change: string) =>
      mine.items.filter((i) => i.area === area && i.change === change).map((i) => i.id).sort();

    expect([...ids('section', 'changed'), ...ids('section', 'added')].sort()).toEqual([...core.section_ids].sort());
    expect(ids('section', 'removed')).toEqual(core.removed_section_ids);
    expect(core.removed_section_ids).toEqual([removed.id]);
    expect([...ids('question', 'changed'), ...ids('question', 'added')].sort()).toEqual([...core.question_ids].sort());
  });
});
