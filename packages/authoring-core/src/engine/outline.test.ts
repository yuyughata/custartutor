import { describe, expect, it } from 'vitest';
import type { OutlineOutput } from '../prompts/schemas';
import { chooseEnrichment, normalizeOutline, validateOutline, DEFAULT_MINUTES } from './outline';
import { sampleUnitInput } from '../../test-support/testKit';

const plan = { heading: '', plan: '' };

function raw(overrides: Partial<OutlineOutput> = {}): OutlineOutput {
  return {
    enrichment: [
      { type: 'story_opener', heading: 'The Walk', plan: 'a scene' },
      { type: 'do_and_discover', heading: '', plan: '' },
      { type: 'tell_it_back', heading: '', plan: '' },
    ],
    concepts: [
      { heading: 'School', plan: '', covers: [1, 2] },
      { heading: 'People', plan: '', covers: [3, 4, 5] },
    ],
    worked_examples: plan,
    practice: plan,
    think_deeper: plan,
    quick_fire: plan,
    mastery_check: plan,
    periods: [
      {
        sections: ['story_opener', 'concept_1', 'do_and_discover'],
        start: 10,
        teach: 15,
        move_and_do: 15,
        practice: 10,
        close: 10,
      },
      {
        sections: [
          'concept_2',
          'worked_examples',
          'tell_it_back',
          'practice',
          'think_deeper',
          'quick_fire',
          'mastery_check',
        ],
        start: 10,
        teach: 20,
        move_and_do: 10,
        practice: 10,
        close: 10,
      },
    ],
    ...overrides,
  };
}

describe('normalizeOutline', () => {
  it('keeps a good outline, assigns ids by code and orders sections like the template', () => {
    const outline = normalizeOutline(raw(), sampleUnitInput());
    expect(outline.sections.map((s) => s.id)).toEqual([
      'story_opener',
      'concept_1',
      'concept_2',
      'worked_examples',
      'do_and_discover',
      'tell_it_back',
      'practice',
      'think_deeper',
      'quick_fire',
      'mastery_check',
    ]);
    expect(outline.sections[0]!.heading).toBe('The Walk');
    expect(outline.sections.find((s) => s.id === 'worked_examples')!.heading).toBe(
      "Let's Look Together (Examples)",
    );
    expect(outline.periods).toHaveLength(2);
    expect(outline.periods[1]!.minutes.map((m) => m.minutes)).toEqual([10, 20, 10, 10, 10]);
    expect(outline.notes).toEqual([]);
    expect(validateOutline(outline)).toEqual([]);
  });

  it('repairs a bad outline deterministically: enrichment count, duplicates, ids and uncovered subtopics', () => {
    const outline = normalizeOutline(
      raw({
        enrichment: [
          { type: 'story_opener', heading: '', plan: '' },
          { type: 'story_opener', heading: '', plan: '' },
        ],
        concepts: [{ heading: 'One', plan: '', covers: [1, 99] }],
        periods: [],
      }),
      sampleUnitInput(),
    );
    expect(outline.enrichment.length).toBeGreaterThanOrEqual(2);
    expect(new Set(outline.enrichment).size).toBe(outline.enrichment.length);
    // subtopics 2 to 5 were never assigned: they go to the last concept
    expect(outline.sections.find((s) => s.id === 'concept_1')!.covers).toEqual([1, 2, 3, 4, 5]);
    expect(outline.periods).toHaveLength(2);
    expect(outline.notes.join(' ')).toMatch(/not assigned/);
    expect(validateOutline(outline)).toEqual([]);
  });

  it('caps enrichment at five and concepts at four', () => {
    const all = [
      'story_opener',
      'across_subjects',
      'window_to_world',
      'do_and_discover',
      'tell_it_back',
      'remember',
      'character_values',
    ] as const;
    const outline = normalizeOutline(
      raw({
        enrichment: all.map((type) => ({ type, heading: '', plan: '' })),
        concepts: [1, 2, 3, 4, 5].map((n) => ({ heading: `C${n}`, plan: '', covers: [n] })),
      }),
      sampleUnitInput(),
    );
    expect(outline.enrichment).toHaveLength(5);
    expect(outline.sections.filter((s) => s.type === 'concept')).toHaveLength(4);
    expect(outline.sections.find((s) => s.id === 'concept_4')!.covers).toEqual([4, 5]);
    expect(validateOutline(outline)).toEqual([]);
  });

  it('builds a session plan of exactly the planned number of periods, the mastery check last', () => {
    for (const periods of [1, 2, 3]) {
      const base = sampleUnitInput();
      const outline = normalizeOutline(
        raw({ periods: [] }),
        sampleUnitInput({ unit: { ...base.unit, periods } }),
      );
      expect(outline.periods).toHaveLength(periods);
      expect(outline.periods[periods - 1]!.sections).toContain('mastery_check');
      expect(outline.periods.flatMap((p) => p.sections).sort()).toEqual(
        outline.sections.map((s) => s.id).sort(),
      );
      expect(validateOutline(outline)).toEqual([]);
    }
  });

  it('moves the mastery check to the last period and replaces impossible minutes', () => {
    const outline = normalizeOutline(
      raw({
        periods: [
          {
            sections: ['story_opener', 'concept_1', 'mastery_check'],
            start: 0,
            teach: 0,
            move_and_do: 0,
            practice: 0,
            close: 0,
          },
          {
            sections: [
              'concept_2',
              'worked_examples',
              'do_and_discover',
              'tell_it_back',
              'practice',
              'think_deeper',
              'quick_fire',
            ],
            start: 10,
            teach: 15,
            move_and_do: 15,
            practice: 10,
            close: 10,
          },
        ],
      }),
      sampleUnitInput(),
    );
    expect(outline.periods[0]!.sections).not.toContain('mastery_check');
    expect(outline.periods[1]!.sections).toContain('mastery_check');
    expect(outline.periods[0]!.minutes.map((m) => m.minutes)).toEqual(
      DEFAULT_MINUTES.map((m) => m.minutes),
    );
  });

  it('adds sections the model forgot to the period of the section before them', () => {
    const outline = normalizeOutline(
      raw({
        periods: [
          {
            sections: ['story_opener', 'concept_1'],
            start: 10,
            teach: 15,
            move_and_do: 15,
            practice: 10,
            close: 10,
          },
          {
            sections: [
              'concept_2',
              'worked_examples',
              'tell_it_back',
              'practice',
              'think_deeper',
              'quick_fire',
              'mastery_check',
            ],
            start: 10,
            teach: 15,
            move_and_do: 15,
            practice: 10,
            close: 10,
          },
        ],
      }),
      sampleUnitInput(),
    );
    // in unit order do_and_discover follows worked_examples, which is in period 2
    expect(outline.periods[1]!.sections).toContain('do_and_discover');
    expect(outline.notes.join(' ')).toMatch(/left out do_and_discover/);
  });
});

describe('chooseEnrichment', () => {
  const template = [
    'story_opener',
    'remember',
    'do_and_discover',
    'character_values',
    'tell_it_back',
  ] as const;

  it("swaps a type when the set equals the previous unit's, preferring a global window", () => {
    const notes: string[] = [];
    const chosen = chooseEnrichment([...template], [...template], true, notes);
    expect(new Set(chosen)).not.toEqual(new Set(template));
    expect(chosen).toContain('window_to_world');
    expect(chosen).toHaveLength(5);
    expect(notes.join(' ')).toMatch(/vary the rotation/);
  });

  it('does not touch a set that already differs from the previous one', () => {
    const notes: string[] = [];
    const chosen = chooseEnrichment(
      ['story_opener', 'window_to_world'],
      [...template],
      true,
      notes,
    );
    expect(chosen).toEqual(['story_opener', 'window_to_world']);
    expect(notes).toEqual([]);
  });

  it('never chooses Remember? without earlier units', () => {
    const notes: string[] = [];
    expect(chooseEnrichment([...template], [], false, notes)).not.toContain('remember');
    expect(chooseEnrichment(['remember'], [], false, [])).not.toContain('remember');
    expect(chooseEnrichment(['remember'], [], false, []).length).toBeGreaterThanOrEqual(2);
  });
});
