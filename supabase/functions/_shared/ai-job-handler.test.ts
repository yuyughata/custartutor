import { describe, expect, it } from 'vitest';
import { StepError } from '../../../packages/authoring-core/src/contract';
import type { UsageRecord } from '../../../packages/authoring-core/src/contract';
import { ENRICHMENT_MENU as SCHEMA_ENRICHMENT_MENU } from '../../../packages/content-schema/src';
import { STATUS_OF_CODE, AI_JOB_ERROR_CODES, mapDbError, scrub } from './ai-job-errors.ts';
import { ENRICHMENT_MENU } from './ai-job-context.ts';
import {
  classifyFailure,
  corsHeadersFor,
  decodeJwtClaims,
  isAllowedOrigin,
} from './ai-job-handler.ts';
import type { JobEngine, JobKind, JobState, Json, StepDeps, StepOutcome } from './ai-job-types.ts';
import { AI_JOB_ERROR_CODES as CONTRACT_ERROR_CODES } from '../../../packages/authoring-core/src/contract';
import { fail } from './ai-job-fake-db.ts';
import type { FakeDb, Row } from './ai-job-fake-db.ts';
import { ED, ED2, IDS, RV, SA, SUP, makeEnv, makeJwt } from './ai-job-test-kit.ts';
import type { Env, SendOptions } from './ai-job-test-kit.ts';

// --- a fake engine: unit_generate has 3 kinds of step, one of them dynamic ------------------------------------
//   outline -> section:<id> for every section the outline listed -> assemble (the last step, returns the result)
// The other kinds: scheme_ingest = extract, check; chapter_plan = group, title; unit_revise = revise.

type StepScript = Record<
  string,
  (call: { state: JobState; deps: StepDeps }) => StepOutcome | Promise<StepOutcome>
>;

const usageOf = (step: string, model = 'claude-opus-5-5-20261001'): UsageRecord => ({
  label: `fake:${step}`,
  task: 'authoring',
  model,
  input_tokens: 1000,
  output_tokens: 500,
  cache_read_tokens: 100,
  cache_creation_tokens: 50,
  stop_reason: 'end_turn',
  duration_ms: 12,
});

const DRAFT = {
  content: { schema_version: 1, kind: 'lesson', header: { title: 'Unit 1' }, sections: [] },
  lint: { errors: [], warnings: [{ code: 'w', severity: 'note', message: 'm' }], ok: true },
  review: [{ code: 'facts', severity: 'note', message: 'check the example' }],
  summary: 'Drafted the unit.',
};

interface FakeEngine extends JobEngine {
  runs: Array<{ kind: JobKind; step: string; state: JobState; deps: StepDeps; input: unknown }>;
}

function makeEngine(script: StepScript = {}): FakeEngine {
  const stepsOf = (kind: JobKind, state: JobState): string[] => {
    switch (kind) {
      case 'unit_generate': {
        const outline = state.outputs['outline'] as { sections?: string[] } | undefined;
        return ['outline', ...(outline?.sections ?? []).map((id) => `section:${id}`), 'assemble'];
      }
      case 'unit_revise':
        return ['revise'];
      case 'chapter_plan':
        return ['group', 'title'];
      default:
        return ['extract', 'check'];
    }
  };
  const engine: FakeEngine = {
    runs: [],
    parseInput(_kind, input) {
      const record = input as Record<string, unknown>;
      if (record['__invalid']) {
        throw new StepError('input', 'invalid_input', 'Invalid job input: unit.title: Required', {
          retryable: false,
        });
      }
      return { ...record, parsed: true };
    },
    nextStep(kind, _input, state) {
      return stepsOf(kind, state).find((step) => state.outputs[step] === undefined) ?? null;
    },
    progress(kind, _input, state) {
      const all = stepsOf(kind, state);
      return {
        done: all.filter((step) => state.outputs[step] !== undefined),
        next: all.find((step) => state.outputs[step] === undefined) ?? null,
        total: all.length,
      };
    },
    async runStep(call, deps) {
      engine.runs.push({
        kind: call.kind,
        step: call.step,
        state: call.state,
        deps,
        input: call.input,
      });
      const custom = script[call.step];
      if (custom) return custom({ state: call.state, deps });
      const last = stepsOf(call.kind, call.state).at(-1) === call.step;
      const output: Json =
        call.step === 'outline' ? { sections: ['s1', 's2'] } : { step: call.step };
      if (!last) return { output, usage: [usageOf(call.step)] };
      const result =
        call.kind === 'unit_generate' || call.kind === 'unit_revise'
          ? DRAFT
          : call.kind === 'chapter_plan'
            ? { plan: { chapters: [] }, flags: [] }
            : { scheme: { weeks: [] }, flags: [], source_note: 'n' };
      return { output, usage: [usageOf(call.step)], result };
    },
  };
  return engine;
}

const unitParams = (n = 1) => ({ unit_id: IDS.unit(n) });

/** The JSON of a response, loosely typed on purpose: the tests probe shapes the protocol types do not promise. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type LooseJson = Record<string, any>;

async function body(response: Response): Promise<LooseJson> {
  return (await response.json()) as LooseJson;
}

/** Steps a job until it is finished (or `limit` requests were made); returns the statuses of the step requests. */
async function drive(
  env: Env,
  jobId: string,
  options: SendOptions = {},
  limit = 30,
): Promise<number[]> {
  const statuses: number[] = [];
  for (let turn = 0; turn < limit; turn += 1) {
    const response = await env.send({ action: 'step', job_id: jobId }, options);
    statuses.push(response.status);
    await env.flush();
    const status = env.backend.row(jobId)['status'];
    if (status === 'succeeded' || status === 'failed' || status === 'cancelled') break;
    if (response.status >= 400) break;
  }
  return statuses;
}

describe('contract agreement', () => {
  it('repeats the protocol error codes of the contract and gives each a status', () => {
    expect([...AI_JOB_ERROR_CODES]).toEqual([...CONTRACT_ERROR_CODES]);
    for (const code of AI_JOB_ERROR_CODES) expect(STATUS_OF_CODE[code]).toBeGreaterThanOrEqual(400);
  });

  it('keeps the enrichment menu of the resolver equal to the content schema', () => {
    expect([...ENRICHMENT_MENU]).toEqual([...SCHEMA_ENRICHMENT_MENU]);
  });
});

describe('CORS', () => {
  it('answers a preflight from an allowed origin with the origin reflected, never *', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const response = await env.send(null, {
      method: 'OPTIONS',
      origin: 'https://admin.example.com',
      token: null,
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example.com');
    expect(response.headers.get('Vary')).toBe('Origin');
    const allowed = (response.headers.get('Access-Control-Allow-Headers') ?? '')
      .split(',')
      .map((h) => h.trim());
    expect(allowed).toEqual(
      expect.arrayContaining(['authorization', 'apikey', 'content-type', 'x-client-info']),
    );
    expect(response.headers.get('Access-Control-Allow-Methods')).toBe('POST, OPTIONS');
  });

  it('allows localhost development origins and nothing that merely looks like them', async () => {
    const env = makeEnv({ engine: makeEngine(), allowedOrigins: [] });
    for (const origin of ['http://localhost:8081', 'http://127.0.0.1:19006', 'http://localhost']) {
      const response = await env.send(null, { method: 'OPTIONS', origin, token: null });
      expect(response.status).toBe(204);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBe(origin);
    }
    for (const origin of [
      'http://localhost.evil.example',
      'http://localhostx:8081',
      'https://admin.example.com',
      'null',
    ]) {
      const response = await env.send(null, { method: 'OPTIONS', origin, token: null });
      expect(response.status).toBe(403);
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });

  it('can switch localhost off, and matches the allow-list exactly', () => {
    expect(isAllowedOrigin('http://localhost:3000', [], false)).toBe(false);
    expect(isAllowedOrigin('https://admin.example.com', ['https://admin.example.com'])).toBe(true);
    expect(
      isAllowedOrigin('https://admin.example.com.evil.io', ['https://admin.example.com']),
    ).toBe(false);
    expect(isAllowedOrigin('http://admin.example.com', ['https://admin.example.com'])).toBe(false);
    expect(corsHeadersFor(null, { allowedOrigins: [] })).toEqual({});
    expect(corsHeadersFor('https://nope.example', { allowedOrigins: [] })).toBeNull();
  });

  it('refuses a request from a refused origin before doing anything, and puts CORS headers on every other answer', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const refused = await env.send(
      { action: 'cancel', job_id: IDS.unit(1) },
      { origin: 'https://evil.example' },
    );
    expect(refused.status).toBe(403);
    expect(env.userDbs).toHaveLength(0);

    const ok = await env.send({ nope: true }, { origin: 'https://admin.example.com' });
    expect(ok.status).toBe(400);
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe('https://admin.example.com');
    const noOrigin = await env.send({ nope: true });
    expect(noOrigin.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });
});

describe('authentication', () => {
  it('accepts POST only', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const response = await env.send(null, { method: 'GET' });
    expect(response.status).toBe(405);
    expect((await body(response)).error.code).toBe('invalid_request');
  });

  it('needs a bearer token of a signed-in user', async () => {
    const env = makeEnv({ engine: makeEngine() });
    for (const options of [
      { token: null },
      { token: 'not-a-jwt' },
      { token: makeJwt({ role: 'anon' }) },
      { token: makeJwt({ role: 'authenticated', aal: 'aal2' }) },
      { sub: ED, role: 'service_role' },
      { exp: 1 },
    ] as SendOptions[]) {
      const response = await env.send({ action: 'step', job_id: IDS.unit(1) }, options);
      expect(response.status).toBe(401);
      expect((await body(response)).error.code).toBe('unauthenticated');
    }
  });

  it('asks for the second factor when the session is aal1', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const response = await env.send(
      { action: 'create', kind: 'unit_generate', params: unitParams() },
      { aal: 'aal1' },
    );
    expect(response.status).toBe(403);
    expect((await body(response)).error.code).toBe('mfa_required');
    expect(env.userDbs).toHaveLength(0);
  });

  it('refuses everybody who is not content staff, and everybody but writers for create and step', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const stranger = await env.send(
      { action: 'create', kind: 'unit_generate', params: unitParams() },
      { sub: 'f9999999-0000-4000-8000-000000000009' },
    );
    expect(stranger.status).toBe(403);
    expect((await body(stranger)).error.code).toBe('forbidden');
    const support = await env.send(
      { action: 'create', kind: 'unit_generate', params: unitParams() },
      { sub: SUP },
    );
    expect(support.status).toBe(403);

    const reviewerCreate = await env.send(
      { action: 'create', kind: 'unit_generate', params: unitParams() },
      { sub: RV },
    );
    expect(reviewerCreate.status).toBe(403);
    const reviewerStep = await env.send({ action: 'step', job_id: IDS.unit(1) }, { sub: RV });
    expect(reviewerStep.status).toBe(403);
    expect(env.backend.rows).toHaveLength(0);
  });

  it('maps a database error while reading the role', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const original = env.deps.userDb;
    env.deps.userDb = (req) => {
      const db = original(req) as FakeDb;
      db.tableErrors.set('admin_users', { code: 'PGRST301', message: 'JWT expired' });
      return db;
    };
    const response = await env.send({ action: 'cancel', job_id: IDS.unit(1) });
    expect(response.status).toBe(401);
  });
});

describe('request validation', () => {
  it('rejects bodies that are not JSON objects of the protocol', async () => {
    const env = makeEnv({ engine: makeEngine() });
    expect((await env.send(null, { rawBody: '{oops' })).status).toBe(400);
    expect((await env.send({ action: 'burn' })).status).toBe(400);
    const badId = await env.send({ action: 'step', job_id: 'not-a-uuid' });
    expect(badId.status).toBe(400);
    expect((await body(badId)).error.message).toContain('job_id');
    expect((await env.send({ action: 'create', kind: 'nonsense', params: {} })).status).toBe(400);
    expect(
      (
        await env.send({
          action: 'create',
          kind: 'unit_generate',
          params: {},
          idempotency_key: 'short',
        })
      ).status,
    ).toBe(400);
  });

  it('rejects a body that is too large', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const response = await env.send(null, { rawBody: ' '.repeat(700_000) });
    expect(response.status).toBe(413);
  });

  it('validates the params of the kind with the contract schema', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const response = await env.send({
      action: 'create',
      kind: 'unit_generate',
      params: { unit_id: 'nope' },
    });
    expect(response.status).toBe(400);
    const error = (await body(response)).error;
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('unit_id');
    expect(env.backend.rows).toHaveLength(0);
  });
});

describe('create', () => {
  it('builds the input from the database as the caller, lets the engine parse it, and inserts the job', async () => {
    const engine = makeEngine();
    const env = makeEnv({ engine });
    const response = await env.send({
      action: 'create',
      kind: 'unit_generate',
      params: { unit_id: IDS.unit(2), notes: 'use cassava' },
      idempotency_key: 'create-key-0001',
    });
    expect(response.status).toBe(201);
    const { job } = await body(response);
    expect(job).toMatchObject({
      kind: 'unit_generate',
      status: 'queued',
      unit_id: IDS.unit(2),
      scheme_id: IDS.scheme,
      created_by: ED,
    });

    const call = env.userDbs[0]!.calledWith('create_ai_job')[0]!;
    expect(call['p_kind']).toBe('unit_generate');
    expect(call['p_unit_id']).toBe(IDS.unit(2));
    expect(call['p_scheme_id']).toBe(IDS.scheme);
    expect(call['p_idempotency_key']).toBe('create-key-0001');
    expect(call['p_params']).toEqual({ unit_id: IDS.unit(2), notes: 'use cassava' });
    const input = call['p_input'] as Record<string, unknown>;
    expect(input['parsed']).toBe(true);
    expect(input['unit']).toMatchObject({
      id: IDS.unit(2),
      title: 'Unit 2',
      objective: 'Objective 2',
      week_no: 2,
    });
    expect(input['notes']).toBe('use cassava');
    expect(env.service.calls).toEqual([]);
    expect(env.service.reads).toEqual([]);
  });

  it('reads with the caller client only, so row level security decides what exists', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const original = env.deps.userDb;
    env.deps.userDb = (req) => {
      const db = original(req) as FakeDb;
      db.tables = { ...db.tables, units: [] };
      return db;
    };
    const response = await env.send({
      action: 'create',
      kind: 'unit_generate',
      params: unitParams(),
    });
    expect(response.status).toBe(404);
    expect((await body(response)).error.code).toBe('not_found');
    expect(env.service.reads).toEqual([]);
  });

  it('is idempotent on the key', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const request = {
      action: 'create',
      kind: 'unit_generate',
      params: unitParams(),
      idempotency_key: 'same-key-0001',
    };
    const first = await body(await env.send(request));
    const second = await body(await env.send(request));
    expect(second.job.id).toBe(first.job.id);
    expect(env.backend.rows).toHaveLength(1);
    const other = await body(await env.send(request, { sub: ED2 }));
    expect(other.job.id).not.toBe(first.job.id);
  });

  it('answers a bad engine input with a 400 that says what is wrong', async () => {
    const engine = makeEngine();
    engine.parseInput = () => {
      throw new StepError(
        'input',
        'invalid_input',
        'Invalid job input: scheme.weeks.2.topic: must not be blank',
        { retryable: false },
      );
    };
    const env = makeEnv({ engine });
    const response = await env.send({
      action: 'create',
      kind: 'chapter_plan',
      params: { scheme_id: IDS.scheme },
    });
    expect(response.status).toBe(400);
    const error = (await body(response)).error;
    expect(error.code).toBe('invalid_request');
    expect(error.message).toContain('scheme.weeks.2.topic');
    expect(env.backend.rows).toHaveLength(0);
  });

  it('maps the refusals of create_ai_job', async () => {
    const env = makeEnv({ engine: makeEngine(), settings: { kill_switch: true } });
    const killed = await env.send({
      action: 'create',
      kind: 'unit_generate',
      params: unitParams(),
    });
    expect(killed.status).toBe(503);
    expect((await body(killed)).error.code).toBe('kill_switch');

    const busy = makeEnv({ engine: makeEngine() });
    for (let n = 1; n <= 5; n += 1) await busy.createJob('unit_generate', unitParams(n));
    const sixth = await busy.send({
      action: 'create',
      kind: 'unit_generate',
      params: unitParams(6),
    });
    expect(sixth.status).toBe(429);
    const error = (await body(sixth)).error;
    expect(error.code).toBe('budget_exceeded');
    expect(error.message).toContain('5 jobs');
    expect(
      (
        await busy.send(
          { action: 'create', kind: 'unit_generate', params: unitParams(6) },
          { sub: ED2 },
        )
      ).status,
    ).toBe(201);
  });

  it('never leaks a database message', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const original = env.deps.userDb;
    env.deps.userDb = (req) => {
      const db = original(req) as FakeDb;
      db.rpcs['create_ai_job'] = () =>
        fail('connection to 10.0.0.3 refused: password authentication failed', '08006');
      return db;
    };
    const response = await env.send({
      action: 'create',
      kind: 'unit_generate',
      params: unitParams(),
    });
    expect(response.status).toBe(500);
    const text = JSON.stringify(await body(response));
    expect(text).not.toContain('10.0.0.3');
    expect(text).not.toContain('password');
    expect(env.logs.some((entry) => entry.event === 'database_error')).toBe(true);
  });

  it('stores an ingest text by its length, not twice', async () => {
    const env = makeEnv({ engine: makeEngine() });
    await env.createJob('scheme_ingest', {
      subject_id: IDS.subject,
      level_code: 'P1',
      term: 3,
      source: { type: 'text', text: 'WEEK 1 ...', filename: 'scheme.txt' },
    });
    const call = env.userDbs[0]!.calledWith('create_ai_job')[0]!;
    expect(call['p_params']).toMatchObject({
      source: { type: 'text', filename: 'scheme.txt', characters: 10 },
    });
    expect(JSON.stringify(call['p_params'])).not.toContain('WEEK 1');
    expect((call['p_input'] as { source: { text: string } }).source.text).toBe('WEEK 1 ...');
  });
});

describe('step', () => {
  it('answers 202 at once and runs the whole job one step per request, saving the draft with the caller', async () => {
    const engine = makeEngine();
    const env = makeEnv({
      engine,
      settings: {
        prices: {
          'claude-opus-5-5': {
            input_per_mtok: 10,
            output_per_mtok: 20,
            cache_read_per_mtok: 1,
            cache_write_per_mtok: 2,
          },
        },
      },
    });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);

    const first = await env.send({ action: 'step', job_id: jobId });
    expect(first.status).toBe(202);
    const accepted = (await body(first)).job;
    expect(accepted.status).toBe('running');
    expect(Date.parse(accepted.lease_until)).toBeGreaterThan(env.clock.t);
    expect(accepted).not.toHaveProperty('input');
    expect(accepted).not.toHaveProperty('lease_token');
    // nothing has run yet when the 202 is built: the step is in waitUntil
    expect(env.pending).toHaveLength(1);
    await env.flush();
    expect(env.backend.row(jobId)).toMatchObject({
      status: 'running',
      lease_until: null,
      attempts: 0,
    });
    expect(env.backend.row(jobId)['progress']).toEqual({
      done: ['outline'],
      next: 'section:s1',
      total: 4,
    });

    const statuses = await drive(env, jobId);
    expect(statuses.every((status) => status === 202)).toBe(true);
    expect(engine.runs.map((run) => run.step)).toEqual([
      'outline',
      'section:s1',
      'section:s2',
      'assemble',
    ]);

    const row = env.backend.row(jobId);
    expect(row['status']).toBe('succeeded');
    expect(row['progress']).toEqual({
      done: ['outline', 'section:s1', 'section:s2', 'assemble'],
      next: null,
      total: 4,
    });
    const version = env.tables['unit_versions']![0]!;
    expect(row['result']).toEqual({
      unit_version_id: version['id'],
      version: 1,
      lint: { errors: 0, warnings: 1, ok: true },
      review: DRAFT.review,
      summary: DRAFT.summary,
    });
    expect(version).toMatchObject({
      unit_id: IDS.unit(1),
      generated_by: 'ai',
      model: 'claude-opus-5-5-20261001',
      prompt_version: 'm2-v1',
      base_version_id: null,
      status: 'draft',
      created_by: ED,
      content: DRAFT.content,
    });
    expect(version['lint_report']).toEqual({
      errors: [],
      warnings: DRAFT.lint.warnings,
      ok: true,
      review: DRAFT.review,
      summary: DRAFT.summary,
    });
    // four calls logged, priced through the alias (the API reported a dated snapshot)
    expect(env.backend.usage).toHaveLength(4);
    expect(
      env.backend.usage.every((entry) => entry.est_cost_usd !== null && entry.est_cost_usd > 0),
    ).toBe(true);
    // the draft was saved with the CALLER's client, never the service role's
    expect(env.service.calls.map((call) => call.name).sort()).toEqual(
      [
        ...Array(4).fill('ai_job_acquire_lease'),
        ...Array(4).fill('ai_job_budget_check'),
        ...Array(4).fill('ai_job_complete_step'),
      ].sort(),
    );
    expect(env.service.reads).toEqual([]);
  });

  it('hands the engine the parsed input, the stored state, the settings, a model client, an abort signal and the clock', async () => {
    const engine = makeEngine();
    const llm = { generate: () => Promise.reject(new Error('unused')) };
    const env = makeEnv({ engine, llm, settings: { prompt_version: 'm2-v7' } });
    const job = await env.createJob('unit_generate', unitParams(1));
    await drive(env, String(job['id']), {}, 2);
    const [outline, section] = engine.runs;
    expect(outline!.input).toMatchObject({ parsed: true });
    expect(outline!.state).toEqual({ outputs: {} });
    expect(outline!.deps.llm).toBe(llm);
    expect(outline!.deps.settings.prompt_version).toBe('m2-v7');
    expect(outline!.deps.signal).toBeInstanceOf(AbortSignal);
    expect(outline!.deps.signal!.aborted).toBe(false);
    expect(outline!.deps.now().getTime()).toBe(env.clock.t);
    expect(section!.state.outputs).toEqual({ outline: { sections: ['s1', 's2'] } });
    expect(env.llmBuilds).toHaveLength(2);
  });

  it('aborts the step shortly before the lease ends', async () => {
    let signal: AbortSignal | undefined;
    const engine = makeEngine({
      outline: async ({ deps }) => {
        signal = deps.signal;
        await new Promise((resolve) => setTimeout(resolve, 60));
        return { output: { sections: [] }, usage: [] };
      },
    });
    const env = makeEnv({ engine, stepTimeoutMs: 20 });
    const job = await env.createJob('unit_generate', unitParams(1));
    await env.send({ action: 'step', job_id: String(job['id']) });
    await env.flush();
    expect(signal!.aborted).toBe(true);
  });

  it('returns a finished job as it is, without leasing', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('chapter_plan', { scheme_id: IDS.scheme });
    await drive(env, String(job['id']));
    expect(env.backend.row(String(job['id']))['status']).toBe('succeeded');
    const acquires = env.service.calledWith('ai_job_acquire_lease').length;
    const response = await env.send({ action: 'step', job_id: String(job['id']) });
    expect(response.status).toBe(200);
    const answer = await body(response);
    expect(answer.job.status).toBe('succeeded');
    expect(answer).not.toHaveProperty('busy');
    expect(env.service.calledWith('ai_job_acquire_lease')).toHaveLength(acquires);
  });

  it('says busy while a step is in flight, from the row and from the lease race alike', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = makeEnv({
      engine: makeEngine({
        outline: async () => {
          await gate;
          return { output: { sections: ['s1'] }, usage: [usageOf('outline')] };
        },
      }),
    });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    // the first step is still running: its lease is live, so the second request is answered from the row
    const second = await env.send({ action: 'step', job_id: jobId });
    expect(second.status).toBe(200);
    expect((await body(second)).busy).toBe(true);
    expect(env.service.calledWith('ai_job_acquire_lease')).toHaveLength(1);

    // the row the caller reads is stale (no lease), but the database says busy
    env.backend.row(jobId)['lease_until'] = null;
    const leaseBefore = env.backend.row(jobId)['lease_token'];
    env.service.rpcs['ai_job_acquire_lease'] = () => ({
      data: { acquired: false, reason: 'busy', job: structuredClone(env.backend.row(jobId)) },
      error: null,
    });
    const raced = await env.send({ action: 'step', job_id: jobId });
    expect(raced.status).toBe(200);
    expect((await body(raced)).busy).toBe(true);
    expect(env.backend.row(jobId)['lease_token']).toBe(leaseBefore);
    release();
    await env.flush();
  });

  it('runs steps only for the person who started the job, and hides jobs the caller cannot see', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('unit_generate', unitParams(1));
    const other = await env.send({ action: 'step', job_id: String(job['id']) }, { sub: SA });
    expect(other.status).toBe(403);
    expect(env.service.calls).toEqual([]);
    const unknown = await env.send({ action: 'step', job_id: IDS.unit(77) });
    expect(unknown.status).toBe(404);
    // ED2 cannot see ED's job (row level security): not found, not forbidden
    const original = env.deps.userDb;
    env.deps.userDb = (req) => {
      const db = original(req) as FakeDb;
      db.tables = { ...db.tables, ai_jobs: [] };
      return db;
    };
    expect(
      (await env.send({ action: 'step', job_id: String(job['id']) }, { sub: ED2 })).status,
    ).toBe(404);
  });

  it('stops at the kill switch and at the budgets before leasing anything', async () => {
    const env = makeEnv({ engine: makeEngine(), settings: { kill_switch: false } });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);

    env.backend.settings.kill_switch = true;
    const killed = await env.send({ action: 'step', job_id: jobId });
    expect(killed.status).toBe(503);
    expect((await body(killed)).error.code).toBe('kill_switch');
    expect(env.service.calledWith('ai_job_acquire_lease')).toHaveLength(0);
    expect(env.backend.row(jobId)['status']).toBe('queued');

    env.backend.settings.kill_switch = false;
    env.backend.settings.prices = {
      'claude-opus-5-5': {
        input_per_mtok: 1000,
        output_per_mtok: 1000,
        cache_read_per_mtok: 0,
        cache_write_per_mtok: 0,
      },
    };
    env.backend.settings.budget = { max_usd_per_job: 1, daily_usd_cap: null };
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    await env.flush();
    // the first step cost (1000 + 500) * 1000 / 1e6 = 1.5 dollars: this job has used its budget
    const overJob = await env.send({ action: 'step', job_id: jobId });
    expect(overJob.status).toBe(429);
    expect((await body(overJob)).error.code).toBe('budget_exceeded');
    expect(env.service.calledWith('ai_job_acquire_lease')).toHaveLength(1);

    env.backend.settings.budget = { max_usd_per_job: null, daily_usd_cap: 1 };
    const overDay = await env.send({ action: 'step', job_id: jobId });
    expect(overDay.status).toBe(429);
    expect((await body(overDay)).error.message).toContain("Today's AI budget");

    env.backend.settings.budget = { max_usd_per_job: 100, daily_usd_cap: 100 };
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    await env.flush();
  });

  it('counts calls without a price as unknown, not as free or as over budget', async () => {
    const env = makeEnv({
      engine: makeEngine(),
      settings: { budget: { max_usd_per_job: 0.01, daily_usd_cap: 0.01 } },
    });
    const job = await env.createJob('unit_generate', unitParams(1));
    const statuses = await drive(env, String(job['id']));
    expect(statuses.every((status) => status === 202)).toBe(true);
    expect(env.backend.row(String(job['id']))['status']).toBe('succeeded');
    expect(env.backend.usage.every((entry) => entry.est_cost_usd === null)).toBe(true);
  });

  it('fails fast and without touching the job when the model key is missing', async () => {
    const engine = makeEngine();
    const env = makeEnv({ engine, hasKey: false });
    const job = await env.createJob('unit_generate', unitParams(1));
    const response = await env.send({ action: 'step', job_id: String(job['id']) });
    expect(response.status).toBe(500);
    expect(await body(response)).toEqual({
      error: { code: 'internal', message: 'ANTHROPIC_API_KEY is not set for this project' },
    });
    expect(env.service.calls).toEqual([]);
    expect(env.backend.row(String(job['id']))).toMatchObject({
      status: 'queued',
      attempts: 0,
      error: null,
      lease_until: null,
    });
    expect(engine.runs).toHaveLength(0);

    // the same job carries on once the secret exists
    env.deps.hasAnthropicKey = () => true;
    expect((await env.send({ action: 'step', job_id: String(job['id']) })).status).toBe(202);
    await env.flush();
    expect(engine.runs).toHaveLength(1);
  });

  it('still reports a finished job when the key is missing', async () => {
    const env = makeEnv({ engine: makeEngine(), hasKey: true });
    const job = await env.createJob('chapter_plan', { scheme_id: IDS.scheme });
    await drive(env, String(job['id']));
    env.deps.hasAnthropicKey = () => false;
    expect((await env.send({ action: 'step', job_id: String(job['id']) })).status).toBe(200);
  });

  it('fails a job whose engine has no step left, without running anything', async () => {
    const engine = makeEngine();
    engine.nextStep = () => null;
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    const response = await env.send({ action: 'step', job_id: String(job['id']) });
    expect(response.status).toBe(200);
    expect((await body(response)).job).toMatchObject({
      status: 'failed',
      error: { code: 'internal', step: 'next_step', retryable: false },
    });
    expect(engine.runs).toHaveLength(0);
  });

  it('fails a job whose stored input no longer parses, for good', async () => {
    const engine = makeEngine();
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    engine.parseInput = () => {
      throw new StepError('input', 'invalid_input', 'Invalid job input: x', { retryable: false });
    };
    const response = await env.send({ action: 'step', job_id: String(job['id']) });
    expect((await body(response)).job).toMatchObject({
      status: 'failed',
      error: { code: 'invalid_input', retryable: false },
    });
  });

  it('treats a lost lease as a discarded step, not as an error', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    env.deps.serviceDb = () => {
      env.service.rpcs['ai_job_complete_step'] = () => ({ data: false, error: null });
      return env.service;
    };
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    await env.flush();
    expect(env.logs.map((entry) => entry.event)).toContain('step_output_discarded');
  });

  it('survives a failing completion call: the lease just runs out', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    env.deps.serviceDb = () => {
      env.service.rpcs['ai_job_complete_step'] = () => fail('network down', '08006');
      return env.service;
    };
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    await expect(env.flush()).resolves.toBeUndefined();
    expect(env.logs.map((entry) => entry.event)).toContain('complete_step_rpc_failed');
    expect(env.backend.row(jobId)['status']).toBe('running');
  });

  it('chapter plans and scheme drafts stay in the job row; no unit version is written', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const plan = await env.createJob('chapter_plan', { scheme_id: IDS.scheme });
    await drive(env, String(plan['id']));
    expect(env.backend.row(String(plan['id']))['result']).toEqual({
      plan: { chapters: [] },
      flags: [],
    });
    const ingest = await env.createJob('scheme_ingest', {
      subject_id: IDS.subject,
      level_code: 'P1',
      term: 3,
      source: { type: 'text', text: 'x', filename: 's.txt' },
    });
    await drive(env, String(ingest['id']));
    expect(env.backend.row(String(ingest['id']))['result']).toEqual({
      scheme: { weeks: [] },
      flags: [],
      source_note: 'n',
    });
    expect(env.tables['unit_versions']).toHaveLength(0);
    expect(env.userDbs.flatMap((db) => db.calledWith('create_unit_version_draft'))).toHaveLength(0);
  });

  it('a revision is based on the version it revised', async () => {
    const env = makeEnv({ engine: makeEngine() });
    env.tables['unit_versions']!.push({
      id: IDS.version(1),
      unit_id: IDS.unit(1),
      version: 1,
      status: 'approved',
      content: { sections: [{ id: 'concept_1', type: 'concept', blocks: [] }] },
    });
    const job = await env.createJob('unit_revise', {
      unit_version_id: IDS.version(1),
      instruction: 'shorter',
      section_ids: ['concept_1'],
    });
    await drive(env, String(job['id']));
    const created = env.tables['unit_versions']!.find((row) => row['version'] === 2)!;
    expect(created).toMatchObject({
      base_version_id: IDS.version(1),
      generated_by: 'ai',
      status: 'draft',
    });
    expect(env.backend.row(String(job['id']))['result']).toMatchObject({
      version: 2,
      unit_version_id: created['id'],
    });
  });

  it('fails the job with code conflict when the unit changed (stale_base), keeping what was spent', async () => {
    const env = makeEnv({ engine: makeEngine() });
    env.tables['unit_versions']!.push({
      id: IDS.version(1),
      unit_id: IDS.unit(1),
      version: 1,
      status: 'approved',
      content: { sections: [] },
    });
    const job = await env.createJob('unit_revise', {
      unit_version_id: IDS.version(1),
      instruction: 'shorter',
    });
    // somebody saves a newer version while the revision runs
    env.tables['unit_versions']!.push({
      id: IDS.version(2),
      unit_id: IDS.unit(1),
      version: 2,
      status: 'draft',
      content: { sections: [] },
    });
    await drive(env, String(job['id']));
    const row = env.backend.row(String(job['id']));
    expect(row['status']).toBe('failed');
    expect(row['error']).toEqual({
      code: 'conflict',
      message:
        'The unit changed while the draft was being written. Open the latest version and try again.',
      step: 'revise',
      retryable: false,
    });
    expect(row['result']).toBeNull();
    expect(env.backend.usage.filter((entry) => entry.job_id === job['id'])).toHaveLength(1);
    expect(env.tables['unit_versions']).toHaveLength(2);
  });

  it('the same conflict is reported when the database refuses the generated draft', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const original = env.backend.userRpcs.bind(env.backend);
    env.backend.userRpcs = (userId, superAdmin) => ({
      ...original(userId, superAdmin),
      create_unit_version_draft: () => fail('stale_base', '22023'),
    });
    const job = await env.createJob('unit_generate', unitParams(1));
    await drive(env, String(job['id']));
    expect(env.backend.row(String(job['id']))).toMatchObject({
      status: 'failed',
      error: { code: 'conflict', retryable: false },
    });
  });

  it('retries a draft that could not be saved for a passing reason', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const original = env.backend.userRpcs.bind(env.backend);
    env.backend.userRpcs = (userId, superAdmin) => ({
      ...original(userId, superAdmin),
      create_unit_version_draft: () => fail('JWT expired', 'PGRST301'),
    });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    await drive(env, jobId, {}, 4);
    // outline, s1, s2 done; the assemble step produced a draft the database refused: retryable internal failure
    expect(env.backend.row(jobId)).toMatchObject({
      status: 'running',
      attempts: 1,
      error: { code: 'internal', retryable: true, step: 'assemble' },
    });
    expect(env.backend.usage.filter((entry) => entry.label === 'fake:assemble')).toHaveLength(1);
  });
});

describe('failures of a step', () => {
  it('retries a transient failure with a fixed message, three attempts in all', async () => {
    let attempts = 0;
    const engine = makeEngine({
      outline: () => {
        attempts += 1;
        throw new StepError(
          'outline',
          'transport',
          'Overloaded: sk-ant-api03-LEAK upstream said {"raw":"MODEL OUTPUT"}',
          {
            retryable: true,
            usage: [usageOf('outline')],
          },
        );
      },
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);

    await drive(env, jobId, {}, 1);
    expect(env.backend.row(jobId)).toMatchObject({
      status: 'running',
      attempts: 1,
      lease_until: null,
      error: {
        code: 'transport',
        message: 'The model service could not be reached or is busy. Try again.',
        step: 'outline',
        retryable: true,
      },
    });
    await drive(env, jobId, {}, 1);
    expect(env.backend.row(jobId)).toMatchObject({ status: 'running', attempts: 2 });
    await drive(env, jobId, {}, 1);
    expect(env.backend.row(jobId)).toMatchObject({ status: 'failed', attempts: 3 });
    expect(env.backend.row(jobId)['finished_at']).not.toBeNull();
    expect(attempts).toBe(3);
    // a failed job is not stepped any more
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(200);
    expect(attempts).toBe(3);
  });

  it('keeps what a failed step already cost (StepError.usage goes to fail_step)', async () => {
    const engine = makeEngine({
      outline: () => {
        throw new StepError('outline', 'refusal', 'declined', {
          retryable: false,
          usage: [usageOf('outline'), usageOf('outline-repair')],
        });
      },
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    await drive(env, String(job['id']));
    const failed = env.service.calledWith('ai_job_fail_step')[0]!;
    expect(failed['p_retryable']).toBe(false);
    expect(failed['p_usage']).toHaveLength(2);
    expect(failed['p_error']).toEqual({
      code: 'refusal',
      message: 'The model declined to answer this step.',
    });
    expect(env.backend.usage.map((entry) => entry.label)).toEqual([
      'fake:outline',
      'fake:outline-repair',
    ]);
    expect(env.backend.row(String(job['id']))).toMatchObject({
      status: 'failed',
      attempts: 1,
      error: { code: 'refusal', retryable: false },
    });
  });

  it('fails a refusal, a truncation and a schema failure at once; retries the rest', async () => {
    const cases: Array<[string, boolean, string]> = [
      ['refusal', false, 'failed'],
      ['truncated', false, 'failed'],
      ['schema', false, 'failed'],
      ['aborted', true, 'running'],
      ['transport', true, 'running'],
    ];
    for (const [code, retryable, status] of cases) {
      const engine = makeEngine({
        outline: () => {
          throw new StepError('outline', code as never, 'x', { retryable });
        },
      });
      const env = makeEnv({ engine });
      const job = await env.createJob('unit_generate', unitParams(1));
      await drive(env, String(job['id']), {}, 1);
      const row = env.backend.row(String(job['id']));
      expect(row['status'], code).toBe(status);
      expect((row['error'] as Row)['code'], code).toBe(code);
    }
  });

  it('turns any unexpected error into a retryable internal failure, and keeps raw text out of the row', async () => {
    const secrets = [
      'sk-ant-api03-SECRETKEY',
      'You are a tutor for Primary 1',
      'RAW MODEL OUTPUT {"a":1}',
      'at Object.run (file.ts:10:5)',
    ];
    const engine = makeEngine({
      outline: () => {
        throw new TypeError(`${secrets.join(' | ')}`);
      },
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    const response = await env.send({ action: 'step', job_id: String(job['id']) });
    const accepted = JSON.stringify(await body(response));
    await env.flush();
    const row = env.backend.row(String(job['id']));
    expect(row['error']).toEqual({
      code: 'internal',
      message: 'Something went wrong while running this step.',
      step: 'outline',
      retryable: true,
    });
    expect(row['status']).toBe('running');
    const stored = JSON.stringify(row) + accepted + JSON.stringify(env.service.calls);
    for (const secret of secrets) expect(stored).not.toContain(secret);
    const logged = JSON.stringify(env.logs);
    expect(logged).not.toContain('sk-ant-api03-SECRETKEY');
    expect(logged).toContain('[redacted]');
  });

  it('does not store the engine message of a StepError either', async () => {
    const engine = makeEngine({
      outline: () => {
        throw new StepError(
          'outline',
          'schema',
          'reply was: {"title": "RAW MODEL OUTPUT"} and the prompt was PROMPT TEXT',
          { retryable: false },
        );
      },
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    await drive(env, String(job['id']));
    const row = JSON.stringify(env.backend.row(String(job['id'])));
    expect(row).not.toContain('RAW MODEL OUTPUT');
    expect(row).not.toContain('PROMPT TEXT');
    expect(row).toContain("The model's answer did not match the expected format.");
  });

  it('tolerates an error the engine threw in a shape it knows only by name', async () => {
    const engine = makeEngine({
      outline: () => {
        const error = Object.assign(new Error('different bundle'), {
          name: 'StepError',
          code: 'truncated',
          retryable: false,
          step: 'outline',
        });
        throw error;
      },
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    await drive(env, String(job['id']));
    expect(env.backend.row(String(job['id']))).toMatchObject({
      status: 'failed',
      error: { code: 'truncated' },
    });
  });
});

describe('uploads', () => {
  const ingest = (path: string) => ({
    subject_id: IDS.subject,
    level_code: 'P1',
    term: 3,
    source: { type: 'pdf', path, filename: 'scheme.pdf' },
  });

  it('checks that a PDF sits under the caller prefix and exists', async () => {
    const env = makeEnv({ engine: makeEngine() });
    env.uploads.set(`scheme-uploads/${ED}/scheme.pdf`, {
      bytes: new Uint8Array([37, 80, 68, 70]),
      type: 'application/pdf',
    });
    expect(
      (
        await env.send({
          action: 'create',
          kind: 'scheme_ingest',
          params: ingest(`${ED}/scheme.pdf`),
        })
      ).status,
    ).toBe(201);

    for (const path of [
      `${ED2}/scheme.pdf`,
      `${ED}/../${ED2}/scheme.pdf`,
      `${ED}//scheme.pdf`,
      'scheme.pdf',
      `${ED}/`,
    ]) {
      const refused = await env.send({
        action: 'create',
        kind: 'scheme_ingest',
        params: ingest(path),
      });
      expect(refused.status, path).toBe(400);
    }
    const missing = await env.send({
      action: 'create',
      kind: 'scheme_ingest',
      params: ingest(`${ED}/other.pdf`),
    });
    expect(missing.status).toBe(404);
  });

  it('reads the file for the step with the caller storage client, never the service role', async () => {
    let loaded: { bytes: Uint8Array; mime: string } | undefined;
    let refused: unknown;
    const engine = makeEngine({
      extract: async ({ deps }) => {
        loaded = await deps.loadUpload(`${ED}/scheme.pdf`);
        refused = await deps.loadUpload(`${ED2}/scheme.pdf`).catch((error: unknown) => error);
        return { output: { ok: true }, usage: [] };
      },
    });
    const env = makeEnv({ engine });
    env.uploads.set(`scheme-uploads/${ED}/scheme.pdf`, {
      bytes: new Uint8Array([1, 2, 3]),
      type: 'application/pdf',
    });
    const job = await env.createJob('scheme_ingest', ingest(`${ED}/scheme.pdf`));
    await drive(env, String(job['id']), {}, 1);
    expect(Array.from(loaded!.bytes)).toEqual([1, 2, 3]);
    expect(loaded!.mime).toBe('application/pdf');
    expect(refused).toBeInstanceOf(Error);
    expect(env.service.storageCalls).toEqual([]);
    expect(
      env.userDbs.some((db) =>
        db.storageCalls.includes(`download:scheme-uploads/${ED}/scheme.pdf`),
      ),
    ).toBe(true);
    expect(
      env.userDbs.some((db) =>
        db.storageCalls.some((call) => call.includes(ED2) && call.startsWith('download')),
      ),
    ).toBe(false);
  });
});

describe('cancel', () => {
  it('cancels through the caller client', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('unit_generate', unitParams(1));
    const response = await env.send({ action: 'cancel', job_id: String(job['id']) });
    expect(response.status).toBe(200);
    expect((await body(response)).job).toMatchObject({
      id: job['id'],
      status: 'cancelled',
      lease_until: null,
    });
    expect(env.service.calls).toEqual([]);
    expect(env.userDbs.at(-1)!.calledWith('cancel_ai_job')).toEqual([{ p_job_id: job['id'] }]);
  });

  it('lets a super_admin cancel any job, a reviewer only find nothing, support nothing at all', async () => {
    const env = makeEnv({ engine: makeEngine() });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    expect((await env.send({ action: 'cancel', job_id: jobId }, { sub: ED2 })).status).toBe(404);
    expect((await env.send({ action: 'cancel', job_id: jobId }, { sub: RV })).status).toBe(404);
    expect((await env.send({ action: 'cancel', job_id: jobId }, { sub: SUP })).status).toBe(403);
    expect((await env.send({ action: 'cancel', job_id: IDS.unit(77) })).status).toBe(404);
    const byAdmin = await env.send({ action: 'cancel', job_id: jobId }, { sub: SA });
    expect(byAdmin.status).toBe(200);
    expect((await body(byAdmin)).job.status).toBe('cancelled');
  });

  it('a step in flight cannot store its output after the cancel', async () => {
    let release!: () => void;
    const engine = makeEngine({
      outline: () =>
        new Promise<StepOutcome>((resolve) => {
          release = () => resolve({ output: { sections: ['s1'] }, usage: [usageOf('outline')] });
        }),
    });
    const env = makeEnv({ engine });
    const job = await env.createJob('unit_generate', unitParams(1));
    const jobId = String(job['id']);
    expect((await env.send({ action: 'step', job_id: jobId })).status).toBe(202);
    await env.send({ action: 'cancel', job_id: jobId });
    release();
    await env.flush();
    const row = env.backend.row(jobId);
    expect(row['status']).toBe('cancelled');
    expect(row['progress']).toEqual({ done: [], next: null, total: 0 });
    expect(env.backend.usage).toHaveLength(1);
  });
});

describe('helpers', () => {
  it('decodes JWT claims and ignores garbage', () => {
    const token = makeJwt({ sub: 'u', role: 'authenticated', aal: 'aal2', exp: 5, extra: 'x' });
    expect(decodeJwtClaims(token)).toEqual({
      sub: 'u',
      role: 'authenticated',
      aal: 'aal2',
      exp: 5,
    });
    expect(decodeJwtClaims('a.b.c')).toBeNull();
    expect(decodeJwtClaims('nope')).toBeNull();
    expect(decodeJwtClaims(`x.${Buffer.from('[1]').toString('base64url')}.y`)).toBeNull();
  });

  it('classifies failures by shape', () => {
    expect(
      classifyFailure(
        new StepError('s', 'refusal', 'raw words', { retryable: false, usage: [usageOf('s')] }),
      ),
    ).toMatchObject({
      code: 'refusal',
      retryable: false,
      step: 's',
      message: 'The model declined to answer this step.',
    });
    expect(classifyFailure(new StepError('s', 'transport', 'x')).retryable).toBe(true);
    expect(classifyFailure(Object.assign(new Error('x'), { name: 'AbortError' }))).toMatchObject({
      code: 'aborted',
      retryable: true,
    });
    expect(
      classifyFailure(
        Object.assign(new Error('x'), { name: 'StepError', code: 'weird', retryable: false }),
      ),
    ).toMatchObject({
      code: 'internal',
      retryable: false,
    });
    expect(classifyFailure('plain string')).toMatchObject({ code: 'internal', retryable: true });
    expect(classifyFailure(null)).toMatchObject({ code: 'internal', retryable: true });
  });

  it('maps database errors without leaking them', () => {
    const log = () => {};
    expect(mapDbError({ code: '42501', message: 'admin_role_required' }, log)).toMatchObject({
      status: 403,
      code: 'forbidden',
    });
    expect(mapDbError({ code: '42501', message: 'not_authenticated' }, log)).toMatchObject({
      status: 401,
    });
    expect(mapDbError({ code: 'P0002', message: 'job_not_found' }, log)).toMatchObject({
      status: 404,
    });
    expect(mapDbError({ code: '22023', message: 'stale_base' }, log)).toMatchObject({
      status: 409,
      code: 'conflict',
    });
    expect(mapDbError({ code: '22023', message: 'invalid_job_input' }, log)).toMatchObject({
      status: 400,
      code: 'invalid_request',
    });
    expect(mapDbError({ code: 'PGRST301', message: 'JWT expired' }, log)).toMatchObject({
      status: 401,
    });
    expect(
      mapDbError({ code: '57014', message: 'statement timeout at 10.1.2.3' }, log),
    ).toMatchObject({ status: 500, code: 'internal' });
  });

  it('scrubs keys and bounds log text', () => {
    expect(scrub('key sk-ant-api03-abc_DEF-123 end')).toBe('key [redacted] end');
    expect(scrub('x'.repeat(500)).length).toBeLessThan(310);
  });
});
