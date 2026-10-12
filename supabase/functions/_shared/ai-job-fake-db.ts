// Test support for the `ai-job` edge function (not shipped: nothing in supabase/functions/ai-job imports it).
//
//   FakeDb          an in-memory Supabase client: tables with the PostgREST filter calls the resolver uses,
//                   storage, and RPCs answered by plain functions. It records every call.
//   FakeJobBackend  the SQL of migrations 14 to 20 (create_ai_job, the lease RPCs, the budget check, the draft
//                   save) in TypeScript, so handler tests run whole jobs. The real thing is tested by pgTAP
//                   (supabase/tests/database/08*.test.sql); this keeps the same rules so the two agree.

import type { DbClient, DbResult, Query } from './ai-job-types.ts';
import type { DbError } from './ai-job-errors.ts';

export type Row = Record<string, unknown>;
export type RpcHandler = (
  args: Record<string, unknown>,
) => DbResult<unknown> | Promise<DbResult<unknown>>;

export const ok = <T>(data: T): DbResult<T> => ({ data, error: null });
export const fail = (message: string, code?: string): DbResult<never> => ({
  data: null,
  error: { message, ...(code ? { code } : {}) },
});

class FakeQuery implements Query {
  private readonly filters: Array<(row: Row) => boolean> = [];
  private readonly orders: Array<{ column: string; ascending: boolean }> = [];
  private max = Number.POSITIVE_INFINITY;

  constructor(
    private readonly source: () => Row[],
    private readonly columns: string[],
    private readonly error: DbError | undefined,
  ) {}

  eq(column: string, value: unknown): Query {
    this.filters.push((row) => row[column] === value);
    return this;
  }
  in(column: string, values: readonly unknown[]): Query {
    this.filters.push((row) => values.includes(row[column]));
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): Query {
    this.orders.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(count: number): Query {
    this.max = count;
    return this;
  }

  private run(): DbResult<Row[]> {
    if (this.error) return { data: null, error: this.error };
    let rows = this.source().filter((row) => this.filters.every((filter) => filter(row)));
    for (const { column, ascending } of [...this.orders].reverse()) {
      rows = [...rows].sort((a, b) => {
        const x = a[column];
        const y = b[column];
        if (x === y) return 0;
        if (x === null || x === undefined) return 1;
        if (y === null || y === undefined) return -1;
        const order =
          typeof x === 'number' && typeof y === 'number'
            ? x - y
            : String(x).localeCompare(String(y));
        return ascending ? order : -order;
      });
    }
    rows = rows.slice(0, this.max);
    const all = this.columns.length === 1 && this.columns[0] === '*';
    return {
      data: rows.map((row) => {
        if (all) return structuredClone(row);
        const picked: Row = {};
        for (const column of this.columns)
          if (column in row) picked[column] = structuredClone(row[column]);
        return picked;
      }),
      error: null,
    };
  }

  then<TResult1 = DbResult<Row[]>, TResult2 = never>(
    onfulfilled?: ((value: DbResult<Row[]>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  maybeSingle(): PromiseLike<DbResult<Row>> {
    const result = this.run();
    if (result.error) return Promise.resolve({ data: null, error: result.error });
    const rows = result.data ?? [];
    if (rows.length > 1)
      return Promise.resolve({
        data: null,
        error: { code: 'PGRST116', message: 'more than one row' },
      });
    return Promise.resolve({ data: rows[0] ?? null, error: null });
  }
}

export class FakeDb implements DbClient {
  readonly calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  /** Every table a `from()` touched, in order. */
  readonly reads: string[] = [];
  readonly tableErrors = new Map<string, DbError>();
  objects = new Map<string, { bytes: Uint8Array; type: string }>();
  readonly storageCalls: string[] = [];

  constructor(
    public tables: Record<string, Row[]> = {},
    public rpcs: Record<string, RpcHandler> = {},
  ) {}

  from(table: string): { select(columns: string): Query } {
    return {
      select: (columns: string) => {
        this.reads.push(table);
        return new FakeQuery(
          () => this.tables[table] ?? [],
          columns.split(',').map((column) => column.trim()),
          this.tableErrors.get(table),
        );
      },
    };
  }

  rpc(name: string, args: Record<string, unknown> = {}): PromiseLike<DbResult<unknown>> {
    this.calls.push({ name, args: structuredClone(args) });
    const handler = this.rpcs[name];
    if (!handler) return Promise.resolve(fail(`unknown_rpc_${name}`));
    return Promise.resolve(handler(args));
  }

  calledWith(name: string): Array<Record<string, unknown>> {
    return this.calls.filter((call) => call.name === name).map((call) => call.args);
  }

  storage = {
    from: (bucket: string) => ({
      list: (path: string, options?: { limit?: number; search?: string }) => {
        this.storageCalls.push(`list:${bucket}/${path}`);
        const prefix = `${bucket}/${path}/`;
        const names = [...this.objects.keys()]
          .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
          .map((key) => key.slice(prefix.length))
          .filter((name) => !options?.search || name.includes(options.search));
        return Promise.resolve(ok(names.map((name) => ({ name }))));
      },
      download: (path: string) => {
        this.storageCalls.push(`download:${bucket}/${path}`);
        const found = this.objects.get(`${bucket}/${path}`);
        if (!found) return Promise.resolve(fail('Object not found'));
        return Promise.resolve(
          ok({
            arrayBuffer: () => Promise.resolve(found.bytes.slice().buffer as ArrayBuffer),
            type: found.type,
          }),
        );
      },
    }),
  };
}

// --- the SQL of the job RPCs, in TypeScript -------------------------------------------------------------

export interface BackendSettings {
  models: { authoring: string; tutor: string; moderation: string };
  kill_switch: boolean;
  budget: { max_usd_per_job: number | null; daily_usd_cap: number | null };
  prices: Record<
    string,
    {
      input_per_mtok: number;
      output_per_mtok: number;
      cache_read_per_mtok: number;
      cache_write_per_mtok: number;
    }
  >;
  effort: Record<string, string>;
  prompt_version: string;
}

export const DEFAULT_BACKEND_SETTINGS: BackendSettings = {
  models: {
    authoring: 'claude-opus-5-5',
    tutor: 'claude-sonnet-5-5',
    moderation: 'claude-haiku-5-5',
  },
  kill_switch: false,
  budget: { max_usd_per_job: null, daily_usd_cap: null },
  prices: {},
  effort: {},
  prompt_version: 'm2-v1',
};

interface Secret {
  input: unknown;
  state: { outputs: Record<string, unknown> };
  params: unknown;
  leaseToken: string | null;
}

export interface UsageLogEntry {
  job_id: string;
  label: string;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number | null;
  stop_reason: string | null;
  at: number;
}

const TERMINAL = ['succeeded', 'failed', 'cancelled'];
const MAX_ATTEMPTS = 3;

export class FakeJobBackend {
  /** The JobRow-shaped rows: also served as the `ai_jobs` table of the caller's FakeDb. */
  readonly rows: Row[] = [];
  readonly secrets = new Map<string, Secret>();
  readonly usage: UsageLogEntry[] = [];
  settings: BackendSettings;
  private counter = 0;

  constructor(
    private readonly options: {
      now: () => Date;
      /** The caller's tables: `unit_versions` is read and written by the draft save. */
      tables: Record<string, Row[]>;
      settings?: Partial<BackendSettings>;
    },
  ) {
    this.settings = { ...DEFAULT_BACKEND_SETTINGS, ...options.settings };
    options.tables['ai_jobs'] = this.rows;
  }

  private newId(prefix: string): string {
    this.counter += 1;
    return `${prefix}0000000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
  private iso(): string {
    return this.options.now().toISOString();
  }
  row(id: string): Row {
    const found = this.rows.find((candidate) => candidate['id'] === id);
    if (!found) throw new Error(`no job ${id}`);
    return found;
  }

  /** The RPCs the caller's JWT may call. `userId` is `auth.uid()`; `superAdmin` sees and cancels everything. */
  userRpcs(userId: string, superAdmin = false): Record<string, RpcHandler> {
    return {
      get_ai_settings: () => ok(structuredClone(this.settings)),
      create_ai_job: (args) => this.createJob(userId, args),
      cancel_ai_job: (args) => {
        const found = this.rows.find((candidate) => candidate['id'] === args['p_job_id']);
        if (!found || !(found['created_by'] === userId || superAdmin))
          return fail('job_not_found', 'P0002');
        if (!TERMINAL.includes(String(found['status']))) {
          const now = this.iso();
          Object.assign(found, {
            status: 'cancelled',
            lease_until: null,
            finished_at: now,
            updated_at: now,
          });
          const secret = this.secrets.get(String(found['id']));
          if (secret) secret.leaseToken = null;
        }
        return ok(structuredClone(found));
      },
      create_unit_version_draft: (args) => this.saveDraft(userId, args),
    };
  }

  /** The service-role RPCs of the edge function. */
  serviceRpcs(): Record<string, RpcHandler> {
    return {
      ai_job_budget_check: (args) => this.budgetCheck(String(args['p_job_id'])),
      ai_job_acquire_lease: (args) =>
        this.acquire(String(args['p_job_id']), Number(args['p_lease_seconds'])),
      ai_job_complete_step: (args) => this.complete(args),
      ai_job_fail_step: (args) => this.failStep(args),
    };
  }

  private createJob(userId: string, args: Record<string, unknown>): DbResult<unknown> {
    const key = typeof args['p_idempotency_key'] === 'string' ? args['p_idempotency_key'] : null;
    if (key !== null) {
      const existing = this.rows.find(
        (row) => row['created_by'] === userId && this.keyOf(row) === key,
      );
      if (existing) return ok(structuredClone(existing));
    }
    if (this.settings.kill_switch) return fail('kill_switch', '42501');
    const unfinished = this.rows.filter(
      (row) => row['created_by'] === userId && !TERMINAL.includes(String(row['status'])),
    ).length;
    if (unfinished >= 5) return fail('too_many_jobs', '53400');
    const now = this.iso();
    const id = this.newId('a');
    const row: Row = {
      id,
      kind: args['p_kind'],
      status: 'queued',
      progress: { done: [], next: null, total: 0 },
      lease_until: null,
      attempts: 0,
      error: null,
      result: null,
      unit_id: args['p_unit_id'] ?? null,
      scheme_id: args['p_scheme_id'] ?? null,
      created_by: userId,
      created_at: now,
      updated_at: now,
      finished_at: null,
    };
    this.rows.push(row);
    this.secrets.set(id, {
      input: structuredClone(args['p_input']),
      state: { outputs: {} },
      params: structuredClone(args['p_params']),
      leaseToken: null,
    });
    if (key !== null) this.keys.set(id, key);
    return ok(structuredClone(row));
  }

  private readonly keys = new Map<string, string>();
  private keyOf(row: Row): string | undefined {
    return this.keys.get(String(row['id']));
  }

  private saveDraft(userId: string, args: Record<string, unknown>): DbResult<unknown> {
    const versions = (this.options.tables['unit_versions'] ??= []);
    const unitId = args['p_unit_id'];
    const forUnit = versions.filter((version) => version['unit_id'] === unitId);
    const latest = [...forUnit].sort((a, b) => Number(b['version']) - Number(a['version']))[0];
    if (latest ? args['p_base_version_id'] !== latest['id'] : args['p_base_version_id'] !== null) {
      return fail('stale_base', '22023');
    }
    const id = this.newId('d');
    const version = (latest ? Number(latest['version']) : 0) + 1;
    versions.push({
      id,
      unit_id: unitId,
      version,
      content: args['p_content'],
      lint_report: args['p_lint_report'],
      generated_by: args['p_generated_by'],
      model: args['p_model'],
      prompt_version: args['p_prompt_version'],
      base_version_id: args['p_base_version_id'],
      status: 'draft',
      created_by: userId,
    });
    return ok({ id, version });
  }

  private cost(model: string, record: Record<string, number>): number | null {
    let best: string | undefined;
    for (const key of Object.keys(this.settings.prices)) {
      if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
    }
    if (best === undefined) return null;
    const price = this.settings.prices[best] as BackendSettings['prices'][string];
    return (
      ((record['input_tokens'] ?? 0) * price.input_per_mtok +
        (record['output_tokens'] ?? 0) * price.output_per_mtok +
        (record['cache_read_tokens'] ?? 0) * price.cache_read_per_mtok +
        (record['cache_creation_tokens'] ?? 0) * price.cache_write_per_mtok) /
      1_000_000
    );
  }

  private logUsage(jobId: string, usage: unknown): void {
    for (const record of (Array.isArray(usage) ? usage : []) as Array<Record<string, unknown>>) {
      this.usage.push({
        job_id: jobId,
        label: String(record['label']),
        task: String(record['task']),
        model: String(record['model']),
        input_tokens: Number(record['input_tokens'] ?? 0),
        output_tokens: Number(record['output_tokens'] ?? 0),
        est_cost_usd: this.cost(String(record['model']), record as Record<string, number>),
        stop_reason: (record['stop_reason'] as string | null) ?? null,
        at: this.options.now().getTime(),
      });
    }
  }

  private budgetCheck(jobId: string): DbResult<unknown> {
    const dayStart = Date.UTC(
      this.options.now().getUTCFullYear(),
      this.options.now().getUTCMonth(),
      this.options.now().getUTCDate(),
    );
    const sum = (entries: UsageLogEntry[]) =>
      entries.reduce((total, entry) => total + (entry.est_cost_usd ?? 0), 0);
    const ofJob = this.usage.filter((entry) => entry.job_id === jobId);
    const today = this.usage.filter((entry) => entry.at >= dayStart);
    return ok({
      kill_switch: this.settings.kill_switch,
      job_cost_usd: sum(ofJob),
      day_cost_usd: sum(today),
      max_usd_per_job: this.settings.budget.max_usd_per_job,
      daily_usd_cap: this.settings.budget.daily_usd_cap,
      unpriced_calls: ofJob.filter((entry) => entry.est_cost_usd === null).length,
      day_unpriced_calls: today.filter((entry) => entry.est_cost_usd === null).length,
    });
  }

  private acquire(jobId: string, seconds: number): DbResult<unknown> {
    const row = this.row(jobId);
    const secret = this.secrets.get(jobId) as Secret;
    const now = this.options.now().getTime();
    if (TERMINAL.includes(String(row['status'])))
      return ok({ acquired: false, reason: 'terminal', job: structuredClone(row) });
    if (typeof row['lease_until'] === 'string' && Date.parse(row['lease_until']) > now) {
      return ok({ acquired: false, reason: 'busy', job: structuredClone(row) });
    }
    if (this.settings.kill_switch) return fail('kill_switch', '42501');
    if (typeof row['lease_until'] === 'string') {
      row['attempts'] = Number(row['attempts']) + 1;
      row['error'] = {
        code: 'aborted',
        message: 'The previous attempt of this step did not finish in time.',
        retryable: Number(row['attempts']) < MAX_ATTEMPTS,
      };
      row['lease_until'] = null;
      secret.leaseToken = null;
      if (Number(row['attempts']) >= MAX_ATTEMPTS) {
        row['status'] = 'failed';
        row['finished_at'] = this.iso();
        return ok({ acquired: false, reason: 'terminal', job: structuredClone(row) });
      }
    }
    const token = this.newId('7');
    secret.leaseToken = token;
    row['status'] = 'running';
    row['lease_until'] = new Date(now + seconds * 1000).toISOString();
    row['updated_at'] = this.iso();
    return ok({
      acquired: true,
      job: structuredClone(row),
      kind: row['kind'],
      input: structuredClone(secret.input),
      state: structuredClone(secret.state),
      lease_token: token,
    });
  }

  private holds(row: Row, secret: Secret, token: unknown): boolean {
    return row['status'] === 'running' && typeof token === 'string' && secret.leaseToken === token;
  }

  private complete(args: Record<string, unknown>): DbResult<unknown> {
    const jobId = String(args['p_job_id']);
    const row = this.row(jobId);
    const secret = this.secrets.get(jobId) as Secret;
    this.logUsage(jobId, args['p_usage']);
    if (!this.holds(row, secret, args['p_lease_token'])) return ok(false);
    secret.state = {
      outputs: {
        ...secret.state.outputs,
        [String(args['p_step'])]: structuredClone(args['p_output']),
      },
    };
    secret.leaseToken = null;
    Object.assign(row, {
      progress: structuredClone(args['p_progress']),
      attempts: 0,
      error: null,
      lease_until: null,
      updated_at: this.iso(),
    });
    if (args['p_result'] !== null && args['p_result'] !== undefined) {
      Object.assign(row, {
        status: 'succeeded',
        result: structuredClone(args['p_result']),
        finished_at: this.iso(),
      });
    }
    return ok(true);
  }

  private failStep(args: Record<string, unknown>): DbResult<unknown> {
    const jobId = String(args['p_job_id']);
    const row = this.row(jobId);
    const secret = this.secrets.get(jobId) as Secret;
    this.logUsage(jobId, args['p_usage']);
    if (!this.holds(row, secret, args['p_lease_token'])) return ok(false);
    const attempts = Number(row['attempts']) + 1;
    const raw = (args['p_error'] ?? {}) as Record<string, unknown>;
    const retryable = args['p_retryable'] === true;
    const retry = retryable && attempts < MAX_ATTEMPTS;
    secret.leaseToken = null;
    Object.assign(row, {
      attempts,
      error: {
        code: String(raw['code'] ?? 'internal').slice(0, 64),
        message: String(raw['message'] ?? 'The step failed.').slice(0, 500),
        step: String(args['p_step']).slice(0, 128),
        retryable,
      },
      lease_until: null,
      status: retry ? 'running' : 'failed',
      finished_at: retry ? null : this.iso(),
      updated_at: this.iso(),
    });
    return ok(true);
  }
}
