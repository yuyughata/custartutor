import { describe, expect, it } from 'vitest';
import {
  ChapterPlanResult,
  SchemeIngestResult,
  UnitDraftResult,
  runJob,
  type AppSettingKey,
  type JobRow,
} from '@custar/authoring-core';
import { DEMO_MODEL_ID as CORE_DEMO_MODEL_ID } from '@custar/authoring-core/fakes';
import { parseUnit } from '@custar/content-schema';
import { isAdminApiError, type AdminApiError } from '../api/errors';
import type { AdminApi } from '../api/types';
import { buildLintView, parseVersionContent } from '../lib/lint';
import type { AdminRole } from '../lib/roles';
import { createDemoAdminApi, type DemoAdminApi } from './demoAdminApi';
import { DEMO_EMAIL_CODE, DEMO_TOTP_CODE } from './demoAuth';
import { DEMO_MODEL_ID } from './modelName';
import {
  DEMO_SCHEME_P1_T1,
  DEMO_SUBJECT_BASIC_SCIENCE,
  DEMO_UNIT_2,
  DEMO_VERSION_GOLDEN,
} from './state';

const instant = async () => undefined;

async function signedIn(role: AdminRole = 'super_admin'): Promise<DemoAdminApi> {
  const api = createDemoAdminApi({ stepDelayMs: 0, initialRole: role });
  await api.auth.sendCode('admin@example.com');
  await api.auth.verifyCode('admin@example.com', DEMO_EMAIL_CODE);
  await api.auth.verifyTotp('demo-factor', DEMO_TOTP_CODE);
  return api;
}

async function finish(api: AdminApi, job: JobRow): Promise<JobRow> {
  return runJob(api.jobs, job.id, { pollMs: 50, sleep: instant });
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

const PASTED = 'Term 2 Basic Science, Primary 1. Week 1: Non-living things. Week 2: ...';

describe('the stand-in model', () => {
  it('reports the same id as the engine package, and the id is never a Claude id', () => {
    expect(DEMO_MODEL_ID).toBe(CORE_DEMO_MODEL_ID);
    expect(DEMO_MODEL_ID).not.toMatch(/claude/i);
  });
});

describe('sign-in', () => {
  it('needs the email code, then the authenticator code', async () => {
    const api = createDemoAdminApi({ stepDelayMs: 0 });
    expect((await api.auth.state()).step).toBe('signed_out');
    expect((await caught(api.auth.verifyCode('a@b.c', '000000'))).code).toBe('wrong_code');
    const afterCode = await api.auth.verifyCode('a@b.c', DEMO_EMAIL_CODE);
    expect(afterCode).toMatchObject({ step: 'mfa_challenge', email: 'a@b.c' });
    expect((await caught(api.auth.verifyTotp('demo-factor', '000000'))).code).toBe('wrong_totp');
    expect(await api.auth.verifyTotp('demo-factor', DEMO_TOTP_CODE)).toMatchObject({
      step: 'ready',
      role: 'super_admin',
    });
    await api.auth.signOut();
    expect((await api.auth.state()).step).toBe('signed_out');
  });

  it('shows enrolment for "new" emails and the not-an-admin state for "visitor" emails', async () => {
    const api = createDemoAdminApi();
    expect((await api.auth.verifyCode('new@x.org', DEMO_EMAIL_CODE)).step).toBe('mfa_enrol');
    const enrolment = await api.auth.startEnrolment();
    expect(enrolment.qrCode).toContain('data:image/svg+xml');
    const visitor = createDemoAdminApi();
    await visitor.auth.verifyCode('visitor@x.org', DEMO_EMAIL_CODE);
    expect((await visitor.auth.verifyTotp('demo-factor', DEMO_TOTP_CODE)).step).toBe('not_admin');
  });

  it('switches the role for the demo and tells listeners', async () => {
    const api = await signedIn();
    const seen: string[] = [];
    api.auth.subscribe((state) => seen.push(state.step === 'ready' ? state.role : state.step));
    api.auth.setDemoRole?.('reviewer');
    expect(seen).toEqual(['reviewer']);
  });
});

describe('the seed', () => {
  it('has the subjects, the approved Basic Science P1 Term 1 scheme and the golden unit as an approved version', async () => {
    const api = await signedIn();
    expect((await api.catalog.subjects()).map((s) => s.slug)).toContain('basic-science');
    expect((await api.catalog.levels()).map((l) => l.code)).toEqual([
      'P1',
      'P2',
      'P3',
      'P4',
      'P5',
      'P6',
    ]);
    const schemes = await api.schemes.list();
    expect(schemes).toHaveLength(1);
    expect(schemes[0]).toMatchObject({
      id: DEMO_SCHEME_P1_T1,
      status: 'approved',
      level_code: 'P1',
      term: 1,
      teaching_week_count: 8,
      week_count: 13,
    });

    const chapters = await api.chapters.list(DEMO_SCHEME_P1_T1);
    expect(chapters.map((c) => [c.number, c.title, c.units.length])).toEqual([
      [1, 'Our World Around Us', 4],
      [2, 'Shapes and Living Things', 4],
    ]);
    const unit2 = chapters[0]?.units.find((u) => u.unit_no === 2);
    expect(unit2).toMatchObject({
      id: DEMO_UNIT_2,
      version_count: 1,
      latest_version: 1,
      latest_version_status: 'approved',
    });

    const versions = await api.units.versions(DEMO_UNIT_2);
    expect(versions[0]).toMatchObject({
      id: DEMO_VERSION_GOLDEN,
      generated_by: 'human',
      model: null,
      status: 'approved',
    });
    const full = await api.units.version(DEMO_VERSION_GOLDEN);
    expect(parseUnit(full.content).header.title).toBe('Exploring Our Environment (Part 2)');
  });

  it('has Zari and Zuri with only the facts the owner gave', async () => {
    const api = await signedIn();
    const cast = await api.characters.list();
    const zari = cast.find((c) => c.slug === 'zari');
    const zuri = cast.find((c) => c.slug === 'zuri');
    expect(zari?.traits).toMatchObject({ age_years: 7, gender: 'female' });
    expect(zuri?.traits).toMatchObject({ age_years: 4, age_note: 'almost 5', gender: 'male' });
    for (const character of cast) {
      expect(character.traits.relationship_note).toBeUndefined();
      expect(character.traits.personality).toEqual([]);
      expect(character.traits.derived_guidance).toMatch(/^Derived from/);
    }
  });
});

describe('roles', () => {
  it('refuses writes the role cannot make, the way the server would', async () => {
    const reviewer = await signedIn('reviewer');
    const save = reviewer.schemes.saveDraft({
      subjectId: DEMO_SUBJECT_BASIC_SCIENCE,
      levelCode: 'P1',
      term: 2,
      weeks: [{ week_no: 1, kind: 'teaching', topic: 'T', subtopics: [] }],
      sourceNote: '',
    });
    expect(await caught(save)).toMatchObject({ kind: 'forbidden', code: 'admin_role_required' });
    expect(
      (await caught(reviewer.jobs.create('chapter_plan', { scheme_id: DEMO_SCHEME_P1_T1 }))).kind,
    ).toBe('forbidden');
    expect((await caught(reviewer.settings.set('ai.kill_switch', true))).kind).toBe('forbidden');

    const analyst = await signedIn('analyst');
    expect((await caught(analyst.schemes.list())).kind).toBe('forbidden');
    expect(
      (await analyst.usage.summary({ from: '2026-01-01T00:00:00Z', to: '2027-01-01T00:00:00Z' }))
        .totals.calls,
    ).toBe(0);
    expect((await caught(analyst.settings.get())).kind).toBe('forbidden');
  });
});

describe('scheme -> chapters -> unit: the whole flow with the stand-in model', () => {
  it('reads a pasted scheme, saves it as a draft, approves it, plans and applies chapters', async () => {
    const editor = await signedIn('content_editor');

    // 1. ingest (a job); nothing is saved yet
    const created = await editor.jobs.create('scheme_ingest', {
      subject_id: DEMO_SUBJECT_BASIC_SCIENCE,
      level_code: 'P1',
      term: 2,
      source: { type: 'text', text: PASTED, filename: 'pasted-text.txt' },
    });
    expect(created.status).toBe('queued');
    const done = await finish(editor, created);
    expect(done.status).toBe('succeeded');
    const draft = SchemeIngestResult.parse(done.result);
    expect(draft.scheme).toMatchObject({
      subject_slug: 'basic-science',
      level_code: 'P1',
      term: 2,
    });
    expect(draft.scheme.weeks.length).toBeGreaterThan(5);
    expect((await editor.schemes.list()).filter((s) => s.term === 2)).toHaveLength(0);

    // 2. save as draft (content_editor), a reviewer approves it, the editor cannot
    const { schemeId } = await editor.schemes.saveDraft({
      subjectId: DEMO_SUBJECT_BASIC_SCIENCE,
      levelCode: 'P1',
      term: 2,
      weeks: draft.scheme.weeks,
      sourceNote: draft.source_note,
    });
    expect((await editor.schemes.get(schemeId)).status).toBe('draft');
    expect((await caught(editor.schemes.approve(schemeId))).kind).toBe('forbidden');
    editor.auth.setDemoRole?.('reviewer');
    await editor.schemes.approve(schemeId);
    expect((await editor.schemes.get(schemeId)).status).toBe('approved');
    // an approved scheme can no longer be replaced
    editor.auth.setDemoRole?.('content_editor');
    expect(
      await caught(
        editor.schemes.saveDraft({
          subjectId: DEMO_SUBJECT_BASIC_SCIENCE,
          levelCode: 'P1',
          term: 2,
          weeks: draft.scheme.weeks,
          sourceNote: '',
        }),
      ),
    ).toMatchObject({ code: 'scheme_not_draft' });

    // 3. chapter plan (a job), then apply
    const planJob = await finish(
      editor,
      await editor.jobs.create('chapter_plan', { scheme_id: schemeId }),
    );
    expect(planJob.status).toBe('succeeded');
    const plan = ChapterPlanResult.parse(planJob.result);
    expect(plan.plan.chapters.every((c) => c.units.length >= 3 && c.units.length <= 5)).toBe(true);
    const applied = await editor.chapters.applyPlan(schemeId, plan.plan);
    expect(applied.chapters).toBe(plan.plan.chapters.length);
    const chapters = await editor.chapters.list(schemeId);
    expect(chapters.reduce((total, c) => total + c.units.length, 0)).toBe(applied.units);
    expect(chapters[0]?.units[0]).toMatchObject({
      status: 'draft',
      version_count: 0,
      latest_version_status: null,
    });
  });

  it('refuses to plan chapters for a scheme that is not approved', async () => {
    const editor = await signedIn('content_editor');
    const { schemeId } = await editor.schemes.saveDraft({
      subjectId: DEMO_SUBJECT_BASIC_SCIENCE,
      levelCode: 'P2',
      term: 1,
      weeks: [{ week_no: 1, kind: 'teaching', topic: 'Topic', subtopics: ['a'] }],
      sourceNote: '',
    });
    expect(await caught(editor.jobs.create('chapter_plan', { scheme_id: schemeId }))).toMatchObject(
      { code: 'scheme_not_approved' },
    );
  });

  it('drafts a unit as a DRAFT version made by the stand-in model, then revises it into a new version', async () => {
    const admin = await signedIn('super_admin');
    const unit = (await admin.chapters.list(DEMO_SCHEME_P1_T1))[0]?.units.find(
      (u) => u.unit_no === 3,
    );
    expect(unit).toBeDefined();
    const unitId = unit?.id as string;

    const generated = await finish(
      admin,
      await admin.jobs.create('unit_generate', { unit_id: unitId, notes: 'Use cassava' }),
    );
    expect(generated.status).toBe('succeeded');
    const result = UnitDraftResult.parse(generated.result);
    expect(result.version).toBe(1);

    const [version] = await admin.units.versions(unitId);
    expect(version).toMatchObject({
      id: result.unit_version_id,
      status: 'draft',
      generated_by: 'ai',
      model: DEMO_MODEL_ID,
      prompt_version: 'm2-v1',
      base_version_id: null,
    });
    const full = await admin.units.version(result.unit_version_id);
    const parsed = parseVersionContent(full.content);
    expect(parsed.unit?.header.title).toBe(unit?.title);
    const lint = buildLintView(full.lint_report, parsed);
    expect(lint.errors).toEqual([]);
    expect(lint.summary).toBeTruthy();
    expect(lint.review.some((note) => /demo/i.test(note.message))).toBe(true);

    // revise: a NEW version based on the first; the first is kept
    const revised = await finish(
      admin,
      await admin.jobs.create('unit_revise', {
        unit_version_id: result.unit_version_id,
        instruction: 'Shorten the practice questions.',
      }),
    );
    expect(revised.status).toBe('succeeded');
    const second = UnitDraftResult.parse(revised.result);
    expect(second.version).toBe(2);
    const versions = await admin.units.versions(unitId);
    expect(versions.map((v) => v.version)).toEqual([2, 1]);
    expect(versions[0]?.base_version_id).toBe(result.unit_version_id);
    expect(versions[1]?.status).toBe('draft');

    // the first version is no longer the latest, so it cannot be revised
    expect(
      await caught(
        admin.jobs.create('unit_revise', {
          unit_version_id: result.unit_version_id,
          instruction: 'Again',
        }),
      ),
    ).toMatchObject({ code: expect.any(String) });
  });

  it('moves a version through review and publishes it only when a person has approved it', async () => {
    const admin = await signedIn('super_admin');
    const unit = (await admin.chapters.list(DEMO_SCHEME_P1_T1))[1]?.units[0];
    const unitId = unit?.id as string;
    const generated = await finish(
      admin,
      await admin.jobs.create('unit_generate', { unit_id: unitId }),
    );
    const versionId = UnitDraftResult.parse(generated.result).unit_version_id;

    // a draft cannot be approved or published directly
    expect(await caught(admin.units.setVersionStatus(versionId, 'approved'))).toMatchObject({
      code: 'illegal_status_move',
    });
    expect(await caught(admin.units.publishVersion(versionId))).toMatchObject({
      code: 'unit_version_not_approved',
    });

    await admin.units.setVersionStatus(versionId, 'in_review');
    expect(await caught(admin.units.publishVersion(versionId))).toMatchObject({
      code: 'unit_version_not_approved',
    });

    // only a reviewer or super admin approves
    admin.auth.setDemoRole?.('content_editor');
    expect(await caught(admin.units.setVersionStatus(versionId, 'approved'))).toMatchObject({
      code: 'reviewer_required',
    });
    admin.auth.setDemoRole?.('reviewer');
    await admin.units.setVersionStatus(versionId, 'approved');

    const { publishedUnitId } = await admin.units.publishVersion(versionId);
    expect((await admin.units.versions(unitId))[0]?.status).toBe('published');
    expect(await admin.units.publication(versionId)).toMatchObject({
      id: publishedUnitId,
      is_current: true,
      content_hash: null,
    });
    // the demo records the publish and says plainly that it built nothing
    expect(await admin.units.buildPack(publishedUnitId)).toMatchObject({
      demo: true,
      published_unit_id: publishedUnitId,
    });
    const chapters = await admin.chapters.list(DEMO_SCHEME_P1_T1);
    expect(chapters[1]?.units[0]).toMatchObject({
      status: 'published',
      latest_version_status: 'published',
    });
  });

  it('can publish the seeded golden unit and supersedes it with a later approved version', async () => {
    const admin = await signedIn('super_admin');
    const first = await admin.units.publishVersion(DEMO_VERSION_GOLDEN);
    expect(first.publishedUnitId).toBeTruthy();

    const generated = await finish(
      admin,
      await admin.jobs.create('unit_generate', { unit_id: DEMO_UNIT_2 }),
    );
    const id = UnitDraftResult.parse(generated.result).unit_version_id;
    await admin.units.setVersionStatus(id, 'in_review');
    await admin.units.setVersionStatus(id, 'approved');
    await admin.units.publishVersion(id);
    const versions = await admin.units.versions(DEMO_UNIT_2);
    expect(versions.map((v) => [v.version, v.status])).toEqual([
      [2, 'published'],
      [1, 'superseded'],
    ]);
  });
});

describe('jobs', () => {
  it('lists jobs newest first with filters and no result', async () => {
    const admin = await signedIn();
    const one = await admin.jobs.create('chapter_plan', { scheme_id: DEMO_SCHEME_P1_T1 });
    await finish(admin, one);
    const two = await admin.jobs.create('unit_generate', { unit_id: DEMO_UNIT_2 });
    const all = await admin.jobs.list();
    expect(all.map((j) => j.id)).toEqual(
      [two.id, one.id].sort((a, b) => (all[0]?.id === a ? -1 : all[0]?.id === b ? 1 : 0)),
    );
    expect(all[0]).not.toHaveProperty('result');
    expect((await admin.jobs.list({ kind: 'chapter_plan' })).map((j) => j.id)).toEqual([one.id]);
    expect((await admin.jobs.list({ status: ['succeeded'] })).map((j) => j.id)).toEqual([one.id]);
    expect((await admin.jobs.list({ unitId: DEMO_UNIT_2 })).map((j) => j.id)).toEqual([two.id]);
  });

  it('returns the same job for the same idempotency key', async () => {
    const admin = await signedIn();
    const a = await admin.jobs.create(
      'chapter_plan',
      { scheme_id: DEMO_SCHEME_P1_T1 },
      'key-12345678',
    );
    const b = await admin.jobs.create(
      'chapter_plan',
      { scheme_id: DEMO_SCHEME_P1_T1 },
      'key-12345678',
    );
    expect(b.id).toBe(a.id);
    expect(await admin.jobs.list()).toHaveLength(1);
  });

  it('can be cancelled and then keeps its state', async () => {
    const admin = await signedIn();
    const job = await admin.jobs.create('unit_generate', { unit_id: DEMO_UNIT_2 });
    const cancelled = await admin.jobs.cancel(job.id);
    expect(cancelled.status).toBe('cancelled');
    expect((await admin.units.versions(DEMO_UNIT_2)).length).toBe(1);
  });

  it('validates params before running anything', async () => {
    const admin = await signedIn();
    expect(await caught(admin.jobs.create('unit_generate', { unit_id: 'nope' }))).toMatchObject({
      code: 'invalid_request',
    });
    expect(
      await caught(
        admin.jobs.create('unit_generate', { unit_id: '11111111-1111-4111-8111-111111111111' }),
      ),
    ).toMatchObject({
      kind: 'not_found',
    });
  });

  it('the kill switch stops the next step with a typed error', async () => {
    const admin = await signedIn();
    const job = await admin.jobs.create('unit_generate', { unit_id: DEMO_UNIT_2 });
    await admin.settings.set('ai.kill_switch', true);
    const error = await caught(admin.jobs.step(job.id)).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 'kill_switch' });
  });
});

describe('usage and settings', () => {
  it('counts the calls the stand-in model reported, with the cost unknown until a price is entered', async () => {
    const admin = await signedIn();
    const range = { from: '2020-01-01T00:00:00Z', to: '2100-01-01T00:00:00Z' };
    expect((await admin.usage.summary(range)).totals.calls).toBe(0);

    await finish(admin, await admin.jobs.create('chapter_plan', { scheme_id: DEMO_SCHEME_P1_T1 }));
    const summary = await admin.usage.summary(range);
    expect(summary.totals.calls).toBeGreaterThan(0);
    expect(summary.totals.est_cost_usd).toBeNull();
    expect(summary.totals.unpriced_calls).toBe(summary.totals.calls);
    expect(summary.by_model.map((m) => m.model)).toEqual([DEMO_MODEL_ID]);
    expect(summary.by_kind.map((k) => k.kind)).toEqual(['chapter_plan']);
    expect(summary.by_day).toHaveLength(1);
    expect(summary.totals.jobs_by_status).toEqual({ succeeded: 1 });

    await admin.settings.set('ai.prices', {
      [DEMO_MODEL_ID]: {
        input_per_mtok: 1,
        output_per_mtok: 2,
        cache_read_per_mtok: 0.1,
        cache_write_per_mtok: 1.25,
      },
    });
    const priced = await admin.usage.summary(range);
    expect(priced.totals.est_cost_usd).not.toBeNull();
    expect(priced.totals.unpriced_calls).toBe(0);
  });

  it('validates and stores each setting', async () => {
    const admin = await signedIn();
    await admin.settings.set('ai.budget', { max_usd_per_job: 2, daily_usd_cap: null });
    await admin.settings.set('ai.models', { authoring: 'a', tutor: 'b', moderation: 'c' });
    const settings = await admin.settings.get();
    expect(settings.budget).toEqual({ max_usd_per_job: 2, daily_usd_cap: null });
    expect(settings.models).toEqual({ authoring: 'a', tutor: 'b', moderation: 'c' });
    for (const [key, value] of [
      ['ai.kill_switch', 'yes'],
      ['ai.budget', { max_usd_per_job: -1, daily_usd_cap: null }],
      ['ai.models', { authoring: '' }],
    ] as [AppSettingKey, never][]) {
      expect(await caught(admin.settings.set(key, value))).toMatchObject({
        code: 'invalid_request',
      });
    }
  });
});

describe('characters', () => {
  it('saves a character and rejects bad traits', async () => {
    const admin = await signedIn();
    const [zari] = await admin.characters.list();
    expect(zari).toBeDefined();
    const saved = await admin.characters.save({
      ...(zari as NonNullable<typeof zari>),
      traits: {
        ...(zari as NonNullable<typeof zari>).traits,
        relationship_note: 'Zuri’s big sister',
      },
    });
    expect(saved.traits.relationship_note).toBe('Zuri’s big sister');
    expect(
      (await admin.characters.list()).find((c) => c.id === saved.id)?.traits.relationship_note,
    ).toBe('Zuri’s big sister');
    expect(
      await caught(admin.characters.save({ ...saved, traits: { ...saved.traits, age_years: 99 } })),
    ).toMatchObject({ code: 'invalid_traits' });
    expect(await caught(admin.characters.save({ ...saved, name: ' ' }))).toMatchObject({
      code: 'invalid_name',
    });
  });
});

describe('home', () => {
  it('lists what needs attention', async () => {
    const admin = await signedIn();
    const first = await admin.home.summary();
    expect(first.counts).toMatchObject({
      schemes: 1,
      schemesApproved: 1,
      units: 8,
      versionsInReview: 0,
      versionsReadyToPublish: 1,
    });
    expect(first.versionsReadyToPublish[0]).toMatchObject({ unit_no: 2, status: 'approved' });
    await admin.jobs.create('unit_generate', { unit_id: DEMO_UNIT_2 });
    const second = await admin.home.summary();
    expect(second.counts.jobsRunning).toBe(1);
    expect(second.jobsNeedingAttention).toHaveLength(1);
  });
});
