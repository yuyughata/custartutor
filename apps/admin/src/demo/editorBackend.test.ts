// The demo backend's M2.4 calls: the layout (the same rules as apply_unit_layout), the published history and the
// human version save. Everything is in memory; nothing here is the live server.
import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { isAdminApiError, renumberDetail, type AdminApiError } from '../api/errors';
import type { ChapterRow } from '../api/types';
import { draftFrom, draftToDoc, addUnit, blankFields, removeUnit, moveWithin } from '../lib/layoutDraft';
import type { AdminRole } from '../lib/roles';
import { createDemoAdminApi, type DemoAdminApi } from './demoAdminApi';
import { DEMO_EMAIL_CODE, DEMO_TOTP_CODE } from './demoAuth';
import { DEMO_SCHEME_P1_T1, DEMO_UNIT_2, DEMO_VERSION_GOLDEN } from './state';

async function signedIn(role: AdminRole = 'super_admin'): Promise<DemoAdminApi> {
  const api = createDemoAdminApi({ stepDelayMs: 0, initialRole: role });
  await api.auth.verifyCode('admin@example.com', DEMO_EMAIL_CODE);
  await api.auth.verifyTotp('demo-factor', DEMO_TOTP_CODE);
  return api;
}

async function caught(promise: Promise<unknown>): Promise<AdminApiError> {
  try {
    await promise;
  } catch (error) {
    if (isAdminApiError(error)) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const numbers = (chapters: ChapterRow[]): string =>
  chapters.map((c) => c.units.map((u) => u.unit_no).join(',')).join(' | ');

const fresh = { ...blankFields('absorb'), title: 'Caring for animals', objective: 'Care for animals.', periods: 2 };

describe('apply layout (demo)', () => {
  it('adds a fifth unit to the last chapter, then refuses a sixth', async () => {
    const api = await signedIn();
    const chapters = await api.chapters.list(DEMO_SCHEME_P1_T1);
    expect(numbers(chapters)).toBe('1,2,3,4 | 5,6,7,8');

    const draft = addUnit(draftFrom(chapters), 1, fresh);
    const out = await api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(draft));
    expect(out).toMatchObject({ units_created: 1, units_renumbered: 0, units: 9, chapters: 2 });
    expect(out.created_unit_ids).toHaveLength(1);

    const after = await api.chapters.list(DEMO_SCHEME_P1_T1);
    expect(numbers(after)).toBe('1,2,3,4 | 5,6,7,8,9');
    const created = after[1]?.units.at(-1);
    expect(created).toMatchObject({ id: out.created_unit_ids[0], title: 'Caring for animals', status: 'draft', version_count: 0 });

    const sixth = addUnit(draftFrom(after), 1, fresh);
    // the button would already be disabled; the server (demo) refuses the call too
    expect(sixth.chapters[1]?.units).toHaveLength(5);
    const doc = draftToDoc(draftFrom(after));
    (doc.chapters[1] as { units: unknown[] }).units.push({ new: { ...fresh, kind: 'lesson' } });
    expect((await caught(api.chapters.applyLayout(DEMO_SCHEME_P1_T1, doc))).code).toBe('chapter_unit_count_invalid');
  });

  it('an earlier chapter shifts the later numbers; units with versions need the confirmation', async () => {
    const api = await signedIn();
    // Unit 2 (the golden unit) has a version and sits in chapter 1; adding AFTER it renumbers only version-less units.
    const chapters = await api.chapters.list(DEMO_SCHEME_P1_T1);
    const first = await api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(addUnit(draftFrom(chapters), 0, fresh)));
    expect(first.units_renumbered).toBe(4);
    expect(numbers(await api.chapters.list(DEMO_SCHEME_P1_T1))).toBe('1,2,3,4,5 | 6,7,8,9');

    // Now reorder so the unit with a version moves: that needs the confirmation.
    const now = await api.chapters.list(DEMO_SCHEME_P1_T1);
    const swapped = moveWithin(draftFrom(now), 0, 1, 1);
    const refused = await caught(api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(swapped)));
    expect(refused.code).toBe('layout_renumbers_versioned_units');
    expect(renumberDetail(refused)).toEqual([{ id: DEMO_UNIT_2, title: expect.any(String), from: 2, to: 3 }]);
    expect(numbers(await api.chapters.list(DEMO_SCHEME_P1_T1))).toBe('1,2,3,4,5 | 6,7,8,9');
    await api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(swapped), { confirmRenumber: true });
    const after = await api.chapters.list(DEMO_SCHEME_P1_T1);
    expect(after[0]?.units.map((u) => u.id)[2]).toBe(DEMO_UNIT_2);
    expect(after[0]?.units[2]?.version_count).toBe(1);
  });

  it('removing archives: the unit is gone from the lists, its row stays, and a unit with versions cannot go', async () => {
    const api = await signedIn();
    const chapters = await api.chapters.list(DEMO_SCHEME_P1_T1);
    const grown = await api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(addUnit(draftFrom(chapters), 1, fresh)));
    const id = grown.created_unit_ids[0] as string;
    const withNew = await api.chapters.list(DEMO_SCHEME_P1_T1);
    const draft = removeUnit(draftFrom(withNew), 1, 4);
    const removed = await api.chapters.applyLayout(DEMO_SCHEME_P1_T1, draftToDoc(draft));
    expect(removed.units_archived).toBe(1);
    expect(numbers(await api.chapters.list(DEMO_SCHEME_P1_T1))).toBe('1,2,3,4 | 5,6,7,8');
    expect(api.state.units.find((u) => u.id === id)?.status).toBe('archived');
    // it can still be read, but it cannot get a version
    expect((await api.units.get(id)).unit.status).toBe('archived');
    const attempt = await caught(
      api.units.saveHumanVersion({ unitId: id, content: goldenUnit2 as never, lintReport: { errors: [], warnings: [], ok: true, review: [] }, baseVersionId: null }),
    );
    expect(attempt.code).toBe('unit_not_editable');

    // the golden unit (unit 2) has a version
    const doc = draftToDoc(draftFrom(await api.chapters.list(DEMO_SCHEME_P1_T1)));
    (doc.chapters[0] as { units: { id: string }[] }).units = (doc.chapters[0] as { units: { id: string }[] }).units.filter((u) => u.id !== DEMO_UNIT_2);
    doc.removed = [DEMO_UNIT_2];
    expect((await caught(api.chapters.applyLayout(DEMO_SCHEME_P1_T1, doc, { confirmRenumber: true }))).code).toBe('unit_has_versions');
  });

  it('only a content editor or a super admin may change the layout, and the scheme must be approved', async () => {
    for (const role of ['reviewer', 'support', 'analyst'] as AdminRole[]) {
      const api = await signedIn(role);
      const doc = draftToDoc(draftFrom(await api.chapters.list(DEMO_SCHEME_P1_T1).catch(() => [])));
      expect((await caught(api.chapters.applyLayout(DEMO_SCHEME_P1_T1, doc))).kind).toBe('forbidden');
    }
    const editor = await signedIn('content_editor');
    const doc = draftToDoc(draftFrom(await editor.chapters.list(DEMO_SCHEME_P1_T1)));
    await expect(editor.chapters.applyLayout(DEMO_SCHEME_P1_T1, doc)).resolves.toMatchObject({ units_created: 0 });
    expect((await caught(editor.chapters.applyLayout('nope', doc))).kind).toBe('not_found');
  });

  it('publishing still counts the live units of the chapter: 6 refuse, an archived one does not count', async () => {
    const api = await signedIn();
    const chapters = await api.chapters.list(DEMO_SCHEME_P1_T1);
    const chapter = chapters[0]!;
    const base = api.state.units.find((u) => u.id === DEMO_UNIT_2)!;
    // two extra rows put there directly (the layout would never allow it): 6 live units
    for (const no of [101, 102]) {
      api.state.units.push({ ...base, id: `extra-${no}`, unit_no: no, status: 'draft' });
    }
    expect((await caught(api.units.publishVersion(DEMO_VERSION_GOLDEN))).code).toBe('chapter_unit_count_invalid');
    // archiving one (as the layout does) brings it back to 5
    const extra = api.state.units.find((u) => u.id === 'extra-101')!;
    extra.status = 'archived';
    await expect(api.units.publishVersion(DEMO_VERSION_GOLDEN)).resolves.toBeDefined();
    expect(chapter.units.length).toBe(4);
  });
});

describe('human versions (demo)', () => {
  const report = { errors: [], warnings: [], ok: true, review: [], summary: 'by hand' };

  it('saves a new draft made by a person, based on the latest version', async () => {
    const api = await signedIn();
    const before = await api.units.versions(DEMO_UNIT_2);
    const latest = before[0]!;
    const out = await api.units.saveHumanVersion({
      unitId: DEMO_UNIT_2,
      content: { ...(goldenUnit2 as object), kind: 'lesson' } as never,
      lintReport: report,
      baseVersionId: latest.id,
    });
    expect(out.version).toBe(latest.version + 1);
    const after = await api.units.versions(DEMO_UNIT_2);
    expect(after[0]).toMatchObject({
      id: out.id,
      status: 'draft',
      generated_by: 'human',
      model: null,
      prompt_version: null,
      base_version_id: latest.id,
    });
    expect(after[0]?.lint_report).toEqual(report);
    // never in place: the earlier version is untouched
    expect((await api.units.version(latest.id)).status).toBe(latest.status);
  });

  it('refuses a stale base (somebody saved in between), bad content and the wrong role', async () => {
    const api = await signedIn();
    const first = (await api.units.versions(DEMO_UNIT_2))[0]!;
    const content = goldenUnit2 as never;
    await api.units.saveHumanVersion({ unitId: DEMO_UNIT_2, content, lintReport: report, baseVersionId: first.id });
    const stale = await caught(api.units.saveHumanVersion({ unitId: DEMO_UNIT_2, content, lintReport: report, baseVersionId: first.id }));
    expect(stale).toMatchObject({ kind: 'conflict', code: 'stale_base' });
    const latest = (await api.units.versions(DEMO_UNIT_2))[0]!;
    expect(
      (await caught(api.units.saveHumanVersion({ unitId: DEMO_UNIT_2, content: { nope: true } as never, lintReport: report, baseVersionId: latest.id }))).code,
    ).toBe('invalid_unit_content');
    const reviewer = createDemoAdminApi({ initialRole: 'reviewer', state: api.state });
    await reviewer.auth.verifyCode('r@x.org', DEMO_EMAIL_CODE);
    await reviewer.auth.verifyTotp('demo-factor', DEMO_TOTP_CODE);
    expect((await caught(reviewer.units.saveHumanVersion({ unitId: DEMO_UNIT_2, content, lintReport: report, baseVersionId: latest.id }))).kind).toBe('forbidden');
  });

  it('a human version goes through the same workflow: it starts as a draft and cannot skip a step', async () => {
    const api = await signedIn();
    const base = (await api.units.versions(DEMO_UNIT_2))[0]!;
    const saved = await api.units.saveHumanVersion({ unitId: DEMO_UNIT_2, content: goldenUnit2 as never, lintReport: report, baseVersionId: base.id });
    expect((await caught(api.units.publishVersion(saved.id))).code).toBe('unit_version_not_approved');
    await api.units.setVersionStatus(saved.id, 'in_review');
    await api.units.setVersionStatus(saved.id, 'approved');
    await expect(api.units.publishVersion(saved.id)).resolves.toBeDefined();
  });
});

describe('the published history (demo)', () => {
  it('lists the snapshots of a unit, oldest first, with their content', async () => {
    const api = await signedIn();
    expect(await api.units.publishedHistory(DEMO_UNIT_2)).toEqual([]);
    const golden = await api.units.version(DEMO_VERSION_GOLDEN);
    await api.units.publishVersion(DEMO_VERSION_GOLDEN);
    const history = await api.units.publishedHistory(DEMO_UNIT_2);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ version_no: 1, is_current: true });
    expect(history[0]?.content).toEqual(golden.content);
  });
});
