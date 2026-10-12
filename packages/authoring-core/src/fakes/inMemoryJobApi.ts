// The `ai-job` protocol (ADR 0007) in memory, with the real semantics: leases, retries, cancellation, the kill
// switch and the budget caps. It runs the injected `JobEngine` with the injected `LlmClient`, so the admin app's
// demo mode and the tests exercise the real step engine against a fake model. Platform-neutral: no Node
// built-ins (timers are the only globals used).
//
// A step started by `step()` runs in the background; `step()` itself returns at once with the row as it is while
// the lease is held, like the edge function's `202`. Callers poll `get()` (that is what `runJob` does) or, in
// tests, call `runStepsToCompletion()`.
import {
  DEFAULT_AI_SETTINGS,
  JobKind as JobKindSchema,
  JobRow as JobRowSchema,
  LlmError,
  MAX_STEP_ATTEMPTS,
  STEP_LEASE_SECONDS,
  StepError,
  emptyJobState,
  estimateCostUsd,
} from '../contract';
import type {
  AiJobResponse,
  AiSettings,
  EngineResult,
  JobApi,
  JobEngine,
  JobInput,
  JobInputResolver,
  JobKind,
  JobRow,
  JobState,
  Json,
  StepDeps,
  StoredResult,
  UsageRecord,
} from '../contract';
import { AiJobApiError } from '../client/errors';
import type { LlmClient } from '../contract';

export interface InMemoryJobApiOptions {
  engine: JobEngine;
  llm: LlmClient;
  /** Turns client params into an engine input (the server reads the database; the demo reads its fixtures). */
  resolveInput: JobInputResolver;
  /** Read before every step, so a test can flip the kill switch or the budgets at any time. */
  settings?: () => AiSettings;
  /** Reads an uploaded scheme. Without it a step that needs a file fails with an internal error. */
  loadUpload?: StepDeps['loadUpload'];
  /**
   * Turns the engine's final result into the `result` the row stores. For unit kinds the caller saves the draft
   * and returns the `UnitDraftResult`; for `scheme_ingest` and `chapter_plan` the default stores the engine
   * result as it is. A throw fails the job.
   */
  onSucceeded?: (
    job: JobRow,
    result: EngineResult[JobKind],
    input: JobInput[JobKind],
  ) => Promise<StoredResult[JobKind]> | StoredResult[JobKind];
  now?: () => Date;
  /** Milliseconds each step waits before it runs, so a UI can show progress. Default 0. */
  stepDelayMs?: number;
}

export interface InMemoryJobApi extends JobApi {
  /** Every job row, oldest first. */
  jobs(): JobRow[];
  /** Every model call the jobs reported, in order (late finishers included: the tokens were spent). */
  usage(): UsageRecord[];
  /** Steps the job until it is finished and returns the final row. For tests and scripts. */
  runStepsToCompletion(jobId: string): Promise<JobRow>;
}

interface JobRecord {
  row: JobRow;
  kind: JobKind;
  input: JobInput[JobKind];
  state: JobState;
  /** Identifies the worker that owns the lease; only that worker may commit. */
  leaseToken: string | null;
  abort: AbortController | null;
  inflight: Promise<void> | null;
}

interface UsageEntry {
  jobId: string;
  at: number;
  /** `null` when no price is entered for the model: unknown, and not counted against the caps. */
  costUsd: number | null;
  record: UsageRecord;
}

export function createInMemoryJobApi(options: InMemoryJobApiOptions): InMemoryJobApi {
  return new MemoryJobApi(options);
}

class MemoryJobApi implements InMemoryJobApi {
  private readonly records = new Map<string, JobRecord>();
  private readonly byKey = new Map<string, string>();
  private readonly usageLog: UsageEntry[] = [];
  private counter = 0;
  private tokens = 0;

  constructor(private readonly options: InMemoryJobApiOptions) {}

  // --- JobApi ---------------------------------------------------------------------------------

  async create(
    kind: JobKind,
    params: Record<string, unknown>,
    idempotencyKey?: string,
  ): Promise<JobRow> {
    if (!JobKindSchema.safeParse(kind).success) {
      throw new AiJobApiError('invalid_request', `Unknown job kind "${String(kind)}"`);
    }
    const existing = idempotencyKey === undefined ? undefined : this.byKey.get(idempotencyKey);
    if (existing !== undefined) return this.snapshot(this.lookup(existing));

    const input = await this.resolve(kind, params);
    // Another create with the same key may have finished while the input was being resolved.
    const raced = idempotencyKey === undefined ? undefined : this.byKey.get(idempotencyKey);
    if (raced !== undefined) return this.snapshot(this.lookup(raced));

    const now = this.clock();
    const id = this.newId();
    const state = emptyJobState();
    const row: JobRow = {
      id,
      kind,
      status: 'queued',
      progress: this.options.engine.progress(kind, input, state),
      lease_until: null,
      attempts: 0,
      error: null,
      result: null,
      ...linkedIds(kind, params, input),
      created_by: null,
      created_at: iso(now),
      updated_at: iso(now),
      finished_at: null,
    };
    const record: JobRecord = {
      row,
      kind,
      input,
      state,
      leaseToken: null,
      abort: null,
      inflight: null,
    };
    this.records.set(id, record);
    if (idempotencyKey !== undefined) this.byKey.set(idempotencyKey, id);
    return this.snapshot(record);
  }

  async step(jobId: string): Promise<AiJobResponse> {
    // Everything up to the lease is synchronous, so two callers can never both win the same lease.
    const record = this.lookup(jobId);
    if (isTerminal(record.row)) return { job: this.snapshot(record) };

    const settings = this.settings();
    if (settings.kill_switch) {
      throw new AiJobApiError('kill_switch', 'AI drafting is switched off (ai.kill_switch)', {
        status: 503,
      });
    }

    const now = this.clock();
    if (this.leaseHeld(record, now)) return { job: this.snapshot(record), busy: true };

    this.assertBudget(record, settings, now);

    let step: string | null;
    try {
      step = this.options.engine.nextStep(record.kind, record.input, record.state);
    } catch (error) {
      this.fail(record, toFailure(error, 'next_step'));
      return { job: this.snapshot(record) };
    }
    if (step === null) {
      this.fail(record, {
        code: 'internal',
        message: 'The engine has no step left but the job is not finished',
        step: 'next_step',
      });
      return { job: this.snapshot(record) };
    }

    // A lease that expired belongs to a worker presumed dead: stop it and take over.
    record.abort?.abort();
    const controller = new AbortController();
    const token = `lease-${(this.tokens += 1)}`;
    record.abort = controller;
    record.leaseToken = token;
    record.row.status = 'running';
    record.row.lease_until = iso(new Date(now.getTime() + STEP_LEASE_SECONDS * 1000));
    record.row.updated_at = iso(now);
    const job = this.snapshot(record);

    const run: Promise<void> = this.execute(record, token, step, controller).finally(() => {
      if (record.inflight === run) record.inflight = null;
    });
    record.inflight = run;
    return { job };
  }

  async get(jobId: string): Promise<JobRow> {
    return this.snapshot(this.lookup(jobId));
  }

  async cancel(jobId: string): Promise<JobRow> {
    const record = this.lookup(jobId);
    if (isTerminal(record.row)) return this.snapshot(record);
    const now = this.clock();
    record.abort?.abort();
    record.leaseToken = null;
    record.row.status = 'cancelled';
    record.row.lease_until = null;
    record.row.updated_at = iso(now);
    record.row.finished_at = iso(now);
    return this.snapshot(record);
  }

  // --- test and demo helpers ------------------------------------------------------------------

  jobs(): JobRow[] {
    return [...this.records.values()].map((record) => this.snapshot(record));
  }

  usage(): UsageRecord[] {
    return this.usageLog.map((entry) => ({ ...entry.record }));
  }

  async runStepsToCompletion(jobId: string): Promise<JobRow> {
    for (let turns = 0; turns < 1000; turns += 1) {
      const record = this.lookup(jobId);
      if (isTerminal(record.row)) return this.snapshot(record);
      if (record.inflight) {
        await record.inflight;
        continue;
      }
      await this.step(jobId);
    }
    throw new Error(`Job ${jobId} did not finish within 1000 turns`);
  }

  // --- the step runner ------------------------------------------------------------------------

  /** Never rejects: every outcome is written to the row (or ignored, if the lease is no longer ours). */
  private async execute(
    record: JobRecord,
    token: string,
    step: string,
    controller: AbortController,
  ): Promise<void> {
    const { engine, llm } = this.options;
    try {
      const delay = this.options.stepDelayMs ?? 0;
      if (delay > 0) await new Promise<void>((resolve) => setTimeout(resolve, delay));
      else await Promise.resolve();
      if (controller.signal.aborted) return;

      const outcome = await engine.runStep(
        { kind: record.kind, input: record.input, state: clone(record.state), step },
        {
          llm,
          settings: this.settings(),
          loadUpload:
            this.options.loadUpload ??
            (async () => {
              throw new Error('This in-memory job API was created without a loadUpload');
            }),
          now: () => this.clock(),
          signal: controller.signal,
        },
      );

      // The tokens were spent whether or not we still own the lease.
      this.recordUsage(record.row.id, outcome.usage);
      if (record.leaseToken !== token) return;

      // The step's output is kept even if what follows fails, so a failed job can be inspected.
      const state: JobState = {
        outputs: { ...record.state.outputs, [step]: clone(outcome.output) },
      };
      record.state = state;
      record.row.attempts = 0;
      record.row.error = null;
      record.row.updated_at = iso(this.clock());
      record.row.progress = engine.progress(record.kind, record.input, state);

      const finished =
        outcome.result !== undefined || engine.nextStep(record.kind, record.input, state) === null;
      if (!finished) {
        record.leaseToken = null;
        record.row.lease_until = null;
        return;
      }
      if (outcome.result === undefined) {
        this.fail(record, { code: 'internal', message: 'The last step returned no result', step });
        return;
      }

      let stored: unknown;
      try {
        stored = await this.store(record, outcome.result);
      } catch (error) {
        if (record.leaseToken === token) this.fail(record, toFailure(error, step));
        return;
      }
      if (record.leaseToken !== token) return;
      const now = this.clock();
      record.leaseToken = null;
      record.abort = null;
      record.row.status = 'succeeded';
      record.row.lease_until = null;
      record.row.result = clone(stored) as Json;
      record.row.updated_at = iso(now);
      record.row.finished_at = iso(now);
    } catch (error) {
      if (record.leaseToken !== token) return;
      this.stepFailed(record, toStepError(error, step));
    }
  }

  /** The caller's `onSucceeded` (usually: save the draft). A throw there fails the job at the last step. */
  private async store(record: JobRecord, result: EngineResult[JobKind]): Promise<unknown> {
    const hook = this.options.onSucceeded;
    return hook ? hook(this.snapshot(record), result, record.input) : result;
  }

  private stepFailed(record: JobRecord, error: StepError): void {
    record.leaseToken = null;
    record.row.lease_until = null;
    const attempts = record.row.attempts + 1;
    record.row.attempts = attempts;
    if (error.retryable && attempts < MAX_STEP_ATTEMPTS) {
      record.row.error = {
        code: error.code,
        message: error.message,
        step: error.step,
        retryable: true,
      };
      record.row.updated_at = iso(this.clock());
      return;
    }
    this.fail(record, { code: error.code, message: error.message, step: error.step });
  }

  private fail(record: JobRecord, failure: { code: string; message: string; step: string }): void {
    const now = this.clock();
    record.leaseToken = null;
    record.abort = null;
    record.row.status = 'failed';
    record.row.lease_until = null;
    record.row.error = { ...failure, retryable: false };
    record.row.updated_at = iso(now);
    record.row.finished_at = iso(now);
  }

  // --- limits ---------------------------------------------------------------------------------

  private assertBudget(record: JobRecord, settings: AiSettings, now: Date): void {
    const { max_usd_per_job, daily_usd_cap } = settings.budget;
    if (max_usd_per_job !== null) {
      const spent = this.spent((entry) => entry.jobId === record.row.id);
      if (spent >= max_usd_per_job) {
        throw new AiJobApiError(
          'budget_exceeded',
          `This job has used its budget of $${max_usd_per_job} ($${spent.toFixed(4)} spent)`,
          { status: 429 },
        );
      }
    }
    if (daily_usd_cap !== null) {
      const today = utcDay(now);
      const spent = this.spent((entry) => utcDay(new Date(entry.at)) === today);
      if (spent >= daily_usd_cap) {
        throw new AiJobApiError(
          'budget_exceeded',
          `Today's AI budget of $${daily_usd_cap} is used up ($${spent.toFixed(4)} spent)`,
          { status: 429 },
        );
      }
    }
  }

  /** Estimated dollars of the entries a filter accepts; calls with no price entered count as nothing. */
  private spent(filter: (entry: UsageEntry) => boolean): number {
    return this.usageLog.filter(filter).reduce((total, entry) => total + (entry.costUsd ?? 0), 0);
  }

  private recordUsage(jobId: string, records: UsageRecord[]): void {
    const at = this.clock().getTime();
    const { prices } = this.settings();
    for (const record of records) {
      this.usageLog.push({
        jobId,
        at,
        costUsd: estimateCostUsd(record, prices),
        record: { ...record },
      });
    }
  }

  // --- plumbing -------------------------------------------------------------------------------

  private async resolve(
    kind: JobKind,
    params: Record<string, unknown>,
  ): Promise<JobInput[JobKind]> {
    try {
      const input = await this.options.resolveInput(kind, params as never);
      return this.options.engine.parseInput(kind, input);
    } catch (error) {
      if (error instanceof AiJobApiError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new AiJobApiError('invalid_request', `Could not build the job input: ${reason}`, {
        cause: error,
      });
    }
  }

  private lookup(jobId: string): JobRecord {
    const record = this.records.get(jobId);
    if (!record) throw new AiJobApiError('not_found', `No job ${jobId}`, { status: 404 });
    return record;
  }

  private leaseHeld(record: JobRecord, now: Date): boolean {
    const until = record.row.lease_until;
    return until !== null && Date.parse(until) > now.getTime();
  }

  /** A validated copy: what a client would read from the database. */
  private snapshot(record: JobRecord): JobRow {
    return JobRowSchema.parse(clone(record.row));
  }

  private settings(): AiSettings {
    return this.options.settings ? this.options.settings() : DEFAULT_AI_SETTINGS;
  }

  private clock(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  private newId(): string {
    this.counter += 1;
    return `00000000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
}

function isTerminal(row: JobRow): boolean {
  return row.status === 'succeeded' || row.status === 'failed' || row.status === 'cancelled';
}

/** What a failed job row records. A hook error may carry its own code (for example `stale_base`). */
function toFailure(error: unknown, step: string): { code: string; message: string; step: string } {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StepError) return { code: error.code, message, step: error.step };
  const code = (error as { code?: unknown } | null)?.code;
  return { code: typeof code === 'string' && code !== '' ? code : 'internal', message, step };
}

function toStepError(error: unknown, step: string): StepError {
  if (error instanceof StepError) return error;
  if (error instanceof LlmError) {
    return new StepError(step, error.code, error.message, {
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      cause: error,
    });
  }
  const message = error instanceof Error ? error.message : String(error);
  return new StepError(step, 'internal', message, { retryable: false, cause: error });
}

/** The unit and scheme a job is about, from the client's params first and the resolved input second. */
function linkedIds(
  kind: JobKind,
  params: Record<string, unknown>,
  input: JobInput[JobKind],
): { unit_id: string | null; scheme_id: string | null } {
  const from = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const body = input as Record<string, unknown>;
  switch (kind) {
    case 'unit_generate': {
      const unit = body['unit'] as { id?: unknown } | undefined;
      return { unit_id: from(params['unit_id']) ?? from(unit?.id), scheme_id: null };
    }
    case 'unit_revise':
      return { unit_id: from(body['unit_id']), scheme_id: null };
    case 'chapter_plan':
      return { unit_id: null, scheme_id: from(params['scheme_id']) ?? from(body['scheme_id']) };
    default:
      return { unit_id: null, scheme_id: null };
  }
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function iso(date: Date): string {
  return date.toISOString();
}

function utcDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}
