import { describe, expect, it } from 'vitest';
import {
  CHAPTER_MAX_UNITS,
  CHAPTER_MIN_UNITS,
  LayoutRefusal,
  planLayout,
  previewNumbers,
  type LayoutDoc,
  type LayoutEntry,
  type LayoutErrorCode,
  type LayoutModel,
  type LayoutPlan,
  type LayoutUnit,
} from './unitLayout';

const fields = {
  objective: 'o',
  kind: 'lesson',
  stage: 'absorb',
  periods: 1,
  week_no: null,
} as const;

/**
 * The same sequence as supabase/tests/database/120_unit_layout.test.sql, run against the TypeScript rules: both must
 * give the same numbers at every step. (The SQL is the authority; this test is what keeps the demo and the
 * planner's preview from drifting away from it.)
 */
class Harness {
  model: LayoutModel;
  readonly label = new Map<string, string>();
  private counter = 0;

  constructor() {
    const units: LayoutUnit[] = [];
    for (let n = 1; n <= 8; n += 1) {
      const id = `id_u${n}`;
      this.label.set(id, `u${n}`);
      units.push({
        id,
        chapter_id: n <= 4 ? 'ch1' : 'ch2',
        unit_no: n,
        title: `Unit ${n}`,
        ...fields,
        week_no: n,
        hasVersions: n === 2 || n === 6,
        published: n === 2,
      });
    }
    this.model = {
      chapters: [
        { id: 'ch1', number: 1, title: 'Our Environment' },
        { id: 'ch2', number: 2, title: 'Our Homes' },
      ],
      units,
      weeks: [1, 2, 3, 4, 5, 6, 7, 8],
    };
  }

  idOf(label: string): string {
    for (const [id, l] of this.label) if (l === label) return id;
    throw new Error(`no unit ${label}`);
  }

  /** A spec: chapters as arrays of labels, `{ new: 'Title' }` for a new unit, `{ label, set }` for an edit. */
  doc(
    spec: (string | { new: string } | { label: string; set: Record<string, unknown> })[][],
    removed: string[] = [],
  ): LayoutDoc {
    const existing = this.model.chapters;
    return {
      chapters: spec.map((units, index) => {
        const entries = units.map((u): LayoutEntry => {
          if (typeof u === 'string') return { id: this.idOf(u) };
          if ('new' in u)
            return {
              new: {
                title: u.new,
                objective: `Objective for ${u.new}`,
                kind: 'lesson',
                stage: 'absorb',
              },
            };
          return { id: this.idOf(u.label), set: u.set };
        });
        const chapter = existing[index];
        return chapter
          ? { id: chapter.id, units: entries }
          : { new: { title: 'Our Community' }, units: entries };
      }),
      removed: removed.map((l) => this.idOf(l)),
    };
  }

  /** Plans and applies, naming new units `created` in order. */
  apply(doc: LayoutDoc, created: string[] = [], confirm = false): LayoutPlan {
    const plan = planLayout(this.model, doc, { confirmRenumber: confirm });
    if (!plan.changes) return plan;
    const live = new Map(this.model.units.map((u) => [u.id, u]));
    const chapters = plan.chapters.map((c, index) => ({
      id: c.id ?? `new_ch${index}`,
      number: c.number,
      title: c.title,
    }));
    const units: LayoutUnit[] = [];
    let next = 0;
    plan.chapters.forEach((c, index) => {
      for (const planned of c.units) {
        const chapterId = chapters[index]!.id;
        if (planned.id !== null) {
          const old = live.get(planned.id)!;
          const { lens: _lens, ...patch } = planned.fields;
          units.push({ ...old, ...patch, chapter_id: chapterId, unit_no: planned.unit_no });
        } else {
          const name = created[next] ?? `new${(this.counter += 1)}`;
          next += 1;
          const id = `id_${name}`;
          this.label.set(id, name);
          const { lens: _lens, ...patch } = planned.fields;
          units.push({
            id,
            chapter_id: chapterId,
            unit_no: planned.unit_no,
            title: patch.title ?? '',
            objective: patch.objective ?? '',
            kind: patch.kind ?? 'lesson',
            stage: patch.stage ?? 'absorb',
            periods: patch.periods ?? 1,
            week_no: patch.week_no ?? null,
            hasVersions: false,
            published: false,
          });
        }
      }
    });
    this.model = { ...this.model, chapters, units };
    return plan;
  }

  nums(): string {
    return this.model.chapters
      .map((c) =>
        this.model.units
          .filter((u) => u.chapter_id === c.id)
          .sort((a, b) => a.unit_no - b.unit_no)
          .map((u) => `${c.number}:${u.unit_no}/${this.label.get(u.id)}`)
          .join(' '),
      )
      .join(' ');
  }
}

function refusal(fn: () => unknown): LayoutRefusal {
  try {
    fn();
  } catch (error) {
    if (error instanceof LayoutRefusal) return error;
    throw error;
  }
  throw new Error('expected a refusal');
}

function code(fn: () => unknown): LayoutErrorCode {
  return refusal(fn).code;
}

describe('planLayout follows the SQL scenario (120_unit_layout.test.sql)', () => {
  it('runs the same sequence and gets the same numbers', () => {
    const h = new Harness();
    const start = '1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8';
    expect(h.nums()).toBe(start);

    // an unchanged layout writes nothing
    expect(
      h.apply(
        h.doc([
          ['u1', 'u2', 'u3', 'u4'],
          ['u5', 'u6', 'u7', 'u8'],
        ]),
      ).changes,
    ).toBe(false);

    // G. a fifth unit in the LAST chapter renumbers nothing
    let plan = h.apply(
      h.doc([
        ['u1', 'u2', 'u3', 'u4'],
        ['u5', 'u6', 'u7', 'u8', { new: 'Caring for animals' }],
      ]),
      ['n9'],
    );
    expect(h.nums()).toBe('1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8 2:9/n9');
    expect(plan.counts).toMatchObject({ units_created: 1, units_renumbered: 0, units_moved: 0 });

    // H. 3 to 5 at both ends
    expect(
      code(() =>
        h.apply(
          h.doc([
            ['u1', 'u2', 'u3', 'u4'],
            ['u5', 'u6', 'u7', 'u8', 'n9', { new: 'sixth' }],
          ]),
        ),
      ),
    ).toBe('chapter_unit_count_invalid');
    expect(
      code(() =>
        h.apply(
          h.doc(
            [
              ['u1', 'u2'],
              ['u5', 'u6', 'u7', 'u8', 'n9'],
            ],
            ['u3', 'u4'],
          ),
        ),
      ),
    ).toBe('chapter_unit_count_invalid');

    // I. adding in an EARLIER chapter shifts u6, which has a draft version: needs the confirmation
    const early = h.doc([
      ['u1', 'u2', 'u3', 'u4', { new: 'Keeping the school clean' }],
      ['u5', 'u6', 'u7', 'u8', 'n9'],
    ]);
    const refused = refusal(() => h.apply(early));
    expect(refused.code).toBe('layout_renumbers_versioned_units');
    expect(refused.detail).toEqual([{ id: 'id_u6', title: 'Unit 6', from: 6, to: 7 }]);
    expect(h.nums()).toBe('1:1/u1 1:2/u2 1:3/u3 1:4/u4 2:5/u5 2:6/u6 2:7/u7 2:8/u8 2:9/n9');
    plan = h.apply(early, ['n5'], true);
    expect(h.nums()).toBe('1:1/u1 1:2/u2 1:3/u3 1:4/u4 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9');
    expect(plan.counts).toMatchObject({ units_created: 1, units_renumbered: 5, units_moved: 0 });

    // J. two units without versions swap freely
    plan = h.apply(
      h.doc([
        ['u1', 'u2', 'u4', 'u3', 'n5'],
        ['u5', 'u6', 'u7', 'u8', 'n9'],
      ]),
    );
    expect(h.nums()).toBe('1:1/u1 1:2/u2 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9');
    expect(plan.counts).toMatchObject({ units_renumbered: 2, units_moved: 0, units_updated: 0 });

    // K. the published unit may take the first place inside its chapter, with the confirmation
    const front = h.doc([
      ['u2', 'u1', 'u4', 'u3', 'n5'],
      ['u5', 'u6', 'u7', 'u8', 'n9'],
    ]);
    expect(code(() => h.apply(front))).toBe('layout_renumbers_versioned_units');
    h.apply(front, [], true);
    expect(h.nums()).toBe('1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n9');

    // L. removal archives: n9 was last, so nothing is renumbered
    plan = h.apply(
      h.doc(
        [
          ['u2', 'u1', 'u4', 'u3', 'n5'],
          ['u5', 'u6', 'u7', 'u8'],
        ],
        ['n9'],
      ),
    );
    expect(plan.archived).toEqual(['id_n9']);
    expect(plan.counts).toMatchObject({ units_archived: 1, units_renumbered: 0 });
    expect(h.nums()).toBe('1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8');
    h.label.delete('id_n9');
    plan = h.apply(
      h.doc([
        ['u2', 'u1', 'u4', 'u3', 'n5'],
        ['u5', 'u6', 'u7', 'u8', { new: 'Reusing the slot' }],
      ]),
      ['n10'],
    );
    expect(h.nums()).toBe(
      '1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n5 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n10',
    );

    // M. n5 and n10 swap chapters: nothing with versions changes number
    plan = h.apply(
      h.doc([
        ['u2', 'u1', 'u4', 'u3', 'n10'],
        ['u5', 'u6', 'u7', 'u8', 'n5'],
      ]),
    );
    expect(h.nums()).toBe(
      '1:1/u2 1:2/u1 1:3/u4 1:4/u3 1:5/n10 2:6/u5 2:7/u6 2:8/u7 2:9/u8 2:10/n5',
    );
    expect(plan.counts).toMatchObject({ units_moved: 2, units_renumbered: 2 });

    // N. a published unit never leaves its chapter; a unit with a draft may, with the confirmation
    expect(
      code(() =>
        h.apply(
          h.doc([
            ['n10', 'u1', 'u4', 'u3'],
            ['u2', 'u5', 'u6', 'u7', 'u8', 'n5'],
          ]),
        ),
      ),
    ).toBe('chapter_unit_count_invalid');
    expect(
      code(() =>
        h.apply(
          h.doc([
            ['n5', 'u1', 'u4', 'u3', 'n10'],
            ['u5', 'u6', 'u7', 'u8', 'u2'],
          ]),
          [],
          true,
        ),
      ),
    ).toBe('published_unit_cannot_move');
    const swap = h.doc([
      ['u2', 'u6', 'u4', 'u3', 'n10'],
      ['u5', 'u1', 'u7', 'u8', 'n5'],
    ]);
    expect(code(() => h.apply(swap))).toBe('layout_renumbers_versioned_units');
    h.apply(swap, [], true);
    expect(h.nums()).toBe(
      '1:1/u2 1:2/u6 1:3/u4 1:4/u3 1:5/n10 2:6/u5 2:7/u1 2:8/u7 2:9/u8 2:10/n5',
    );

    // O. units with versions are never removed or edited
    expect(
      code(() =>
        h.apply(
          h.doc(
            [
              ['u2', 'u4', 'u3', 'n10'],
              ['u5', 'u1', 'u7', 'u8', 'n5'],
            ],
            ['u6'],
          ),
          [],
          true,
        ),
      ),
    ).toBe('unit_has_versions');
    expect(
      code(() =>
        h.apply(
          h.doc(
            [
              ['u6', 'u4', 'u3', 'n10'],
              ['u5', 'u1', 'u7', 'u8', 'n5'],
            ],
            ['u2'],
          ),
          [],
          true,
        ),
      ),
    ).toBe('unit_has_versions');
    expect(
      code(() =>
        h.apply(
          h.doc([
            [{ label: 'u2', set: { title: 'A new title' } }, 'u6', 'u4', 'u3', 'n10'],
            ['u5', 'u1', 'u7', 'u8', 'n5'],
          ]),
          [],
          true,
        ),
      ),
    ).toBe('unit_has_versions');

    // P. fields of units without versions are edited; equal values are not an edit
    plan = h.apply(
      h.doc([
        [
          'u2',
          'u6',
          'u4',
          {
            label: 'u3',
            set: {
              title: 'Counting objects',
              objective: 'Count to ten.',
              kind: 'revision',
              stage: 'connect',
              periods: 3,
              week_no: null,
            },
          },
          'n10',
        ],
        ['u5', 'u1', 'u7', 'u8', 'n5'],
      ]),
    );
    expect(plan.counts).toMatchObject({ units_updated: 1, units_renumbered: 0 });
    const unit3 = h.model.units.find((u) => u.id === 'id_u3')!;
    expect(unit3).toMatchObject({
      title: 'Counting objects',
      kind: 'revision',
      stage: 'connect',
      periods: 3,
      week_no: null,
      unit_no: 4,
    });
    expect(
      h.apply(
        h.doc([
          [{ label: 'u2', set: { title: 'Unit 2' } }, 'u6', 'u4', 'u3', 'n10'],
          ['u5', 'u1', 'u7', 'u8', 'n5'],
        ]),
        [],
        true,
      ).changes,
    ).toBe(false);

    // Q. a new chapter goes after the existing ones and needs 3 units
    const base = [
      ['u2', 'u6', 'u4', 'u3', 'n10'],
      ['u5', 'u1', 'u7', 'u8', 'n5'],
    ];
    expect(code(() => h.apply(h.doc([...base, [{ new: 'a' }, { new: 'b' }]])))).toBe(
      'chapter_unit_count_invalid',
    );
    plan = h.apply(
      h.doc([...base, [{ new: 'Neighbours' }, { new: 'Helpers' }, { new: 'Safety' }]]),
      ['q1', 'q2', 'q3'],
    );
    expect(plan.counts.chapters_created).toBe(1);
    expect(h.nums()).toBe(
      '1:1/u2 1:2/u6 1:3/u4 1:4/u3 1:5/n10 2:6/u5 2:7/u1 2:8/u7 2:9/u8 2:10/n5 3:11/q1 3:12/q2 3:13/q3',
    );
  });
});

describe('planLayout validation', () => {
  const h = new Harness();
  const ok = () =>
    h.doc([
      ['u1', 'u2', 'u3', 'u4'],
      ['u5', 'u6', 'u7', 'u8'],
    ]);

  it('refuses a layout that is not well formed', () => {
    for (const bad of [null, {}, { chapters: [] }, { chapters: 'x' }]) {
      expect(code(() => planLayout(h.model, bad as never))).toBe('invalid_unit_layout');
    }
    expect(code(() => planLayout(h.model, { chapters: [{ units: [] }] } as never))).toBe(
      'chapter_unit_count_invalid',
    );
    expect(code(() => planLayout(h.model, { chapters: [{ units: [{}, {}, {}] }] } as never))).toBe(
      'invalid_unit_layout',
    );
    expect(code(() => planLayout(h.model, { ...ok(), removed: ['x', 'x'] }))).toBe(
      'invalid_unit_layout',
    );
  });

  it('refuses unknown or repeated units and chapters', () => {
    const doc = ok();
    expect(
      code(() =>
        planLayout(h.model, {
          ...doc,
          chapters: [{ id: 'nope', units: doc.chapters[0]!.units }, doc.chapters[1]!],
        }),
      ),
    ).toBe('chapter_not_in_scheme');
    expect(
      code(() => planLayout(h.model, { chapters: [doc.chapters[1]!, doc.chapters[0]!] })),
    ).toBe('chapter_order_changed');
    const dup = h.doc([
      ['u1', 'u1', 'u3', 'u4'],
      ['u5', 'u6', 'u7', 'u8'],
    ]);
    expect(code(() => planLayout(h.model, dup))).toBe('duplicate_unit_in_layout');
    const both = h.doc(
      [
        ['u1', 'u2', 'u3', 'u4'],
        ['u5', 'u6', 'u7', 'u8'],
      ],
      ['u3'],
    );
    expect(code(() => planLayout(h.model, both))).toBe('duplicate_unit_in_layout');
    const stranger = h.doc([
      ['u1', 'u2', 'u3', 'u4'],
      ['u5', 'u6', 'u7', 'u8'],
    ]);
    (stranger.chapters[0] as { units: LayoutEntry[] }).units[0] = { id: 'who' };
    expect(code(() => planLayout(h.model, stranger))).toBe('unit_not_in_scheme');
  });

  it('refuses a stale layout (a unit it does not know, a chapter it lacks)', () => {
    const missingUnit = h.doc([
      ['u1', 'u2', 'u3'],
      ['u5', 'u6', 'u7', 'u8'],
    ]);
    expect(code(() => planLayout(h.model, missingUnit))).toBe('layout_out_of_date');
    expect(code(() => planLayout(h.model, { chapters: [ok().chapters[0]!] }))).toBe(
      'layout_out_of_date',
    );
  });

  it('checks new units field by field', () => {
    const base = { title: 't', objective: 'o', kind: 'lesson', stage: 'absorb' } as const;
    const withNew = (entry: Record<string, unknown>): LayoutDoc => {
      const doc = ok();
      (doc.chapters[0] as { units: LayoutEntry[] }).units[0] = { new: entry } as LayoutEntry;
      return doc;
    };
    for (const bad of [
      { ...base, title: '  ' },
      { ...base, kind: 'party' },
      { ...base, stage: 'later' },
      { ...base, periods: 0 },
      { ...base, periods: 11 },
      { ...base, week_no: 16 },
      { ...base, week_no: '3' },
      { ...base, lens: ' ' },
      { objective: 'o', kind: 'lesson', stage: 'absorb' },
    ]) {
      expect(code(() => planLayout(h.model, withNew(bad)))).toBe('invalid_layout_unit');
    }
    expect(code(() => planLayout(h.model, withNew({ ...base, week_no: 12 })))).toBe(
      'unknown_scheme_week',
    );
    const added = ok();
    (added.chapters[1] as { units: LayoutEntry[] }).units.push({
      new: { ...base, week_no: 4, periods: 2 },
    });
    expect(planLayout(h.model, added).counts.units_created).toBe(1);
  });

  it('is pure: planning does not change the model', () => {
    const before = JSON.stringify(h.model);
    planLayout(h.model, ok());
    expect(JSON.stringify(h.model)).toBe(before);
  });

  it('the bounds are the ones the server uses', () => {
    expect([CHAPTER_MIN_UNITS, CHAPTER_MAX_UNITS]).toEqual([3, 5]);
  });
});

describe('previewNumbers', () => {
  it('ranks units through the term in teaching order', () => {
    const h = new Harness();
    const numbers = previewNumbers(
      h.doc([
        ['u3', 'u1', 'u2', 'u4'],
        ['u5', 'u6', 'u7', 'u8'],
      ]),
    );
    expect(numbers.get('id_u3')).toBe(1);
    expect(numbers.get('id_u8')).toBe(8);
  });
});
