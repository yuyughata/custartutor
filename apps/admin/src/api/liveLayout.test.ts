import { describe, expect, it } from 'vitest';
import type { StoredLintReport } from '@custar/authoring-core';
import live from './fixtures/live-layout-output.json';
import { fromPostgrest, renumberDetail } from './errors';
import {
  ApplyLayoutSchema,
  CreatedVersionSchema,
  PublishedSnapshotRow,
  UnitVersionSummaryRow,
} from './schemas';
import { storedReportFor, type ValidationResult } from '../editor/validate';
import { publishedIdsOf } from '../editor/stableIds';
import {
  LayoutRefusal,
  planLayout,
  type LayoutDoc,
  type LayoutModel,
  type LayoutUnit,
} from '../lib/unitLayout';

/**
 * `fixtures/live-layout-output.json` was captured from the real CUSTAR Tutor dev database on 2026-10-12, as a
 * super_admin at aal2 inside one rolled-back transaction: a scheme with two chapters of three units, `apply_unit_layout`
 * called unchanged, with a unit added, with a unit removed (refused, then confirmed), and stale; two human versions
 * saved with `create_unit_version_draft` (one stale_base), a version published and its snapshot read back. If the SQL
 * and what the admin app parses or predicts drift apart, this test fails.
 */
const CH1 = 'f6c2feac-f113-4ef0-8179-eda3f0da5c43';
const CH2 = 'a2a42654-7b41-44a1-b2a5-35482f861961';
const U = {
  u1: '3fb4eb63-9bf8-4df0-8fc3-0e7e98a9c2de',
  u2: '5a9c4d9d-cdf7-464e-9316-4f1c3779d31c',
  u3: '839bf385-5c52-475b-b884-b7a9686dbc6a',
  u4: '4932fb34-7a8e-4bef-8c80-573416305b62',
  u5: '3976cf02-7d47-4668-ad56-cda02011efca',
  u6: '874617b7-2fb2-4a22-b2af-465bc274cccb',
  market: '99677737-03e5-4eb4-9871-333f1a5e617e',
} as const;

const fields = { objective: 'o', kind: 'lesson', stage: 'connect', periods: 1 } as const;

function model(units: Partial<LayoutUnit>[], u2HasVersions: boolean): LayoutModel {
  return {
    chapters: [
      { id: CH1, number: 1, title: 'Counting' },
      { id: CH2, number: 2, title: 'Adding' },
    ],
    units: units.map((u) => ({
      ...fields,
      week_no: null,
      title: 'x',
      hasVersions: u.id === U.u2 && u2HasVersions,
      published: false,
      ...u,
    })) as LayoutUnit[],
    weeks: [1, 2, 3, 4, 5, 6],
  };
}

const START = model(
  [
    { id: U.u1, title: 'U1', chapter_id: CH1, unit_no: 1 },
    { id: U.u2, title: 'U2', chapter_id: CH1, unit_no: 2 },
    { id: U.u3, title: 'U3', chapter_id: CH1, unit_no: 3 },
    { id: U.u4, title: 'U4', chapter_id: CH2, unit_no: 4 },
    { id: U.u5, title: 'U5', chapter_id: CH2, unit_no: 5 },
    { id: U.u6, title: 'U6', chapter_id: CH2, unit_no: 6 },
  ],
  false,
);

const AFTER_ADD = model(
  [
    { id: U.u1, title: 'U1', chapter_id: CH1, unit_no: 1 },
    { id: U.u2, title: 'U2', chapter_id: CH1, unit_no: 2 },
    { id: U.u3, title: 'U3', chapter_id: CH1, unit_no: 3 },
    { id: U.market, title: 'Our local market', chapter_id: CH1, unit_no: 4 },
    { id: U.u4, title: 'U4', chapter_id: CH2, unit_no: 5 },
    { id: U.u5, title: 'U5', chapter_id: CH2, unit_no: 6 },
    { id: U.u6, title: 'U6', chapter_id: CH2, unit_no: 7 },
  ],
  true,
);

const ids = (...list: string[]) => list.map((id) => ({ id }));

function numbers(plan: ReturnType<typeof planLayout>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const chapter of plan.chapters)
    for (const unit of chapter.units) if (unit.id) out[unit.id] = unit.unit_no;
  return out;
}

function liveNumbers(
  layout: { units: { id: string; unit_no: number }[] }[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const chapter of layout) for (const unit of chapter.units) out[unit.id] = unit.unit_no;
  return out;
}

describe('apply_unit_layout against the live server output', () => {
  it('every result satisfies the schema the adapter parses with', () => {
    for (const key of ['layout_noop', 'layout_add', 'layout_renumbered'] as const) {
      const parsed = ApplyLayoutSchema.parse(live[key]);
      expect(parsed.layout.length).toBe(2);
    }
    expect(ApplyLayoutSchema.parse(live.layout_noop)).toMatchObject({
      units_created: 0,
      units_renumbered: 0,
    });
    expect(ApplyLayoutSchema.parse(live.layout_add).created_unit_ids).toEqual([U.market]);
  });

  it('an unchanged layout reports nothing changed; the TypeScript rules agree', () => {
    const plan = planLayout(START, {
      chapters: [
        { id: CH1, units: ids(U.u1, U.u2, U.u3) },
        { id: CH2, units: ids(U.u4, U.u5, U.u6) },
      ],
    });
    expect(plan.changes).toBe(false);
    expect(live.layout_noop.units_renumbered).toBe(0);
  });

  it('adding a unit at the end of chapter 1: the same counts and numbers as the planner predicts', () => {
    const doc: LayoutDoc = {
      chapters: [
        {
          id: CH1,
          units: [
            ...ids(U.u1, U.u2, U.u3),
            {
              new: {
                title: 'Our local market',
                objective: 'o',
                kind: 'lesson',
                stage: 'connect',
                periods: 1,
                week_no: 1,
              },
            },
          ],
        },
        { id: CH2, units: ids(U.u4, U.u5, U.u6) },
      ],
    };
    const plan = planLayout(START, doc);
    expect(plan.counts).toMatchObject({
      units_created: live.layout_add.units_created,
      units_renumbered: live.layout_add.units_renumbered,
      units_moved: live.layout_add.units_moved,
      units_archived: live.layout_add.units_archived,
    });
    const { [U.market]: _market, ...existing } = liveNumbers(live.layout_add.layout);
    expect(numbers(plan)).toEqual(existing);
    expect(plan.chapters[0]?.units.at(-1)?.unit_no).toBe(4);
  });

  it('removing unit 1 would renumber the unit that has versions: refused with the same detail, then confirmed with the same numbers', () => {
    const doc: LayoutDoc = {
      chapters: [
        { id: CH1, units: ids(U.u2, U.u3, U.market) },
        { id: CH2, units: ids(U.u4, U.u5, U.u6) },
      ],
      removed: [U.u1],
    };
    let refusal: unknown;
    try {
      planLayout(AFTER_ADD, doc);
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(LayoutRefusal);
    expect((refusal as LayoutRefusal).code).toBe(live.error_renumber.message);
    expect((refusal as LayoutRefusal).detail).toEqual(JSON.parse(live.error_renumber.details));

    const plan = planLayout(AFTER_ADD, doc, { confirmRenumber: true });
    expect(plan.counts).toMatchObject({
      units_renumbered: live.layout_renumbered.units_renumbered,
      units_archived: live.layout_renumbered.units_archived,
      units_moved: live.layout_renumbered.units_moved,
      units_created: live.layout_renumbered.units_created,
    });
    expect(numbers(plan)).toEqual(liveNumbers(live.layout_renumbered.layout));
    expect(plan.archived).toEqual([U.u1]);
  });

  it('the stale page, the sixth unit and the renumber refusal become the typed errors the screens branch on', () => {
    expect(fromPostgrest(live.error_out_of_date)).toMatchObject({
      code: 'layout_out_of_date',
      kind: 'conflict',
    });
    expect(fromPostgrest(live.error_too_many).code).toBe('chapter_unit_count_invalid');
    const renumber = fromPostgrest(live.error_renumber);
    expect(renumber.code).toBe('layout_renumbers_versioned_units');
    expect(renumberDetail(renumber)).toEqual([{ id: U.u2, title: 'U2', from: 2, to: 1 }]);
    expect(renumberDetail(fromPostgrest(live.error_out_of_date))).toBeNull();
  });

  it('the archived unit keeps its row with a parked number, and the live ones are dense', () => {
    const rows = live.unit_rows;
    expect(rows.filter((r) => r.status !== 'archived').map((r) => r.unit_no)).toEqual([
      1, 2, 3, 4, 5, 6,
    ]);
    const archived = rows.find((r) => r.status === 'archived');
    expect(archived?.id).toBe(U.u1);
    expect(archived?.unit_no).toBeGreaterThanOrEqual(10000);
    expect(rows.find((r) => r.id === U.u2)?.status).toBe('published');
  });
});

describe('human versions and the published history against the live server output', () => {
  it('create_unit_version_draft returns the id and the number', () => {
    expect(CreatedVersionSchema.parse(live.human_version_1)).toEqual({
      id: live.human_version_1.id,
      version: 1,
    });
    expect(CreatedVersionSchema.parse(live.human_version_2).version).toBe(2);
  });

  it('a hand-made version is a draft by a person: no model, no prompt version, based on the one before', () => {
    const row = UnitVersionSummaryRow.parse(live.human_version_row);
    expect(row).toMatchObject({
      generated_by: 'human',
      model: null,
      prompt_version: null,
      status: 'draft',
      version: 2,
    });
    expect(row.base_version_id).toBe(live.human_version_1.id);
    expect(row.created_by).not.toBeNull();
  });

  it('the lint report the editor sends is what the server stored, and it satisfies the StoredLintReport contract', () => {
    const sent = storedReportFor({
      lint: { errors: [], warnings: [] },
    } as unknown as ValidationResult);
    expect(live.human_version_row.lint_report).toEqual(sent);
    const stored: StoredLintReport = live.human_version_row.lint_report as StoredLintReport;
    expect(stored.ok).toBe(true);
    expect(stored.review).toEqual([]);
  });

  it('a stale base is refused with the stable code', () => {
    const error = fromPostgrest(live.error_stale_base);
    expect(error).toMatchObject({ code: 'stale_base', kind: 'conflict' });
  });

  it('the published snapshots read back satisfy the schema and give the stable-id rule its ids', () => {
    const rows = live.published_history.map((row) => PublishedSnapshotRow.parse(row));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ version_no: 2, is_current: true, id: live.publish });
    expect(publishedIdsOf(rows).sections.size).toBe(0);
  });
});
