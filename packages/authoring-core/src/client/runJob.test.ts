import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_AI_SETTINGS, StepError } from '../contract';
import type {
  AiJobResponse,
  JobApi,
  JobEngine,
  JobRow,
  JobState,
  Json,
  LlmResult,
  UsageRecord,
} from '../contract';
import { FakeLlm } from '../fakes/fakeLlm';
import { createInMemoryJobApi } from '../fakes/inMemoryJobApi';
import { AiJobApiError, JobAbortedError, JobStalledError } from './errors';
import { createJobAndRun, MIN_POLL_MS, runJob } from './runJob';
import type { RunJobOptions } from './runJob';

const SCHEME_ID = '11111111-1111-4111-8111-111111111111';
const PlanReply = z.object({ parts: z.number().int() });

class TestClock {
  t = Date.parse('2026-10-12T08:00:00.000Z');
  now = (): Date => new Date(this.t);
  advance(ms: number): void {
    this.t += ms;
  }
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function deferred(): { promise: Promise<void>; release: () => void } {
  let release: () => void = () => undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

interface Script {
  calls: string[];
  failures: Map<string, Error[]>;
  holds: Map<string, Promise<void>[]>;
}

/** The three-step engine: plan (the model says how many parts) -> write_1..write_n (dynamic) -> finish. */
function createEngine(script: Script): JobEngine {
  const planned = (state: JobState) => state.outputs['plan'] as { parts: number } | undefined;
  const next = (state: JobState): string | null => {
    const plan = planned(state);
    if (!plan) return 'plan';
    for (let i = 1; i <= plan.parts; i += 1)
      if (!(`write_${i}` in state.outputs)) return `write_${i}`;
    return 'finish' in state.outputs ? null : 'finish';
  };
  const outcome = (output: Json, usage: UsageRecord[] = [], result?: unknown): never =>
    ({ output, usage, ...(result === undefined ? {} : { result }) }) as never;
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
      const hold = script.holds.get(step)?.shift();
      const failure = script.failures.get(step)?.shift();
      if (hold) await hold;
      if (failure) throw failure;
      if (step === 'plan') {
        const reply: LlmResult<{ parts: number }> = await deps.llm.generate({
          task: 'authoring',
          label: 'test:plan',
          system: [{ text: 'rules' }],
          messages: [{ role: 'user', content: 'plan it' }],
          schema: PlanReply,
          schemaName: 'PlanReply',
          effort: 'low',
          maxTokens: 1000,
        });
        return outcome({ parts: reply.value.parts });
      }
      if (step === 'finish') {
        return outcome({ done: true }, [], { plan: { chapters: [] }, flags: [] });
      }
      return outcome({ wrote: step });
    },
  };
}

function setup(options: { parts?: number; settings?: () => typeof DEFAULT_AI_SETTINGS } = {}) {
  const script: Script = { calls: [], failures: new Map(), holds: new Map() };
  const clock = new TestClock();
  const api = createInMemoryJobApi({
    engine: createEngine(script),
    llm: new FakeLlm().on('test:plan', { parts: options.parts ?? 1 }),
    resolveInput: async (_kind, params) => params as never,
    now: clock.now,
    ...(options.settings ? { settings: options.settings } : {}),
  });

  const sleeps: number[] = [];
  /** Advances the virtual clock by the wait and lets background steps run, instead of waiting for real. */
  const run: RunJobOptions = {
    pollMs: 1000,
    now: () => clock.t,
    sleep: async (ms) => {
      sleeps.push(ms);
      clock.advance(ms);
      await settle();
    },
  };
  return { api, script, clock, sleeps, run };
}

const newJob = (api: JobApi) => api.create('chapter_plan', { scheme_id: SCHEME_ID });

/** Wraps a JobApi so a test can count calls or make them fail. */
function wrap(api: JobApi, overrides: Partial<JobApi>): JobApi {
  return {
    create: (...args) => api.create(...args),
    step: (...args) => api.step(...args),
    get: (...args) => api.get(...args),
    cancel: (...args) => api.cancel(...args),
    ...overrides,
  };
}

const transient = (step: string) => new StepError(step, 'transport', 'blip', { retryable: true });

function changeKey(job: JobRow): string {
  return JSON.stringify([job.status, job.progress, job.attempts, job.error]);
}

describe('runJob', () => {
  it('drives a job from queued to succeeded, one step at a time', async () => {
    const { api, script, run } = setup();
    const updates: JobRow[] = [];
    const { id } = await newJob(api);
    const final = await runJob(api, id, { ...run, onUpdate: (job) => updates.push(job) });

    expect(final.status).toBe('succeeded');
    expect(final.result).toEqual({ plan: { chapters: [] }, flags: [] });
    expect(script.calls).toEqual(['plan', 'write_1', 'finish']);

    expect(updates[0]?.status).toBe('queued');
    expect(updates[updates.length - 1]).toEqual(final);
    // Only real changes are reported: never two equal updates in a row, whatever the polling did.
    const keys = updates.map(changeKey);
    expect(keys.filter((key, i) => key === keys[i - 1])).toEqual([]);
    const doneCounts = updates.map((job) => job.progress.done.length);
    expect(doneCounts).toEqual([...doneCounts].sort((a, b) => a - b));
  });

  it('follows steps the engine adds as it goes (one write step per planned part)', async () => {
    const { api, script, run } = setup({ parts: 3 });
    const updates: JobRow[] = [];
    const { id } = await newJob(api);
    const final = await runJob(api, id, { ...run, onUpdate: (job) => updates.push(job) });

    expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'write_3', 'finish']);
    expect(final.progress).toEqual({
      done: ['plan', 'write_1', 'write_2', 'write_3', 'finish'],
      next: null,
      total: 5,
    });
    // The total was a guess until the plan step ran.
    expect(updates[0]?.progress.total).toBe(3);
    expect(updates.some((job) => job.progress.total === 5)).toBe(true);
  });

  it('returns immediately for a job that is already finished', async () => {
    const { api, script, run } = setup();
    const { id } = await newJob(api);
    await api.runStepsToCompletion(id);
    const calls = script.calls.length;
    const updates: JobRow[] = [];
    const final = await runJob(api, id, { ...run, onUpdate: (job) => updates.push(job) });
    expect(final.status).toBe('succeeded');
    expect(updates).toHaveLength(1);
    expect(script.calls).toHaveLength(calls);
  });

  describe('failures', () => {
    it('shows retries as they happen and finishes once the step recovers', async () => {
      const { api, script, run } = setup();
      script.failures.set('plan', [transient('plan'), transient('plan')]);
      const updates: JobRow[] = [];
      const { id } = await newJob(api);
      const final = await runJob(api, id, { ...run, onUpdate: (job) => updates.push(job) });

      expect(final.status).toBe('succeeded');
      expect(final.attempts).toBe(0);
      expect(final.error).toBeNull();
      expect(script.calls.filter((step) => step === 'plan')).toHaveLength(3);
      expect(updates.map((job) => job.attempts)).toContain(1);
      expect(updates.map((job) => job.attempts)).toContain(2);
      expect(updates.find((job) => job.attempts === 2)?.error).toMatchObject({
        code: 'transport',
        step: 'plan',
        retryable: true,
      });
    });

    it('resolves with the failed row when a step fails for good, keeping the finished steps', async () => {
      const { api, script, run } = setup();
      script.failures.set('write_1', [new StepError('write_1', 'schema', 'bad reply')]);
      const { id } = await newJob(api);
      const final = await runJob(api, id, run);
      expect(final.status).toBe('failed');
      expect(final.error).toMatchObject({ code: 'schema', step: 'write_1', retryable: false });
      expect(final.progress.done).toEqual(['plan']);
      expect(script.calls).toEqual(['plan', 'write_1']);
    });

    it('resolves with the failed row when a retryable step runs out of attempts', async () => {
      const { api, script, run } = setup();
      script.failures.set('plan', [
        transient('plan'),
        transient('plan'),
        transient('plan'),
        transient('plan'),
      ]);
      const { id } = await newJob(api);
      const final = await runJob(api, id, run);
      expect(final).toMatchObject({ status: 'failed', attempts: 3 });
    });

    it('returns the row of a job someone else cancelled', async () => {
      const { api, script, run } = setup();
      const gate = deferred();
      script.holds.set('plan', [gate.promise]);
      const { id } = await newJob(api);
      const running = runJob(api, id, {
        ...run,
        onUpdate: (job) => {
          if (job.status === 'running') void api.cancel(id);
        },
      });
      const final = await running;
      expect(final.status).toBe('cancelled');
      gate.release();
    });
  });

  describe('abort and resume', () => {
    it('stops without cancelling the job, and a later runJob resumes it without repeating a step', async () => {
      const { api, script, run } = setup({ parts: 2 });
      const controller = new AbortController();
      const { id } = await newJob(api);

      // "The tab is closed" after the plan step has finished.
      const first = runJob(api, id, {
        ...run,
        signal: controller.signal,
        onUpdate: (job) => {
          if (job.progress.done.includes('plan')) controller.abort();
        },
      });
      await expect(first).rejects.toBeInstanceOf(JobAbortedError);
      await expect(first).rejects.toMatchObject({ name: 'AbortError' });

      const midway = await api.get(id);
      expect(midway.status).not.toBe('cancelled');
      expect(midway.status).not.toBe('succeeded');

      // "The tab is opened again."
      const final = await runJob(api, id, run);
      expect(final.status).toBe('succeeded');
      expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'finish']);
    });

    it('resumes a job whose first steps were run by someone else', async () => {
      const { api, script, run } = setup({ parts: 2 });
      const { id } = await newJob(api);
      await api.step(id);
      await settle();
      await api.step(id);
      await settle();
      expect((await api.get(id)).progress.done).toEqual(['plan', 'write_1']);

      const final = await runJob(api, id, run);
      expect(final.status).toBe('succeeded');
      expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'finish']);
    });

    it('rejects at once when the signal is already aborted, without touching the API', async () => {
      const { api, run } = setup();
      const { id } = await newJob(api);
      let touched = 0;
      const spy = wrap(api, {
        get: async (...args) => {
          touched += 1;
          return api.get(...args);
        },
      });
      const controller = new AbortController();
      controller.abort();
      await expect(runJob(spy, id, { ...run, signal: controller.signal })).rejects.toBeInstanceOf(
        JobAbortedError,
      );
      expect(touched).toBe(0);
    });

    it('stops promptly even when the wait never ends', async () => {
      const { api, run } = setup();
      const { id } = await newJob(api);
      const controller = new AbortController();
      const stuck = runJob(api, id, {
        ...run,
        signal: controller.signal,
        sleep: () => new Promise<void>(() => undefined),
      });
      await settle();
      controller.abort();
      await expect(stuck).rejects.toBeInstanceOf(JobAbortedError);
    });

    it('stops promptly with the real timer too', async () => {
      const { api } = setup();
      const { id } = await newJob(api);
      const controller = new AbortController();
      const watching = runJob(api, id, { pollMs: 60_000, signal: controller.signal });
      await settle();
      controller.abort();
      await expect(watching).rejects.toBeInstanceOf(JobAbortedError);
    });
  });

  describe('two loops on one job', () => {
    it('run every step exactly once', async () => {
      const { api, script, run } = setup({ parts: 2 });
      const { id } = await newJob(api);
      const [a, b] = await Promise.all([runJob(api, id, run), runJob(api, id, run)]);
      expect(a.status).toBe('succeeded');
      expect(b.status).toBe('succeeded');
      expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'finish']);
    });

    it('also holds when one loop joins late', async () => {
      const { api, script, run } = setup({ parts: 2 });
      const { id } = await newJob(api);
      const first = runJob(api, id, run);
      await settle();
      const second = runJob(api, id, run);
      await Promise.all([first, second]);
      expect(script.calls).toEqual(['plan', 'write_1', 'write_2', 'finish']);
    });
  });

  describe('waiting', () => {
    it('does not ask for another step while one is running', async () => {
      const { api, script, sleeps } = setup();
      const gate = deferred();
      script.holds.set('plan', [gate.promise]);
      const { id } = await newJob(api);
      let stepRequests = 0;
      const counted = wrap(api, {
        step: async (...args) => {
          stepRequests += 1;
          return api.step(...args);
        },
      });

      let requestsWhileHeld = -1;
      const final = await runJob(counted, id, {
        pollMs: 1000,
        // The clock stays put, so the lease cannot expire while we wait.
        now: () => Date.parse('2026-10-12T08:00:00.000Z'),
        sleep: async (ms) => {
          sleeps.push(ms);
          if (sleeps.length === 6) {
            requestsWhileHeld = stepRequests;
            gate.release();
          }
          await settle();
        },
      });
      expect(final.status).toBe('succeeded');
      expect(requestsWhileHeld).toBe(1);
      expect(script.calls.filter((step) => step === 'plan')).toHaveLength(1);
    });

    it('never polls faster than the floor, however pollMs is set', async () => {
      const { api, run, sleeps } = setup();
      const { id } = await newJob(api);
      await runJob(api, id, { ...run, pollMs: 0 });
      expect(sleeps.length).toBeGreaterThan(0);
      expect(Math.min(...sleeps)).toBeGreaterThanOrEqual(MIN_POLL_MS);
    });

    it('takes over a step whose worker died, once the lease has expired', async () => {
      const { api, script, run } = setup();
      const never = deferred();
      script.holds.set('plan', [never.promise]);
      const { id } = await newJob(api);

      // Each wait advances the virtual clock a minute, so the 150 s lease runs out after three polls.
      const final = await runJob(api, id, { ...run, pollMs: 60_000 });
      expect(final.status).toBe('succeeded');
      expect(script.calls).toEqual(['plan', 'plan', 'write_1', 'finish']);

      never.release();
      await settle();
      expect((await api.get(id)).progress.done).toEqual(['plan', 'write_1', 'finish']);
    });
  });

  describe('API errors', () => {
    it('retries a failing get or step with exponential backoff, then carries on', async () => {
      const { api, run, sleeps } = setup();
      const { id } = await newJob(api);
      let getFailures = 2;
      let stepFailures = 1;
      const flaky = wrap(api, {
        get: async (...args) => {
          if (getFailures-- > 0) throw new TypeError('network down');
          return api.get(...args);
        },
        step: async (...args) => {
          if (stepFailures-- > 0) throw new Error('502 bad gateway');
          return api.step(...args);
        },
      });
      const final = await runJob(flaky, id, run);
      expect(final.status).toBe('succeeded');
      // Backoff waits (500, 1000 for the get; 500 for the step) come before any normal poll wait.
      expect(sleeps.slice(0, 2)).toEqual([500, 1000]);
      expect(sleeps).toContain(500);
    });

    it('caps the backoff and gives up after maxApiRetries, rethrowing the last error', async () => {
      const { api, run, sleeps } = setup();
      const { id } = await newJob(api);
      const down = new TypeError('network down');
      const broken = wrap(api, { get: async () => Promise.reject(down) });
      await expect(
        runJob(broken, id, { ...run, maxApiRetries: 3, retryBaseMs: 20_000 }),
      ).rejects.toBe(down);
      expect(sleeps).toEqual([20_000, 30_000, 30_000]);
    });

    it('does not retry a rejection that asking again cannot change', async () => {
      const { api, run, sleeps } = setup();
      const { id } = await newJob(api);
      const forbidden = new AiJobApiError('forbidden', 'not content staff');
      const denied = wrap(api, { step: async () => Promise.reject(forbidden) });
      await expect(runJob(denied, id, run)).rejects.toBe(forbidden);
      expect(sleeps).toEqual([]);
    });

    it('surfaces the kill switch from the in-memory API as a permanent error', async () => {
      const { api, run, sleeps } = setup({
        settings: () => ({ ...DEFAULT_AI_SETTINGS, kill_switch: true }),
      });
      const { id } = await newJob(api);
      await expect(runJob(api, id, run)).rejects.toMatchObject({ code: 'kill_switch' });
      expect(sleeps).toEqual([]);
    });

    it('retries a transient error from a stepping API that later recovers', async () => {
      const { api, run } = setup();
      const { id } = await newJob(api);
      let failOnce = true;
      const flaky = wrap(api, {
        step: async (...args) => {
          if (failOnce) {
            failOnce = false;
            throw new AiJobApiError('internal', 'edge function crashed');
          }
          return api.step(...args);
        },
      });
      expect((await runJob(flaky, id, run)).status).toBe('succeeded');
    });
  });

  describe('a job that never advances', () => {
    it('gives up with JobStalledError after maxIdlePolls step requests that changed nothing', async () => {
      const { api, run } = setup();
      const { id } = await newJob(api);
      let stepRequests = 0;
      const inert = wrap(api, {
        // Claims to start a step but never does.
        step: async (): Promise<AiJobResponse> => {
          stepRequests += 1;
          return { job: await api.get(id) };
        },
      });
      await expect(runJob(inert, id, { ...run, maxIdlePolls: 3 })).rejects.toBeInstanceOf(
        JobStalledError,
      );
      expect(stepRequests).toBe(4);
    });

    it('does not count requests that were answered busy', async () => {
      const { api, run } = setup();
      const { id } = await newJob(api);
      let busy = 10;
      const contended = wrap(api, {
        step: async (...args) => {
          if (busy-- > 0) return { job: await api.get(id), busy: true };
          return api.step(...args);
        },
      });
      const final = await runJob(contended, id, { ...run, maxIdlePolls: 2 });
      expect(final.status).toBe('succeeded');
    });

    it('does not mistake a long step for a stall', async () => {
      const { api, script, run } = setup();
      const gate = deferred();
      script.holds.set('plan', [gate.promise]);
      const { id } = await newJob(api);
      let waits = 0;
      const final = await runJob(api, id, {
        ...run,
        pollMs: 100,
        maxIdlePolls: 2,
        sleep: async () => {
          waits += 1;
          if (waits === 40) gate.release();
          await settle();
        },
        now: () => Date.parse('2026-10-12T08:00:00.000Z'),
      });
      expect(final.status).toBe('succeeded');
      expect(waits).toBeGreaterThan(40);
    });
  });
});

describe('createJobAndRun', () => {
  it('creates the job, reports it before any step has run, and drives it to the end', async () => {
    const { api, script, run } = setup();
    const created: JobRow[] = [];
    const callsAtCreation: number[] = [];
    const final = await createJobAndRun(
      api,
      'chapter_plan',
      { scheme_id: SCHEME_ID },
      {
        ...run,
        onCreated: (job) => {
          created.push(job);
          callsAtCreation.push(script.calls.length);
        },
      },
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.status).toBe('queued');
    expect(callsAtCreation).toEqual([0]);
    expect(final.id).toBe(created[0]?.id);
    expect(final.status).toBe('succeeded');
  });

  it('does not run a job twice for the same idempotency key', async () => {
    const { api, script, run } = setup();
    const params = { scheme_id: SCHEME_ID };
    const one = await createJobAndRun(api, 'chapter_plan', params, {
      ...run,
      idempotencyKey: 'click-1234',
    });
    const two = await createJobAndRun(api, 'chapter_plan', params, {
      ...run,
      idempotencyKey: 'click-1234',
    });
    expect(two.id).toBe(one.id);
    expect(script.calls).toEqual(['plan', 'write_1', 'finish']);
    expect(api.jobs()).toHaveLength(1);
  });

  it('retries a failing create only when an idempotency key makes that safe', async () => {
    const { api, run } = setup();
    let failures = 1;
    const flaky = wrap(api, {
      create: async (...args) => {
        if (failures-- > 0) throw new TypeError('network down');
        return api.create(...args);
      },
    });
    const params = { scheme_id: SCHEME_ID };
    await expect(createJobAndRun(flaky, 'chapter_plan', params, run)).rejects.toThrow(
      'network down',
    );

    failures = 1;
    const final = await createJobAndRun(flaky, 'chapter_plan', params, {
      ...run,
      idempotencyKey: 'click-5678',
    });
    expect(final.status).toBe('succeeded');
  });
});
