// Drives one job from a screen. Pure TypeScript (no React), so it is unit tested with a fake JobApi.
//
// Rules from ADR 0007:
//  - The browser tab drives the job: `runJob` keeps asking the server for the next step until it is finished.
//  - Leaving the screen stops WATCHING (the loop is aborted); it never cancels the job. Coming back with the
//    job id resumes it. Only `cancel()` cancels, and only because a person pressed the button.
import {
  createJobAndRun,
  runJob,
  type CreateJobAndRunOptions,
  type JobApi,
  type JobKind,
  type JobParams,
  type JobRow,
  type RunJobOptions,
} from '@custar/authoring-core';
import { toAdminError, type AdminApiError } from '../api/errors';

export interface JobControllerState {
  job: JobRow | null;
  /** This screen's loop is driving the job right now. */
  driving: boolean;
  /** A failure of the API or of the loop itself (not the job's own `error`, which is in `job.error`). */
  error: AdminApiError | null;
}

export interface JobDriver {
  runJob: (api: JobApi, jobId: string, options?: RunJobOptions) => Promise<JobRow>;
  createJobAndRun: <K extends JobKind>(
    api: JobApi,
    kind: K,
    params: JobParams[K],
    options?: CreateJobAndRunOptions,
  ) => Promise<JobRow>;
}

export const DEFAULT_DRIVER: JobDriver = { runJob, createJobAndRun };

export interface JobControllerOptions {
  api: JobApi;
  pollMs: number;
  driver?: JobDriver;
  /** Replaces the real timer (tests). */
  sleep?: (ms: number) => Promise<void>;
  /** Called with the new job as soon as it exists, before it finishes. */
  onCreated?: (job: JobRow) => void;
  /** Called once when a job this controller drove reaches a terminal status. */
  onFinished?: (job: JobRow) => void;
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

export class JobController {
  private current: JobControllerState = { job: null, driving: false, error: null };
  private readonly listeners = new Set<(state: JobControllerState) => void>();
  private abort: AbortController | null = null;
  private disposed = false;
  private readonly driver: JobDriver;

  constructor(private options: JobControllerOptions) {
    this.driver = options.driver ?? DEFAULT_DRIVER;
  }

  get state(): JobControllerState {
    return this.current;
  }

  /** Lets a screen swap the callbacks without recreating the controller. */
  configure(options: Partial<Pick<JobControllerOptions, 'onCreated' | 'onFinished'>>): void {
    this.options = { ...this.options, ...options };
  }

  subscribe(listener: (state: JobControllerState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(patch: Partial<JobControllerState>): void {
    if (this.disposed) return;
    this.current = { ...this.current, ...patch };
    this.listeners.forEach((listener) => listener(this.current));
  }

  private runOptions(controller: AbortController): RunJobOptions {
    return {
      pollMs: this.options.pollMs,
      signal: controller.signal,
      ...(this.options.sleep ? { sleep: this.options.sleep } : {}),
      onUpdate: (row) => {
        if (!controller.signal.aborted) this.set({ job: row });
      },
    };
  }

  private begin(): AbortController {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.set({ driving: true, error: null });
    return controller;
  }

  private async settle(
    controller: AbortController,
    work: () => Promise<JobRow>,
  ): Promise<JobRow | undefined> {
    try {
      const final = await work();
      if (!controller.signal.aborted) {
        this.set({ job: final });
        this.options.onFinished?.(final);
      }
      return final;
    } catch (cause) {
      if (isAbort(cause) || controller.signal.aborted) return undefined;
      this.set({ error: toAdminError(cause) });
      return undefined;
    } finally {
      if (this.abort === controller) {
        this.abort = null;
        this.set({ driving: false });
      }
    }
  }

  /** Creates the job and drives it to the end. Resolves with the final row, or undefined if it could not finish. */
  async start<K extends JobKind>(
    kind: K,
    params: JobParams[K],
    idempotencyKey?: string,
  ): Promise<JobRow | undefined> {
    const controller = this.begin();
    this.set({ job: null });
    return this.settle(controller, () =>
      this.driver.createJobAndRun(this.options.api, kind, params, {
        ...this.runOptions(controller),
        ...(idempotencyKey ? { idempotencyKey } : {}),
        onCreated: (row) => {
          if (controller.signal.aborted) return;
          this.set({ job: row });
          this.options.onCreated?.(row);
        },
      }),
    );
  }

  /** Continues a job that was started earlier (another tab, an earlier visit, or a stalled loop). */
  async resume(jobId: string): Promise<JobRow | undefined> {
    const controller = this.begin();
    return this.settle(controller, () =>
      this.driver.runJob(this.options.api, jobId, this.runOptions(controller)),
    );
  }

  /** Stops watching without touching the job. Safe to call when nothing is running. */
  stopWatching(): void {
    this.abort?.abort();
    this.abort = null;
    if (!this.disposed && this.current.driving) this.set({ driving: false });
  }

  /** The "Cancel job" button: asks the server to cancel, then stops watching. */
  async cancel(): Promise<void> {
    const job = this.current.job;
    if (!job) return;
    this.abort?.abort();
    this.abort = null;
    try {
      const row = await this.options.api.cancel(job.id);
      this.set({ job: row, driving: false, error: null });
    } catch (cause) {
      this.set({ driving: false, error: toAdminError(cause) });
    }
  }

  /** Forget the job (to start another). Does not cancel anything. */
  reset(): void {
    this.stopWatching();
    this.set({ job: null, error: null, driving: false });
  }

  /** (Re)attaches after a `dispose()`, for example when React runs an effect twice in development. */
  attach(): void {
    this.disposed = false;
  }

  /** The screen is gone: stop watching. The job keeps running on the server and can be resumed. */
  dispose(): void {
    this.abort?.abort();
    this.abort = null;
    this.disposed = true;
    this.listeners.clear();
  }
}
