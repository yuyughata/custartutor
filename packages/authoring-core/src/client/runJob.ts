// Drives a job from the client: the loop of ADR 0007. The server only ever runs one step per `step` request,
// so a browser tab (or this function in a Node script) keeps calling it until the job is finished.
//
//   get -> finished? return.  Lease held (a step is running)? wait.  Otherwise ask for the next step.
//
// Closing the tab pauses the job; calling `runJob` again on the same id resumes it. Two loops on one job are
// safe because the server hands out the lease to one `step` request at a time (the other gets `busy`).
import type { JobApi, JobKind, JobParams, JobRow } from '../contract';
import { isPermanentJobApiError, JobAbortedError, JobStalledError } from './errors';

export const DEFAULT_POLL_MS = 1500;
/** A floor, so a bad option can never turn the wait into a busy loop. */
export const MIN_POLL_MS = 50;
export const DEFAULT_MAX_IDLE_POLLS = 8;
export const DEFAULT_MAX_API_RETRIES = 4;
export const DEFAULT_RETRY_BASE_MS = 500;
const MAX_RETRY_WAIT_MS = 30_000;

export interface RunJobOptions {
  /** Wait between polls while a step is running. Default 1500, never below 50. */
  pollMs?: number;
  /** Stops the loop with `JobAbortedError`. The job is NOT cancelled (use `api.cancel`). */
  signal?: AbortSignal;
  /** Called with the first row seen and again whenever status, progress, attempts or the error change. */
  onUpdate?: (job: JobRow) => void;
  /** Replaces the real timer (tests, fake clocks). */
  sleep?: (ms: number) => Promise<void>;
  /**
   * Gives up with `JobStalledError` after this many consecutive step requests that changed nothing: a worker
   * that keeps dying leaves the lease to expire without recording an error. Default 8.
   */
  maxIdlePolls?: number;
  /** Milliseconds since the epoch, to compare with `lease_until`. Default `Date.now`. */
  now?: () => number;
  /** A failed `get`/`step` is retried this many times with exponential backoff, then rethrown. Default 4. */
  maxApiRetries?: number;
  /** First backoff wait; doubles each retry up to 30 s. Default 500. */
  retryBaseMs?: number;
}

export interface CreateJobAndRunOptions extends RunJobOptions {
  /** With a key, a repeated `create` returns the same job, so it is also retried on transient errors. */
  idempotencyKey?: string;
  /** Called once with the new row, before the loop starts: persist the id so a closed tab can resume. */
  onCreated?: (job: JobRow) => void;
}

export function isTerminal(job: Pick<JobRow, 'status'>): boolean {
  return job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled';
}

export async function runJob(
  api: JobApi,
  jobId: string,
  options: RunJobOptions = {},
): Promise<JobRow> {
  const pollMs = Math.max(options.pollMs ?? DEFAULT_POLL_MS, MIN_POLL_MS);
  const maxIdle = options.maxIdlePolls ?? DEFAULT_MAX_IDLE_POLLS;
  const now = options.now ?? Date.now;
  const waiter = makeWaiter(options);

  let notifiedKey: string | undefined;
  let progressKey: string | undefined;
  let idleSteps = 0;
  const notify = (job: JobRow): void => {
    const key = changeKey(job);
    if (key === notifiedKey) return;
    notifiedKey = key;
    options.onUpdate?.(job);
  };

  for (;;) {
    waiter.throwIfAborted();
    const job = await waiter.withRetry(() => api.get(jobId), options);
    notify(job);
    if (isTerminal(job)) return job;

    // Progress is anything the job's own state records; the lease alone is not progress.
    const key = changeKey(job);
    if (key !== progressKey) {
      progressKey = key;
      idleSteps = 0;
    }

    if (leaseHeld(job, now)) {
      await waiter.sleep(pollMs);
      continue;
    }

    const response = await waiter.withRetry(() => api.step(jobId), options);
    notify(response.job);
    if (isTerminal(response.job)) return response.job;
    if (response.busy !== true) {
      idleSteps += 1;
      if (idleSteps > maxIdle) throw new JobStalledError(jobId, idleSteps - 1);
    }
    await waiter.sleep(pollMs);
  }
}

/** Creates the job and drives it to the end. `onCreated` hands out the id as soon as it exists. */
export async function createJobAndRun<K extends JobKind>(
  api: JobApi,
  kind: K,
  params: JobParams[K],
  options: CreateJobAndRunOptions = {},
): Promise<JobRow> {
  const waiter = makeWaiter(options);
  const create = () => api.create(kind, params, options.idempotencyKey);
  // Without a key a retried create could make a second job, so it is attempted once.
  const job =
    options.idempotencyKey === undefined ? await create() : await waiter.withRetry(create, options);
  options.onCreated?.(job);
  return runJob(api, job.id, options);
}

function leaseHeld(job: JobRow, now: () => number): boolean {
  if (job.lease_until === null) return false;
  const until = Date.parse(job.lease_until);
  return !Number.isNaN(until) && until > now();
}

/** Everything about a job a UI would redraw for, except the lease timestamp that changes on every step. */
function changeKey(job: JobRow): string {
  return JSON.stringify([
    job.status,
    job.progress.done,
    job.progress.next,
    job.progress.total,
    job.attempts,
    job.error,
  ]);
}

interface Waiter {
  sleep(ms: number): Promise<void>;
  throwIfAborted(): void;
  withRetry<T>(
    call: () => Promise<T>,
    options: Pick<RunJobOptions, 'maxApiRetries' | 'retryBaseMs'>,
  ): Promise<T>;
}

function makeWaiter(options: Pick<RunJobOptions, 'signal' | 'sleep'>): Waiter {
  const { signal } = options;

  const throwIfAborted = (): void => {
    if (signal?.aborted) throw new JobAbortedError();
  };

  /** Resolves `promise`, or rejects at once if the signal fires first (the underlying call is left to finish). */
  const abortable = <T>(promise: Promise<T>): Promise<T> => {
    if (!signal) return promise;
    return new Promise<T>((resolve, reject) => {
      const onAbort = () => reject(new JobAbortedError());
      signal.addEventListener('abort', onAbort, { once: true });
      promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
  };

  const sleep = (ms: number): Promise<void> => {
    throwIfAborted();
    if (options.sleep) return abortable(options.sleep(ms));
    return new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        clearTimeout(timer);
        reject(new JobAbortedError());
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });
  };

  const withRetry = async <T>(
    call: () => Promise<T>,
    retry: Pick<RunJobOptions, 'maxApiRetries' | 'retryBaseMs'>,
  ): Promise<T> => {
    const maxRetries = retry.maxApiRetries ?? DEFAULT_MAX_API_RETRIES;
    const base = retry.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    for (let attempt = 0; ; attempt += 1) {
      throwIfAborted();
      try {
        return await abortable(call());
      } catch (error) {
        if (error instanceof JobAbortedError) throw error;
        if (isPermanentJobApiError(error) || attempt >= maxRetries) throw error;
        await sleep(Math.min(base * 2 ** attempt, MAX_RETRY_WAIT_MS));
      }
    }
  };

  return { sleep, throwIfAborted, withRetry };
}
