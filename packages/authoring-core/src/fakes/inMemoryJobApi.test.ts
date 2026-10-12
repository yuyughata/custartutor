import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AiJobApiError } from '../client/errors';
import {
  DEFAULT_AI_SETTINGS,
  DEFAULT_MODELS,
  JobRow,
  LlmError,
  MAX_STEP_ATTEMPTS,
  STEP_LEASE_SECONDS,
  StepError,
} from '../contract';
import type { AiSettings, JobEngine, JobState, Json, LlmResult, UsageRecord } from '../contract';
import { FakeLlm } from './fakeLlm';
import { createInMemoryJobApi } from './inMemoryJobApi';
import type { InMemoryJobApiOptions } from './inMemoryJobApi';

const SCHEME_ID = '11111111-1111-4111-8111-111111111111';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';
const PlanReply = z.object({ parts: z.number().int() });

/** A virtual clock: lease expiry and the daily budget are driven by it, never by real time. */
class TestClock {
  t = Date.parse('2026-10-12T08:00:00.000Z');
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

/** Lets background steps run to their next await. */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Script {
  /** Every `runStep`, by step name, in order. */
  calls: string[];
  /** Thrown by the next calls of a step. */
  failures: Map<string, Error[]>;
  /** The next calls of a step wait for these. */
  holds: Map<string, Promise<void>[]>;
}

/** plan (asks the model how many parts) -> write_1..write_n (dynamic) -> finish. */
function createEngine(script: Script): JobEngine {
  const planned = (state: JobState) => state.outputs['plan'] as { parts: number } | undefined;
  const next = (state: JobState): string | null => {
    const plan = planned(state);
    if (!plan) return 'plan';
    for (let i = 1; i <= plan.parts; i += 1)
      if (!(`write_${i}` in state.outputs)) return `write_${i}`;
    return 'finish' in state.outputs ? null : 'finish';
  };
  return {
    parseInput: (_kind, input) => input as never,
    nextStep: (_kind, _input, state) => next(state),
    progress: (_kind, _input, state) => ({
      done: Object.keys(state.outputs),
      next: next(state),
      total: (planned(state)?.parts ?? 1) + 2,
    }),
    runStep: async ({ step }, deps) => {
      script.calls.push(step);
      // Both are taken when the call starts, so the first call of a step is the one that waits and fails.
      const hold = script.holds.get(step)?.shift();
      const failure = script.failures.get(step)?.shift();
      if (hold) await hold;
      if (failure) throw failure;

      if (step === 'plan') {
        const reply = await deps.llm.generate({
          task: 'authoring',
          label: 'test:plan',
          system: [{ text: 'rules', cache: true }],
          messages: [{ role: 'user', content: 'plan it' }],
          schema: PlanReply,
          schemaName: 'PlanReply',
          effort: 'low',
          maxTokens: 1000,
        });
        return outcome({ parts: reply.value.parts }, [usageOf('test:plan', reply)]);
      }
      if (step === 'finish') {
        return outcome({ done: true }, [], { plan: { chapters: [] }, flags: [] });
      }
      return outcome({ wrote: step });
    },
  };
}

/** The engine's per-kind result types do not matter to these tests, so the outcome is cast once, here. */
function outcome(output: Json, usage: UsageRecord[] = [], result?: unknown): never {
  return { output, usage, ...(result === undefined ? {} : { result }) } as never;
}

function usageOf(label: string, reply: LlmResult<unknown>): UsageRecord {
  return {
    label,
    task: 'authoring',
    model: reply.model,
    ...reply.usage,
    stop_reason: reply.stopReason,
    duration_ms: 0,
  };
}

function setup(overrides: Partial<InMemoryJobApiOptions> = {}, initial: { parts?: number } = {}) {
  const script: Script = { calls: [], failures: new Map(), holds: new Map() };
  const llm = new FakeLlm().on('test:plan', { parts: initial.parts ?? 1 });
  const clock = new TestClock();
  const api = createInMemoryJobApi({
    engine: createEngine(script),
    llm,
    resolveInput: async (_kind, params) => params as never,
    now: clock.now,
    ...overrides,
  });
  return { api, script, llm, clock };
}

const create = (api: ReturnType<typeof setup>['api']) =>
  api.create('chapter_plan', { scheme_id: SCHEME_ID });

const transient = (step: string) => new StepError(step, 'transport', 'blip', { retryable: true });

const PRICES: AiSettings['prices'] = {
  [DEFAULT_MODELS.authoring]: {
    input_per_mtok: 10,
    output_per_mtok: 50,
    cache_read_per_mtok: 1,
    cache_write_per_mtok: 12,
  },
};
const settingsWith = (patch: Partial<AiSettings>): (() => AiSettings) => {
  return () => ({ ...DEFAULT_AI_SETTINGS, ...patch });
};

afterEach(() => {
  vi.useRealTimers();
});

describe('create', () => {
  it('returns a queued row that satisfies the JobRow schema', async () => {
    const { api, clock } = setup();
    const job = await create(api);
    expect(() => JobRow.parse(job)).not.toThrow();
    expect(job).toMatchObject({
      kind: 'chapter_plan',
      status: 'queued',
      lease_until: null,
      attempts: 0,
      error: null,
      result: null,
      scheme_id: SCHEME_ID,
      unit_id: null,
      finished_at: null,
      created_at: clock.now().toISOString(),
    });
    expect(job.progress).toEqual({ done: [], next: 'plan', total: 3 });
  });

  it('links the unit or scheme a job is about', async () => {
    const { api } = setup({
      resolveInput: async (kind, params) =>
        (kind === 'unit_generate'
          ? { unit: { id: (params as Record<string, unknown>)['unit_id'] } }
          : params) as never,
    });
    const generate = await api.create('unit_generate', { unit_id: UNIT_ID });
    expect(generate).toMatchObject({ unit_id: UNIT_ID, scheme_id: null });
    const revise = await api.create('unit_revise', {
      unit_id: UNIT_ID,
      unit_version_id: SCHEME_ID,
    });
    expect(revise.unit_id).toBe(UNIT_ID);
    const ingest = await api.create('scheme_ingest', {});
    expect(ingest).toMatchObject({ unit_id: null, scheme_id: null });
  });

  it('returns the same job for the same idempotency key, even when created at once', async () => {
    const { api } = setup();
    const [a, b] = await Promise.all([
      api.create('chapter_plan', { scheme_id: SCHEME_ID }, 'key-one-123'),
      api.create('chapter_plan', { scheme_id: SCHEME_ID }, 'key-one-123'),
    ]);
    expect(a.id).toBe(b.id);
    const c = await api.create('chapter_plan', { scheme_id: SCHEME_ID }, 'key-two-456');
    const d = await api.create('chapter_plan', { scheme_id: SCHEME_ID });
    expect(new Set([a.id, c.id, d.id]).size).toBe(3);
    expect(api.jobs()).toHaveLength(3);
  });

  it('rejects an input that cannot be built with invalid_request', async () => {
    const { api } = setup({
      resolveInput: async () => {
        throw new Error('no such scheme');
      },
    });
    await expect(create(api)).rejects.toMatchObject({
      name: 'AiJobApiError',
      code: 'invalid_request',
    });
    expect(api.jobs()).toHaveLength(0);
  });

  it('rejects an unknown kind', async () => {
    const { api } = setup();
    await expect(api.create('nonsense' as never, {})).rejects.toMatchObject({
      code: 'invalid_request',
    });
  });
});

describe('step and the lease', () => {
  it('takes a lease of STEP_LEASE_SECONDS and answers before the step finishes', async () => {
    const { api, clock, script } = setup();
    const { id } = await create(api);
    const response = await api.step(id);

    expect(response.busy).toBeUndefined();
    expect(response.job.status).toBe('running');
    expect(response.job.lease_until).toBe(
      new Date(clock.t + STEP_LEASE_SECONDS * 1000).toISOString(),
    );
    expect(response.job.progress.done).toEqual([]);

    await settle();
    const after = await api.get(id);
    expect(script.calls).toEqual(['plan']);
    expect(after.lease_until).toBeNull();
    expect(after.progress).toEqual({ done: ['plan'], next: 'write_1', total: 3 });
    expect(after.status).toBe('running');
  });

  it('answers busy while a lease is held and does not run the step twice', async () => {
    const { api, script } = setup();
    const gate = deferred();
    script.holds.set('plan', [gate.promise]);
    const { id } = await create(api);

    await api.step(id);
    await settle();
    const second = await api.step(id);
    const third = await api.step(id);
    expect(second.busy).toBe(true);
    expect(third.busy).toBe(true);
    expect(script.calls).toEqual(['plan']);

    gate.release();
    await settle();
    expect((await api.get(id)).progress.done).toEqual(['plan']);
  });

  it('runs a whole job step by step and stores the engine result as it is', async () => {
    const { api, script } = setup({}, { parts: 2 });
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);

    expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'finish']);
    expect(done.status).toBe('succeeded');
    expect(done.result).toEqual({ plan: { chapters: [] }, flags: [] });
    expect(done.progress).toEqual({
      done: ['plan', 'write_1', 'write_2', 'finish'],
      next: null,
      total: 4,
    });
    expect(done.lease_until).toBeNull();
    expect(done.finished_at).not.toBeNull();
    expect(() => JobRow.parse(done)).not.toThrow();
  });

  it('does nothing for a finished job', async () => {
    const { api, script } = setup();
    const { id } = await create(api);
    await api.runStepsToCompletion(id);
    const calls = script.calls.length;
    const response = await api.step(id);
    expect(response.busy).toBeUndefined();
    expect(response.job.status).toBe('succeeded');
    expect(script.calls).toHaveLength(calls);
  });

  it('waits stepDelayMs before a step runs so a UI can show progress', async () => {
    vi.useFakeTimers();
    const { api, script } = setup({ stepDelayMs: 1000 });
    const { id } = await create(api);
    await api.step(id);
    await vi.advanceTimersByTimeAsync(999);
    expect(script.calls).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(script.calls).toEqual(['plan']);
  });

  it('rejects an unknown job with not_found', async () => {
    const { api } = setup();
    for (const call of [api.get('nope'), api.step('nope'), api.cancel('nope')]) {
      await expect(call).rejects.toMatchObject({ code: 'not_found' });
    }
  });

  it('hands the engine a copy of the state, not the stored one', async () => {
    const script: Script = { calls: [], failures: new Map(), holds: new Map() };
    const engine = createEngine(script);
    const { api } = setup({
      engine: {
        ...engine,
        runStep: async (call, deps) => {
          call.state.outputs['tamper'] = 1;
          return engine.runStep(call, deps);
        },
      },
    });
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);
    expect(done.progress.done).not.toContain('tamper');
  });
});

describe('failures and retries', () => {
  it('retries a retryable StepError and then succeeds, resetting attempts', async () => {
    const { api, script } = setup();
    script.failures.set('plan', [transient('plan'), transient('plan')]);
    const { id } = await create(api);

    await api.step(id);
    await settle();
    let row = await api.get(id);
    expect(row).toMatchObject({ status: 'running', attempts: 1, lease_until: null });
    expect(row.error).toMatchObject({ code: 'transport', step: 'plan', retryable: true });

    await api.step(id);
    await settle();
    row = await api.get(id);
    expect(row.attempts).toBe(2);

    const done = await api.runStepsToCompletion(id);
    expect(done.status).toBe('succeeded');
    expect(done.attempts).toBe(0);
    expect(done.error).toBeNull();
    expect(script.calls.filter((step) => step === 'plan')).toHaveLength(3);
  });

  it(`fails the job after ${MAX_STEP_ATTEMPTS} failed attempts of a step`, async () => {
    const { api, script } = setup();
    script.failures.set(
      'plan',
      Array.from({ length: 5 }, () => transient('plan')),
    );
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);
    expect(done).toMatchObject({ status: 'failed', attempts: MAX_STEP_ATTEMPTS });
    expect(done.error).toMatchObject({ code: 'transport', step: 'plan', retryable: false });
    expect(script.calls.filter((step) => step === 'plan')).toHaveLength(MAX_STEP_ATTEMPTS);
    expect(done.finished_at).not.toBeNull();
  });

  it('fails at once on a non-retryable StepError and keeps the finished steps', async () => {
    const { api, script } = setup();
    script.failures.set('write_1', [new StepError('write_1', 'schema', 'bad reply')]);
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);
    expect(done.status).toBe('failed');
    expect(done.attempts).toBe(1);
    expect(done.error).toEqual({
      code: 'schema',
      message: 'bad reply',
      step: 'write_1',
      retryable: false,
    });
    expect(done.progress.done).toEqual(['plan']);
    expect(script.calls).toEqual(['plan', 'write_1']);
  });

  it('maps an LlmError to the matching StepError, keeping its retryability', async () => {
    const refused = setup();
    refused.script.failures.set('plan', [new LlmError('refusal', 'declined')]);
    const a = await refused.api.runStepsToCompletion((await create(refused.api)).id);
    expect(a.error).toMatchObject({ code: 'refusal', retryable: false, step: 'plan' });

    const limited = setup();
    limited.script.failures.set('plan', [
      new LlmError('transport', 'rate limited', { retryAfterMs: 5000 }),
    ]);
    const b = await limited.api.runStepsToCompletion((await create(limited.api)).id);
    expect(b.status).toBe('succeeded');
  });

  it('fails a job whose step throws something unexpected, with an internal error', async () => {
    const { api, script } = setup();
    script.failures.set('plan', [new TypeError('boom')]);
    const done = await api.runStepsToCompletion((await create(api)).id);
    expect(done.error).toMatchObject({ code: 'internal', message: 'boom', retryable: false });
  });

  it('runs onSucceeded with the row, the engine result and the input, and stores what it returns', async () => {
    const seen: unknown[] = [];
    const { api } = setup({
      onSucceeded: async (job, result, input) => {
        seen.push(job.status, result, input);
        return { saved: true } as never;
      },
    });
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);
    expect(done.result).toEqual({ saved: true });
    expect(seen).toEqual([
      'running',
      { plan: { chapters: [] }, flags: [] },
      { scheme_id: SCHEME_ID },
    ]);
  });

  it('fails the job, keeping its steps, when onSucceeded throws; the error code can come from the throw', async () => {
    const { api } = setup({
      onSucceeded: () => {
        throw Object.assign(new Error('the unit changed'), { code: 'stale_base' });
      },
    });
    const done = await api.runStepsToCompletion((await create(api)).id);
    expect(done.status).toBe('failed');
    expect(done.error).toMatchObject({ code: 'stale_base', message: 'the unit changed' });
    expect(done.progress.done).toEqual(['plan', 'write_1', 'finish']);
    expect(done.result).toBeNull();
  });
});

describe('cancel', () => {
  it('cancels a job, aborts its step and ignores the step if it still finishes', async () => {
    const { api, script, llm } = setup();
    const gate = deferred();
    script.holds.set('plan', [gate.promise]);
    const { id } = await create(api);
    await api.step(id);
    await settle();

    const cancelled = await api.cancel(id);
    expect(cancelled).toMatchObject({ status: 'cancelled', lease_until: null });
    expect(cancelled.finished_at).not.toBeNull();

    gate.release();
    await settle();
    const row = await api.get(id);
    expect(row.status).toBe('cancelled');
    expect(row.progress.done).toEqual([]);
    // The tokens were still spent, so they are in the usage log.
    expect(api.usage()).toHaveLength(1);
    expect(llm.calls).toHaveLength(1);
  });

  it('passes an AbortSignal to the step that fires on cancel', async () => {
    const signals: AbortSignal[] = [];
    const { script } = setup();
    const engine = createEngine(script);
    const gate = deferred();
    const { api } = setup({
      engine: {
        ...engine,
        runStep: async (call, deps) => {
          if (deps.signal) signals.push(deps.signal);
          await gate.promise;
          return engine.runStep(call, deps);
        },
      },
    });
    const { id } = await create(api);
    await api.step(id);
    await settle();
    expect(signals[0]?.aborted).toBe(false);
    await api.cancel(id);
    expect(signals[0]?.aborted).toBe(true);
    gate.release();
  });

  it('leaves a finished job alone and refuses further steps', async () => {
    const { api } = setup();
    const { id } = await create(api);
    await api.runStepsToCompletion(id);
    expect((await api.cancel(id)).status).toBe('succeeded');
    const queued = await create(api);
    await api.cancel(queued.id);
    const response = await api.step(queued.id);
    expect(response.job.status).toBe('cancelled');
    expect(response.busy).toBeUndefined();
  });
});

describe('the kill switch', () => {
  it('rejects a step with code kill_switch and resumes when it is switched off', async () => {
    let kill = true;
    const { api, script } = setup({
      settings: () => ({ ...DEFAULT_AI_SETTINGS, kill_switch: kill }),
    });
    const { id } = await create(api);
    await expect(api.step(id)).rejects.toMatchObject({
      name: 'AiJobApiError',
      code: 'kill_switch',
    });
    expect(script.calls).toEqual([]);
    expect((await api.get(id)).status).toBe('queued');

    kill = false;
    expect((await api.runStepsToCompletion(id)).status).toBe('succeeded');
  });

  it('still lets a finished job be read and stepped as a no-op', async () => {
    let kill = false;
    const { api } = setup({ settings: () => ({ ...DEFAULT_AI_SETTINGS, kill_switch: kill }) });
    const { id } = await create(api);
    await api.runStepsToCompletion(id);
    kill = true;
    await expect(api.step(id)).resolves.toMatchObject({ job: { status: 'succeeded' } });
  });
});

describe('budgets', () => {
  /** One model call is $10: 1 000 000 input tokens at $10 per million. */
  const costly = { input_tokens: 1_000_000, output_tokens: 0 };

  it('stops a job at the per-job cap, using estimateCostUsd', async () => {
    const { api, llm, script } = setup({
      settings: settingsWith({
        prices: PRICES,
        budget: { max_usd_per_job: 5, daily_usd_cap: null },
      }),
    });
    llm.setUsage(costly);
    const { id } = await create(api);
    await api.step(id);
    await settle();
    expect(api.usage()).toHaveLength(1);

    await expect(api.step(id)).rejects.toMatchObject({ code: 'budget_exceeded' });
    expect(script.calls).toEqual(['plan']);
    expect((await api.get(id)).status).toBe('running');
  });

  it('does not count a call whose model has no price: its cost is unknown', async () => {
    const { api, llm } = setup({
      settings: settingsWith({
        prices: {},
        budget: { max_usd_per_job: 0.01, daily_usd_cap: 0.01 },
      }),
    });
    llm.setUsage(costly);
    const { id } = await create(api);
    const done = await api.runStepsToCompletion(id);
    expect(done.status).toBe('succeeded');
  });

  it('applies the daily cap across jobs and resets at the next UTC day', async () => {
    const { api, llm, clock } = setup({
      settings: settingsWith({
        prices: PRICES,
        budget: { max_usd_per_job: null, daily_usd_cap: 15 },
      }),
    });
    llm.setUsage(costly);
    const first = await create(api);
    await api.runStepsToCompletion(first.id);
    const second = await create(api);
    await api.step(second.id);
    await settle();
    // $20 spent today; the cap is $15.
    await expect(api.step(second.id)).rejects.toMatchObject({ code: 'budget_exceeded' });

    clock.advance(24 * 3600 * 1000);
    const resumed = await api.runStepsToCompletion(second.id);
    expect(resumed.status).toBe('succeeded');
  });

  it('reads the settings before every step', async () => {
    let settings: AiSettings = { ...DEFAULT_AI_SETTINGS, prices: PRICES };
    const { api, llm } = setup({ settings: () => settings });
    llm.setUsage(costly);
    const { id } = await create(api);
    await api.step(id);
    await settle();
    settings = { ...settings, budget: { max_usd_per_job: 1, daily_usd_cap: null } };
    await expect(api.step(id)).rejects.toMatchObject({ code: 'budget_exceeded' });
  });
});

describe('lease expiry and late finishers', () => {
  it('re-runs a step whose lease expired, and ignores the dead worker if it ever finishes', async () => {
    const { api, script, clock } = setup();
    const never = deferred();
    script.holds.set('plan', [never.promise]);
    const { id } = await create(api);

    await api.step(id);
    await settle();
    expect((await api.step(id)).busy).toBe(true);
    expect(script.calls).toEqual(['plan']);

    clock.advance(STEP_LEASE_SECONDS * 1000 + 1);
    const takeover = await api.step(id);
    expect(takeover.busy).toBeUndefined();
    await settle();
    expect(script.calls).toEqual(['plan', 'plan']);
    expect((await api.get(id)).progress.done).toEqual(['plan']);

    // The dead worker wakes up: its output must not overwrite the newer attempt's.
    never.release();
    await settle();
    const row = await api.get(id);
    expect(row.progress.done).toEqual(['plan']);
    expect(row.attempts).toBe(0);

    const done = await api.runStepsToCompletion(id);
    expect(done.status).toBe('succeeded');
    expect(script.calls.filter((step) => step === 'plan')).toHaveLength(2);
  });

  it('does not let a late failure from a dead worker fail the job', async () => {
    const { api, script, clock } = setup();
    const gate = deferred();
    script.holds.set('plan', [gate.promise]);
    script.failures.set('plan', [new StepError('plan', 'schema', 'late and wrong')]);
    const { id } = await create(api);
    await api.step(id);
    await settle();
    clock.advance(STEP_LEASE_SECONDS * 1000 + 1);
    await api.step(id);
    await settle();
    gate.release();
    await settle();
    const done = await api.runStepsToCompletion(id);
    expect(done.status).toBe('succeeded');
  });
});

describe('usage()', () => {
  it('lists the calls the steps reported, in order', async () => {
    const { api } = setup({}, { parts: 1 });
    await api.runStepsToCompletion((await create(api)).id);
    await api.runStepsToCompletion((await create(api)).id);
    const usage = api.usage();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({
      label: 'test:plan',
      task: 'authoring',
      model: DEFAULT_MODELS.authoring,
      input_tokens: 100,
      output_tokens: 50,
      stop_reason: 'end_turn',
    });
  });

  it('returns copies', async () => {
    const { api } = setup();
    await api.runStepsToCompletion((await create(api)).id);
    api.usage()[0]!.input_tokens = 999;
    expect(api.usage()[0]?.input_tokens).toBe(100);
  });
});

describe('rows are what a client would read', () => {
  it('returns copies that cannot change the stored job', async () => {
    const { api } = setup();
    const { id } = await create(api);
    const row = await api.get(id);
    row.status = 'failed';
    row.progress.done.push('x');
    expect((await api.get(id)).status).toBe('queued');
    expect((await api.get(id)).progress.done).toEqual([]);
  });

  it('exposes AiJobApiError with the protocol code', () => {
    const error = new AiJobApiError('kill_switch', 'off');
    expect(error.code).toBe('kill_switch');
    expect(error).toBeInstanceOf(Error);
  });
});
