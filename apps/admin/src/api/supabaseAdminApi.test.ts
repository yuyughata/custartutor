import { describe, expect, it } from 'vitest';
import type { JobRow } from '@custar/authoring-core';
import { isAdminApiError, type AdminApiError } from './errors';
import { createSupabaseAdminApi, safeFileName, type LiveOptions } from './supabaseAdminApi';
import { FakeFetch, FakeSupabase } from './testing/fakeSupabase';

const SCHEME_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';
const VERSION_ID = '33333333-3333-4333-8333-333333333333';
const JOB_ID = '44444444-4444-4444-8444-444444444444';
const SUBJECT_ID = '55555555-5555-4555-8555-555555555555';
const PUBLISHED_ID = '66666666-6666-4666-8666-666666666666';

function jobRow(patch: Partial<JobRow> = {}): JobRow {
  return {
    id: JOB_ID,
    kind: 'unit_generate',
    status: 'queued',
    progress: { done: [], next: 'outline', total: 9 },
    lease_until: null,
    attempts: 0,
    error: null,
    result: null,
    unit_id: UNIT_ID,
    scheme_id: null,
    created_by: null,
    created_at: '2026-10-12T10:00:00+00:00',
    updated_at: '2026-10-12T10:00:00+00:00',
    finished_at: null,
    ...patch,
  };
}

function setup(patch: Partial<LiveOptions> = {}) {
  const supabase = new FakeSupabase();
  const http = new FakeFetch();
  const api = createSupabaseAdminApi(supabase.asClient(), {
    url: 'https://example.supabase.co/',
    publishableKey: 'sb_publishable_test',
    fetch: http.fetch,
    randomId: () => 'fixed-uuid',
    ...patch,
  });
  return { supabase, http, api };
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

describe('RPCs: exact names and arguments', () => {
  it('save_scheme_draft', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('save_scheme_draft', { data: SCHEME_ID });
    const weeks = [{ week_no: 1, kind: 'teaching' as const, topic: 'Colours', subtopics: ['Red'] }];
    const out = await api.schemes.saveDraft({
      subjectId: SUBJECT_ID,
      levelCode: 'P1',
      term: 2,
      weeks,
      sourceNote: 'From the PDF',
    });
    expect(out).toEqual({ schemeId: SCHEME_ID });
    expect(supabase.rpcCalls).toEqual([
      {
        name: 'save_scheme_draft',
        args: {
          p_subject_id: SUBJECT_ID,
          p_level_code: 'P1',
          p_term: 2,
          p_weeks: weeks,
          p_source_note: 'From the PDF',
        },
      },
    ]);
  });

  it('approve_scheme', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('approve_scheme', { data: null });
    await api.schemes.approve(SCHEME_ID);
    expect(supabase.rpcCalls).toEqual([{ name: 'approve_scheme', args: { p_scheme_id: SCHEME_ID } }]);
  });

  it('apply_chapter_plan, with the counts validated', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_chapter_plan', { data: { chapters: 2, units: '8' } });
    const plan = { chapters: [] };
    const out = await api.chapters.applyPlan(SCHEME_ID, plan);
    expect(out).toEqual({ chapters: 2, units: 8 });
    expect(supabase.rpcCalls[0]).toEqual({
      name: 'apply_chapter_plan',
      args: { p_scheme_id: SCHEME_ID, p_plan: plan },
    });
  });

  it('set_unit_version_status', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('set_unit_version_status', { data: null });
    await api.units.setVersionStatus(VERSION_ID, 'in_review');
    expect(supabase.rpcCalls).toEqual([
      { name: 'set_unit_version_status', args: { p_unit_version_id: VERSION_ID, p_status: 'in_review' } },
    ]);
  });

  it('publish_unit_version returns the published unit id', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('publish_unit_version', { data: PUBLISHED_ID });
    expect(await api.units.publishVersion(VERSION_ID)).toEqual({ publishedUnitId: PUBLISHED_ID });
    expect(supabase.rpcCalls[0]).toEqual({
      name: 'publish_unit_version',
      args: { p_unit_version_id: VERSION_ID },
    });
  });

  it('get_ai_settings / set_app_setting / get_ai_usage_summary', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('get_ai_settings', {
      data: {
        models: { authoring: 'claude-opus-5-5', tutor: 'claude-sonnet-5-5', moderation: 'claude-haiku-5-5' },
        kill_switch: false,
        budget: { max_usd_per_job: null, daily_usd_cap: 5 },
        prices: {},
        effort: {},
        prompt_version: 'm2-v1',
      },
    });
    supabase.onRpc('set_app_setting', { data: null });
    supabase.onRpc('get_ai_usage_summary', {
      data: {
        totals: { calls: 3, input_tokens: '1200', output_tokens: 800, est_cost_usd: null, jobs: { succeeded: 2 } },
        by_day: [{ day: '2026-10-12', calls: 3, est_cost_usd: 0.5, unpriced_calls: 1 }],
        by_model: [{ model: 'claude-opus-5-5', calls: 3 }],
        by_kind: [{ kind: 'unit_generate', calls: 3 }],
      },
    });

    const settings = await api.settings.get();
    expect(settings.budget.daily_usd_cap).toBe(5);
    await api.settings.set('ai.kill_switch', true);
    const usage = await api.usage.summary({ from: '2026-10-01T00:00:00Z', to: '2026-11-01T00:00:00Z' });

    expect(supabase.rpcCalls.map((c) => c.name)).toEqual(['get_ai_settings', 'set_app_setting', 'get_ai_usage_summary']);
    expect(supabase.rpcCalls[1]?.args).toEqual({ p_key: 'ai.kill_switch', p_value: true });
    expect(supabase.rpcCalls[2]?.args).toEqual({ p_from: '2026-10-01T00:00:00Z', p_to: '2026-11-01T00:00:00Z' });
    expect(usage.totals).toMatchObject({
      calls: 3,
      input_tokens: 1200,
      est_cost_usd: null,
      jobs_by_status: { succeeded: 2 },
    });
    expect(usage.by_day[0]).toMatchObject({ day: '2026-10-12', est_cost_usd: 0.5, unpriced_calls: 1 });
    expect(usage.by_model[0]?.est_cost_usd).toBeNull();
  });
});

describe('error mapping', () => {
  it('maps a stable RPC message to plain words', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('save_scheme_draft', { error: { message: 'scheme_not_draft', code: '22023' } });
    const error = await caught(
      api.schemes.saveDraft({ subjectId: SUBJECT_ID, levelCode: 'P1', term: 1, weeks: [], sourceNote: '' }),
    );
    expect(error).toMatchObject({ kind: 'conflict', code: 'scheme_not_draft' });
    expect(error.message).toMatch(/already approved/);
  });

  it('maps a refusal for the role to a forbidden error (the server decides, the screen copes)', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('approve_scheme', { error: { message: 'admin_role_required', code: '42501' } });
    const error = await caught(api.schemes.approve(SCHEME_ID));
    expect(error).toMatchObject({ kind: 'forbidden', code: 'admin_role_required' });
    expect(error.message).toMatch(/role is not allowed/);
  });

  it('maps a bare row-level-security refusal to a hint about the authenticator code', async () => {
    const { supabase, api } = setup();
    supabase.onTable('characters', { error: { message: 'new row violates row-level security policy', code: '42501' } });
    const error = await caught(
      api.characters.save({
        id: 'c1',
        slug: 'zari',
        name: 'Zari',
        traits: { personality: [] },
        voice: {},
        active: true,
      }),
    );
    expect(error.kind).toBe('forbidden');
    expect(error.message).toMatch(/authenticator code/);
  });

  it('maps an expired JWT to a session error', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', { error: { message: 'JWT expired', code: 'PGRST301' } });
    expect(await caught(api.schemes.list())).toMatchObject({ kind: 'session_expired' });
  });

  it('maps a failed fetch to a network error that can be retried', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', { error: { message: 'TypeError: Failed to fetch', code: '' } });
    const error = await caught(api.schemes.list());
    expect(error.kind).toBe('network');
    expect(error.retryable).toBe(true);
  });

  it('turns a response that does not match the schema into bad_response, not a crash', async () => {
    const { supabase, api } = setup();
    supabase.onRpc('apply_chapter_plan', { data: { unexpected: true } });
    const error = await caught(api.chapters.applyPlan(SCHEME_ID, { chapters: [] }));
    expect(error.kind).toBe('bad_response');
    supabase.onRpc('publish_unit_version', { data: 42 });
    expect((await caught(api.units.publishVersion(VERSION_ID))).kind).toBe('bad_response');
  });
});

describe('reads', () => {
  it('lists schemes with week counts from the embedded weeks', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', {
      data: [
        {
          id: SCHEME_ID,
          subject_id: SUBJECT_ID,
          level_code: 'P1',
          term: 1,
          status: 'approved',
          source_note: null,
          created_at: '2026-10-12T10:00:00Z',
          scheme_weeks: [
            { week_no: 1, kind: 'teaching' },
            { week_no: 2, kind: 'teaching' },
            { week_no: 5, kind: 'mid_term_exam' },
          ],
        },
      ],
    });
    const [scheme] = await api.schemes.list();
    expect(scheme).toMatchObject({ id: SCHEME_ID, week_count: 3, teaching_week_count: 2, status: 'approved' });
    expect(supabase.queries[0]?.select).toContain('scheme_weeks(week_no,kind)');
  });

  it('reads a scheme with sorted weeks and null topics as empty text', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', {
      data: {
        id: SCHEME_ID,
        subject_id: SUBJECT_ID,
        level_code: 'P1',
        term: 1,
        status: 'draft',
        source_note: 'note',
        created_at: '2026-10-12T10:00:00Z',
        scheme_weeks: [
          { week_no: 2, kind: 'teaching', topic: 'B', subtopics: ['x'] },
          { week_no: 1, kind: 'teaching', topic: null, subtopics: null },
        ],
      },
    });
    const scheme = await api.schemes.get(SCHEME_ID);
    expect(scheme.weeks.map((w) => [w.week_no, w.topic, w.subtopics])).toEqual([
      [1, '', []],
      [2, 'B', ['x']],
    ]);
    expect(supabase.queries[0]?.filters).toEqual([{ op: 'eq', column: 'id', value: SCHEME_ID }]);
    expect(supabase.queries[0]?.mode).toBe('maybeSingle');
  });

  it('reports a missing scheme as not found', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', { data: null });
    expect(await caught(api.schemes.get(SCHEME_ID))).toMatchObject({ kind: 'not_found' });
  });

  it('lists chapters with units, their latest version and status; hides tombstones', async () => {
    const { supabase, api } = setup();
    const unit = (id: string, no: number, versions: unknown[], deleted: string | null = null) => ({
      id,
      chapter_id: 'c1',
      unit_no: no,
      week_no: no,
      kind: 'lesson',
      title: `Unit ${no}`,
      objective: null,
      stage: 'absorb',
      periods: 1,
      status: 'draft',
      deleted_at: deleted,
      unit_versions: versions,
    });
    supabase.onTable('chapters', {
      data: [
        {
          id: 'c1',
          scheme_id: SCHEME_ID,
          number: 1,
          title: 'Our World',
          status: 'draft',
          deleted_at: null,
          units: [
            unit('u2', 2, [
              { id: 'v1', version: 1, status: 'superseded' },
              { id: 'v2', version: 2, status: 'in_review' },
            ]),
            unit('u1', 1, []),
            unit('u3', 3, [], '2026-10-01T00:00:00Z'),
          ],
        },
        { id: 'c2', scheme_id: SCHEME_ID, number: 2, title: 'Gone', status: 'draft', deleted_at: '2026-10-01T00:00:00Z', units: [] },
      ],
    });
    const chapters = await api.chapters.list(SCHEME_ID);
    expect(chapters).toHaveLength(1);
    expect(chapters[0]?.units.map((u) => [u.unit_no, u.version_count, u.latest_version, u.latest_version_status])).toEqual([
      [1, 0, null, null],
      [2, 2, 2, 'in_review'],
    ]);
    expect(supabase.queries[0]?.filters).toEqual([{ op: 'eq', column: 'scheme_id', value: SCHEME_ID }]);
    expect(supabase.queries[0]?.select).not.toContain('content');
  });

  it('reads a unit with its chapter, scheme and subject', async () => {
    const { supabase, api } = setup();
    supabase.onTable('units', {
      data: {
        id: UNIT_ID,
        chapter_id: 'c1',
        unit_no: 2,
        week_no: 2,
        kind: 'lesson',
        title: 'Exploring',
        objective: 'obj',
        stage: 'absorb',
        periods: 1,
        status: 'draft',
        chapters: {
          id: 'c1',
          number: 1,
          title: 'Our World',
          scheme_id: SCHEME_ID,
          schemes: {
            id: SCHEME_ID,
            level_code: 'P1',
            term: 1,
            status: 'approved',
            subject_id: SUBJECT_ID,
            subjects: { id: SUBJECT_ID, slug: 'basic-science', name: 'Basic Science' },
          },
        },
      },
    });
    const context = await api.units.get(UNIT_ID);
    expect(context.subject.name).toBe('Basic Science');
    expect(context.chapter).toMatchObject({ number: 1, title: 'Our World' });
    expect(context.scheme).toMatchObject({ level_code: 'P1', term: 1 });
    expect(context.unit.title).toBe('Exploring');
  });

  it('lists versions without content and reads content only for one version', async () => {
    const { supabase, api } = setup();
    const row = {
      id: VERSION_ID,
      unit_id: UNIT_ID,
      version: 1,
      schema_version: 1,
      status: 'draft',
      generated_by: 'ai',
      model: 'claude-opus-5-5',
      prompt_version: 'm2-v1',
      lint_report: { errors: [], warnings: [], ok: true, review: [] },
      base_version_id: null,
      created_by: null,
      created_at: '2026-10-12T10:00:00Z',
    };
    supabase.onTable('unit_versions', (spec) => ({
      data: spec.select?.includes('content') ? { ...row, content: { schema_version: 1 } } : [row],
    }));
    const versions = await api.units.versions(UNIT_ID);
    expect(versions[0]).toMatchObject({ version: 1, model: 'claude-opus-5-5', generated_by: 'ai' });
    expect(supabase.queries[0]?.select).not.toContain('content');
    expect(supabase.queries[0]?.order).toEqual([{ column: 'version', ascending: false }]);
    const full = await api.units.version(VERSION_ID);
    expect(full.content).toEqual({ schema_version: 1 });
    expect(supabase.queries[1]?.select).toContain('content');
  });

  it('reads and saves characters through the characters table', async () => {
    const { supabase, api } = setup();
    const stored = {
      id: 'c1',
      slug: 'zuri',
      name: 'Zuri',
      traits: { age_years: 4, age_note: 'almost 5', gender: 'male' },
      voice: { notes: 'Speaks softly' },
      active: true,
    };
    supabase.onTable('characters', (spec) => ({ data: spec.update ? stored : [stored] }));
    const [zuri] = await api.characters.list();
    expect(zuri?.traits).toMatchObject({ age_years: 4, age_note: 'almost 5', personality: [] });
    const saved = await api.characters.save({ ...zuri!, name: 'Zuri' });
    expect(saved.slug).toBe('zuri');
    const write = supabase.queries[1]!;
    expect(write.table).toBe('characters');
    expect(write.update).toMatchObject({ name: 'Zuri', active: true, voice: { notes: 'Speaks softly' } });
    expect(write.filters).toEqual([{ op: 'eq', column: 'id', value: 'c1' }]);
    expect(write.mode).toBe('single');
  });

  it('does not claim a character was saved when the row was not returned', async () => {
    const { supabase, api } = setup();
    supabase.onTable('characters', { data: [] });
    const error = await caught(
      api.characters.save({ id: 'c1', slug: 'zari', name: 'Zari', traits: { personality: [] }, voice: {}, active: true }),
    );
    expect(error.kind).toBe('not_found');
  });

  it('reads the publication of a version', async () => {
    const { supabase, api } = setup();
    supabase.onTable('published_units', {
      data: {
        id: PUBLISHED_ID,
        unit_id: UNIT_ID,
        version_no: 2,
        is_current: true,
        content_hash: 'a'.repeat(64),
        pack_manifest_path: `units/${UNIT_ID}/2/manifest.json`,
        pack_built_at: '2026-10-12T11:00:00Z',
        published_at: '2026-10-12T10:59:00Z',
      },
    });
    const info = await api.units.publication(VERSION_ID);
    expect(info?.content_hash).toBe('a'.repeat(64));
    expect(supabase.queries[0]?.filters).toEqual([{ op: 'eq', column: 'unit_version_id', value: VERSION_ID }]);
    supabase.onTable('published_units', { data: null });
    expect(await api.units.publication(VERSION_ID)).toBeNull();
  });

  it('builds the home summary from the review queues and the active jobs', async () => {
    const { supabase, api } = setup();
    supabase.onTable('schemes', {
      data: [
        { id: SCHEME_ID, subject_id: SUBJECT_ID, level_code: 'P1', term: 2, status: 'draft', source_note: null, created_at: '2026-10-12T10:00:00Z', scheme_weeks: [] },
      ],
    });
    supabase.onTable('unit_versions', (spec) => ({
      data: spec.filters.some((f) => f.value === 'in_review')
        ? [{ id: VERSION_ID, version: 1, status: 'in_review', created_at: '2026-10-12T10:00:00Z', units: { id: UNIT_ID, unit_no: 2, title: 'Exploring' } }]
        : [],
    }));
    supabase.onTable('ai_jobs', {
      data: [
        { ...jobRow({ status: 'running' }), result: undefined },
        { ...jobRow({ id: '77777777-7777-4777-8777-777777777777', status: 'failed', error: { code: 'refusal', message: 'no' } }), result: undefined },
      ],
    });
    supabase.onTable('units', { data: null, count: 8 });
    const summary = await api.home.summary();
    expect(summary.counts).toMatchObject({
      schemes: 1,
      units: 8,
      versionsInReview: 1,
      versionsReadyToPublish: 0,
      jobsRunning: 1,
      jobsFailed: 1,
    });
    expect(summary.schemesAwaitingApproval).toHaveLength(1);
    expect(summary.versionsInReview[0]).toMatchObject({ unit_title: 'Exploring', unit_no: 2 });
  });
});

describe('uploads', () => {
  it('uploads a PDF to scheme-uploads under <user id>/<uuid>-<file name>', async () => {
    const { supabase, api } = setup();
    const data = new ArrayBuffer(8);
    const out = await api.schemes.uploadPdf({ name: 'Basic Science P1 (scheme).pdf', mimeType: 'application/pdf', size: 8, data });
    expect(out.path).toBe('user-1/fixed-uuid-Basic_Science_P1_scheme_.pdf');
    expect(supabase.uploads).toEqual([
      {
        bucket: 'scheme-uploads',
        path: 'user-1/fixed-uuid-Basic_Science_P1_scheme_.pdf',
        body: data,
        options: { contentType: 'application/pdf', upsert: false },
      },
    ]);
  });

  it('explains a file that is too large and a refused upload', async () => {
    const { supabase, api } = setup();
    const file = { name: 'x.pdf', mimeType: 'application/pdf', size: 1, data: new ArrayBuffer(1) };
    supabase.uploadError = { message: 'The object exceeded the maximum allowed size' };
    expect(await caught(api.schemes.uploadPdf(file))).toMatchObject({ kind: 'invalid', code: 'file_too_large' });
    supabase.uploadError = { message: 'new row violates row-level security policy' };
    expect((await caught(api.schemes.uploadPdf(file))).kind).toBe('forbidden');
  });

  it('refuses to upload when signed out', async () => {
    const { supabase, api } = setup();
    supabase.authState.session = null;
    const error = await caught(
      api.schemes.uploadPdf({ name: 'x.pdf', mimeType: 'application/pdf', size: 1, data: new ArrayBuffer(1) }),
    );
    expect(error.kind).toBe('unauthenticated');
  });

  it('makes storage-safe file names', () => {
    expect(safeFileName('Scheme of work – P1.pdf')).toBe('Scheme_of_work_P1.pdf');
    expect(safeFileName('../../etc/passwd')).toBe('etc_passwd');
    expect(safeFileName('')).toBe('upload.pdf');
  });
});

describe('jobs through the ai-job edge function', () => {
  const unitParams = { unit_id: UNIT_ID, notes: 'Use cassava' };

  it('creates a job: POST with the access token and the publishable key as apikey', async () => {
    const { http, api } = setup();
    http.reply(200, { job: jobRow() });
    const job = await api.jobs.create('unit_generate', unitParams, 'idem-key-12345');
    expect(job.id).toBe(JOB_ID);
    expect(http.requests).toEqual([
      {
        url: 'https://example.supabase.co/functions/v1/ai-job',
        method: 'POST',
        headers: {
          Authorization: 'Bearer access-token-1',
          apikey: 'sb_publishable_test',
          'Content-Type': 'application/json',
        },
        body: { action: 'create', kind: 'unit_generate', params: unitParams, idempotency_key: 'idem-key-12345' },
      },
    ]);
  });

  it('validates params before sending anything', async () => {
    const { http, api } = setup();
    const error = await caught(api.jobs.create('unit_generate', { unit_id: 'not-a-uuid' }));
    expect(error).toMatchObject({ kind: 'invalid', code: 'invalid_request' });
    expect(http.requests).toEqual([]);
  });

  it('steps a job and passes the busy flag through', async () => {
    const { http, api } = setup();
    http.reply(202, { job: jobRow({ status: 'running' }) }).reply(200, { job: jobRow({ status: 'running' }), busy: true });
    expect((await api.jobs.step(JOB_ID)).busy).toBeUndefined();
    expect((await api.jobs.step(JOB_ID)).busy).toBe(true);
    expect(http.requests[0]?.body).toEqual({ action: 'step', job_id: JOB_ID });
  });

  it('cancels a job', async () => {
    const { http, api } = setup();
    http.reply(200, { job: jobRow({ status: 'cancelled' }) });
    expect((await api.jobs.cancel(JOB_ID)).status).toBe('cancelled');
    expect(http.requests[0]?.body).toEqual({ action: 'cancel', job_id: JOB_ID });
  });

  it.each([
    ['mfa_required', 401, 'mfa_required'],
    ['forbidden', 403, 'forbidden'],
    ['kill_switch', 503, 'kill_switch'],
    ['budget_exceeded', 429, 'budget_exceeded'],
    ['unauthenticated', 401, 'unauthenticated'],
    ['not_found', 404, 'not_found'],
    ['conflict', 409, 'conflict'],
  ] as const)('maps the ai-job error code %s', async (code, status, kind) => {
    const { http, api } = setup();
    http.reply(status, { error: { code, message: 'server words' } });
    const error = await caught(api.jobs.step(JOB_ID));
    expect(error).toMatchObject({ kind, code, status });
  });

  it('keeps the protocol code on the error so runJob gives up at once on permanent errors', async () => {
    const { http, api } = setup();
    http.reply(403, { error: { code: 'forbidden', message: 'not content staff' } });
    const error = await caught(api.jobs.create('unit_generate', unitParams));
    expect(error.code).toBe('forbidden');
  });

  it('maps an unreadable error body by status', async () => {
    const { http, api } = setup();
    http.reply(500, undefined);
    const error = await caught(api.jobs.step(JOB_ID));
    expect(error).toMatchObject({ kind: 'server', status: 500 });
    expect(error.retryable).toBe(true);
  });

  it('maps a network failure and a session that has ended', async () => {
    const { supabase, http, api } = setup();
    http.fail(new TypeError('Failed to fetch'));
    expect(await caught(api.jobs.step(JOB_ID))).toMatchObject({ kind: 'network' });
    supabase.authState.session = null;
    expect(await caught(api.jobs.step(JOB_ID))).toMatchObject({ kind: 'unauthenticated' });
  });

  it('rejects a job response that does not match the schema', async () => {
    const { http, api } = setup();
    http.reply(200, { job: { id: 'nope' } });
    expect((await caught(api.jobs.step(JOB_ID))).kind).toBe('bad_response');
  });

  it('polls a job by selecting ai_jobs without input and state', async () => {
    const { supabase, api } = setup();
    supabase.onTable('ai_jobs', { data: jobRow({ status: 'running' }) });
    const job = await api.jobs.get(JOB_ID);
    expect(job.status).toBe('running');
    const columns = supabase.queries[0]?.select?.split(',') ?? [];
    expect(columns).toContain('progress');
    expect(columns).not.toContain('input');
    expect(columns).not.toContain('state');
    expect(supabase.queries[0]?.filters).toEqual([{ op: 'eq', column: 'id', value: JOB_ID }]);
  });

  it('accepts a freshly queued job whose progress is still empty', async () => {
    const { supabase, api } = setup();
    supabase.onTable('ai_jobs', { data: { ...jobRow(), progress: {} } });
    expect((await api.jobs.get(JOB_ID)).progress).toEqual({ done: [], next: null, total: 0 });
  });

  it('reports a job that does not exist', async () => {
    const { supabase, api } = setup();
    supabase.onTable('ai_jobs', { data: null });
    expect((await caught(api.jobs.get(JOB_ID))).kind).toBe('not_found');
  });

  it('lists jobs, newest first, with filters and without result', async () => {
    const { supabase, api } = setup();
    supabase.onTable('ai_jobs', { data: [{ ...jobRow(), result: undefined }] });
    const jobs = await api.jobs.list({ kind: 'unit_generate', status: ['running', 'failed'], unitId: UNIT_ID, limit: 10 });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).not.toHaveProperty('result');
    const query = supabase.queries[0]!;
    expect(query.select).not.toContain('result');
    expect(query.order).toEqual([{ column: 'created_at', ascending: false }]);
    expect(query.limit).toBe(10);
    expect(query.filters).toEqual([
      { op: 'eq', column: 'kind', value: 'unit_generate' },
      { op: 'in', column: 'status', value: ['running', 'failed'] },
      { op: 'eq', column: 'unit_id', value: UNIT_ID },
    ]);
  });
});

describe('publishing: publish_unit_version then publish-pack', () => {
  it('builds the pack with the published unit id', async () => {
    const { http, api } = setup();
    http.reply(200, {
      published_unit_id: PUBLISHED_ID,
      unit_id: UNIT_ID,
      version_no: 2,
      manifest_path: `units/${UNIT_ID}/2/manifest.json`,
      content_hash: 'b'.repeat(64),
      files: 12,
      already_built: false,
    });
    const pack = await api.units.buildPack(PUBLISHED_ID);
    expect(pack).toEqual({
      published_unit_id: PUBLISHED_ID,
      content_hash: 'b'.repeat(64),
      manifest_path: `units/${UNIT_ID}/2/manifest.json`,
      already_built: false,
      files: 12,
    });
    expect(http.requests[0]).toMatchObject({
      url: 'https://example.supabase.co/functions/v1/publish-pack',
      method: 'POST',
      body: { published_unit_id: PUBLISHED_ID },
    });
  });

  it('reports an already built pack', async () => {
    const { http, api } = setup();
    http.reply(200, {
      published_unit_id: PUBLISHED_ID,
      unit_id: UNIT_ID,
      version_no: 2,
      manifest_path: 'm',
      content_hash: 'c'.repeat(64),
      already_built: true,
    });
    expect(await api.units.buildPack(PUBLISHED_ID)).toMatchObject({ already_built: true, files: null });
  });

  it.each([
    ['not_current', 409, 'conflict', /replaced by a newer one/],
    ['content_not_packable', 422, 'invalid', /lint panel/],
    ['upload_failed', 502, 'server', /could not be stored/],
  ] as const)('explains the publish-pack error %s', async (code, status, kind, message) => {
    const { http, api } = setup();
    http.reply(status, { error: { code, message: code } });
    const error = await caught(api.units.buildPack(PUBLISHED_ID));
    expect(error.kind).toBe(kind);
    expect(error.message).toMatch(message);
  });
});

describe('reference data', () => {
  it('lists active subjects and levels in order', async () => {
    const { supabase, api } = setup();
    supabase.onTable('subjects', { data: [{ id: SUBJECT_ID, slug: 'basic-science', name: 'Basic Science', sort: 30 }] });
    supabase.onTable('levels', { data: [{ code: 'P1', name: 'Primary 1', sort: 1 }] });
    expect((await api.catalog.subjects())[0]?.slug).toBe('basic-science');
    expect((await api.catalog.levels())[0]?.code).toBe('P1');
    expect(supabase.queries[0]?.filters).toEqual([
      { op: 'eq', column: 'active', value: true },
      { op: 'is', column: 'deleted_at', value: null },
    ]);
  });
});

describe('the key it holds', () => {
  it('never sends anything but the publishable key', async () => {
    const { http, api } = setup();
    http.reply(200, { job: jobRow() });
    await api.jobs.create('unit_generate', { unit_id: UNIT_ID });
    const headers = http.requests[0]?.headers ?? {};
    expect(Object.values(headers).join(' ')).not.toMatch(/service_role|ANTHROPIC/i);
    expect(headers.apikey).toBe('sb_publishable_test');
  });
});
