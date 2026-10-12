import { describe, expect, it, vi } from 'vitest';
import type { AiJobResponse, JobApi, JobRow } from '@custar/authoring-core';
import { AdminApiError } from '../api/errors';
import { JobController } from './JobController';

const JOB_ID = '44444444-4444-4444-8444-444444444444';
const UNIT_ID = '22222222-2222-4222-8222-222222222222';

/** A scripted job API: every step() finishes one more step of `total`. */
function scriptedApi(total: number, options: { failCreate?: Error; failStepAt?: number } = {}) {
  const done: string[] = [];
  let status: JobRow['status'] = 'queued';
  const row = (): JobRow => ({
    id: JOB_ID,
    kind: 'unit_generate',
    status,
    progress: { done: [...done], next: done.length < total ? `s${done.length + 1}` : null, total },
    lease_until: null,
    attempts: 0,
    error: null,
    result: status === 'succeeded' ? { ok: true } : null,
    unit_id: UNIT_ID,
    scheme_id: null,
    created_by: null,
    created_at: '2026-10-12T10:00:00Z',
    updated_at: '2026-10-12T10:00:00Z',
    finished_at: status === 'succeeded' ? '2026-10-12T10:01:00Z' : null,
  });
  const api = {
    create: vi.fn(async (..._args: unknown[]) => {
      if (options.failCreate) throw options.failCreate;
      return row();
    }),
    step: vi.fn(async (_jobId: string): Promise<AiJobResponse> => {
      if (options.failStepAt !== undefined && done.length === options.failStepAt) {
        throw new AdminApiError('forbidden', 'forbidden', 'Not allowed', 403);
      }
      if (status === 'cancelled') return { job: row() };
      done.push(`s${done.length + 1}`);
      status = done.length >= total ? 'succeeded' : 'running';
      return { job: row() };
    }),
    get: vi.fn(async (_jobId: string) => row()),
    cancel: vi.fn(async (_jobId: string) => {
      status = 'cancelled';
      return row();
    }),
  };
  return api satisfies JobApi;
}

const instant = async () => undefined;
const never = () => new Promise<void>(() => undefined);

describe('JobController', () => {
  it('creates a job and drives it to the end, reporting each change', async () => {
    const api = scriptedApi(3);
    const created: string[] = [];
    const finished: string[] = [];
    const controller = new JobController({
      api,
      pollMs: 1,
      sleep: instant,
      onCreated: (job) => created.push(job.id),
      onFinished: (job) => finished.push(job.status),
    });
    const seen: string[] = [];
    controller.subscribe((state) =>
      seen.push(`${state.driving ? 'driving' : 'idle'}:${state.job?.status ?? '-'}`),
    );

    const final = await controller.start('unit_generate', { unit_id: UNIT_ID }, 'idem-12345');

    expect(final?.status).toBe('succeeded');
    expect(api.create).toHaveBeenCalledWith('unit_generate', { unit_id: UNIT_ID }, 'idem-12345');
    expect(created).toEqual([JOB_ID]);
    expect(finished).toEqual(['succeeded']);
    expect(controller.state).toMatchObject({ driving: false, error: null });
    expect(controller.state.job?.progress.done).toEqual(['s1', 's2', 's3']);
    expect(seen).toContain('driving:queued');
    expect(seen).toContain('driving:running');
    expect(seen[seen.length - 1]).toBe('idle:succeeded');
  });

  it('leaving the screen does not cancel the job; coming back resumes it', async () => {
    const api = scriptedApi(3);
    const first = new JobController({ api, pollMs: 1, sleep: never });
    const running = first.start('unit_generate', { unit_id: UNIT_ID });
    await vi.waitFor(() => expect(first.state.job?.progress.done).toEqual(['s1']));

    first.dispose(); // the screen unmounts
    await running;
    expect(api.cancel).not.toHaveBeenCalled();
    expect((await api.get(JOB_ID)).status).toBe('running');

    const second = new JobController({ api, pollMs: 1, sleep: instant });
    const final = await second.resume(JOB_ID);
    expect(final?.status).toBe('succeeded');
    expect(second.state.job?.progress.done).toEqual(['s1', 's2', 's3']);
    expect(api.create).toHaveBeenCalledTimes(1);
  });

  it('stopWatching aborts the loop quietly, without an error and without cancelling', async () => {
    const api = scriptedApi(3);
    const controller = new JobController({ api, pollMs: 1, sleep: never });
    const running = controller.start('unit_generate', { unit_id: UNIT_ID });
    await vi.waitFor(() => expect(controller.state.job?.progress.done).toEqual(['s1']));
    controller.stopWatching();
    await running;
    expect(controller.state.error).toBeNull();
    expect(controller.state.driving).toBe(false);
    expect(controller.state.job?.status).toBe('running');
    expect(api.cancel).not.toHaveBeenCalled();
  });

  it('cancel asks the server to cancel and stops the loop', async () => {
    const api = scriptedApi(5);
    const controller = new JobController({ api, pollMs: 1, sleep: never });
    const running = controller.start('unit_generate', { unit_id: UNIT_ID });
    await vi.waitFor(() => expect(controller.state.job?.progress.done.length).toBe(1));
    await controller.cancel();
    await running;
    expect(api.cancel).toHaveBeenCalledWith(JOB_ID);
    expect(controller.state.job?.status).toBe('cancelled');
    expect(controller.state.driving).toBe(false);
  });

  it('surfaces a permanent API error as a typed error and does not keep retrying', async () => {
    const api = scriptedApi(3, { failStepAt: 1 });
    const controller = new JobController({ api, pollMs: 1, sleep: instant });
    const final = await controller.start('unit_generate', { unit_id: UNIT_ID });
    expect(final).toBeUndefined();
    expect(controller.state.error).toMatchObject({ kind: 'forbidden', code: 'forbidden' });
    expect(controller.state.driving).toBe(false);
    expect(controller.state.job?.progress.done).toEqual(['s1']);
    expect(api.step).toHaveBeenCalledTimes(2);
  });

  it('reports a failed create without a job', async () => {
    const error = new AdminApiError(
      'kill_switch',
      'kill_switch',
      'AI drafting is switched off.',
      503,
    );
    const api = scriptedApi(3, { failCreate: error });
    const controller = new JobController({ api, pollMs: 1, sleep: instant });
    expect(await controller.start('unit_generate', { unit_id: UNIT_ID })).toBeUndefined();
    expect(controller.state.job).toBeNull();
    expect(controller.state.error).toMatchObject({ kind: 'kill_switch' });
  });

  it('can be attached again after a dispose (an effect that runs twice)', async () => {
    const api = scriptedApi(2);
    const controller = new JobController({ api, pollMs: 1, sleep: instant });
    controller.dispose();
    controller.attach();
    const final = await controller.start('unit_generate', { unit_id: UNIT_ID });
    expect(final?.status).toBe('succeeded');
    expect(controller.state.job?.status).toBe('succeeded');
  });

  it('reset forgets the job without cancelling it', async () => {
    const api = scriptedApi(1);
    const controller = new JobController({ api, pollMs: 1, sleep: instant });
    await controller.start('unit_generate', { unit_id: UNIT_ID });
    controller.reset();
    expect(controller.state).toEqual({ job: null, driving: false, error: null });
    expect(api.cancel).not.toHaveBeenCalled();
  });
});
