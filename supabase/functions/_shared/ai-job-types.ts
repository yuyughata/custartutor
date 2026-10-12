// Structural types for the `ai-job` edge function.
//
// The function cannot import the contract or the authoring-core source (edge functions only bundle files inside
// supabase/functions), so everything it needs from them is declared here as the smallest structural shape, and the
// real thing is INJECTED: `core` is the vendored authoring-core bundle in production and the TypeScript source in
// Vitest; `engine` is `createJobEngine()`. ai-job-handler.test.ts assigns the real contract to these types, so a
// drift between the two breaks the build of the tests.

import type { AiJobErrorCode, DbError } from './ai-job-errors.ts';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };

export const JOB_KINDS = ['scheme_ingest', 'chapter_plan', 'unit_generate', 'unit_revise'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const TERMINAL_STATUSES = ['succeeded', 'failed', 'cancelled'] as const;

// --- the database, as far as the function uses it -------------------------------------------------------

export interface DbResult<T> {
  data: T | null;
  error: DbError | null;
}

type Row = Record<string, unknown>;

/** The part of the PostgREST filter builder the resolver uses. Awaiting it yields all matching rows. */
export interface Query extends PromiseLike<DbResult<Row[]>> {
  eq(column: string, value: unknown): Query;
  in(column: string, values: readonly unknown[]): Query;
  order(column: string, options?: { ascending?: boolean }): Query;
  limit(count: number): Query;
  maybeSingle(): PromiseLike<DbResult<Row>>;
}

export interface StorageBucket {
  list(
    path: string,
    options?: { limit?: number; search?: string },
  ): PromiseLike<DbResult<Array<{ name: string }>>>;
  download(
    path: string,
  ): PromiseLike<DbResult<{ arrayBuffer(): Promise<ArrayBuffer>; type: string }>>;
}

/** A Supabase client (the caller's, or the service role's). The real client is cast to this in the Deno glue. */
export interface DbClient {
  from(table: string): { select(columns: string): Query };
  rpc(name: string, args?: Record<string, unknown>): PromiseLike<DbResult<unknown>>;
  storage: { from(bucket: string): StorageBucket };
}

// --- the contract, as far as the function uses it -------------------------------------------------------

export interface ParseIssue {
  path: ReadonlyArray<PropertyKey>;
  message: string;
}
export type ParseResult<T> =
  { success: true; data: T } | { success: false; error: { issues: ReadonlyArray<ParseIssue> } };
export interface Parser<T> {
  safeParse(value: unknown): ParseResult<T>;
}

export type AiJobRequest =
  | { action: 'create'; kind: JobKind; params: Record<string, unknown>; idempotency_key?: string }
  | { action: 'step'; job_id: string }
  | { action: 'cancel'; job_id: string };

export interface SchemeSource {
  type: 'pdf' | 'text';
  filename: string;
  path?: string;
  text?: string;
}

/** The validated client params of each kind (the Zod schemas of the contract). */
export interface JobParamsMap {
  scheme_ingest: { subject_id: string; level_code: string; term: number; source: SchemeSource };
  chapter_plan: { scheme_id: string };
  unit_generate: { unit_id: string; notes?: string };
  unit_revise: { unit_version_id: string; instruction: string; section_ids?: string[] };
}

export interface AiSettings {
  models: { authoring: string; tutor: string; moderation: string };
  kill_switch: boolean;
  budget: { max_usd_per_job: number | null; daily_usd_cap: number | null };
  prices: Record<string, unknown>;
  effort: Record<string, string>;
  prompt_version: string;
}

export interface UsageRecord {
  label: string;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  stop_reason: string | null;
  duration_ms: number;
}

/** What the function takes from the authoring-core module: schemas and constants. */
export interface AuthoringCore {
  AiJobRequest: Parser<AiJobRequest>;
  SchemeIngestParams: Parser<JobParamsMap['scheme_ingest']>;
  ChapterPlanParams: Parser<JobParamsMap['chapter_plan']>;
  UnitGenerateParams: Parser<JobParamsMap['unit_generate']>;
  UnitReviseParams: Parser<JobParamsMap['unit_revise']>;
  AiSettings: Parser<AiSettings>;
  CastTraits: Parser<Record<string, unknown>>;
  STEP_LEASE_SECONDS: number;
}

export interface JobState {
  outputs: Record<string, Json>;
}

export interface JobProgress {
  done: string[];
  next: string | null;
  total: number;
}

/** The lint report, review flags and summary of a drafted unit (UnitDraftOutput in the contract). */
export interface UnitDraftOutput {
  content: Json;
  lint: { errors: Json[]; warnings: Json[]; ok: boolean };
  review: Json[];
  summary: string;
  changed?: { section_ids: string[]; question_ids: string[] };
}

export interface StepOutcome {
  output: Json;
  usage: UsageRecord[];
  /** Present on the last step only. */
  result?: unknown;
}

export interface StepDeps {
  llm: object;
  settings: AiSettings;
  loadUpload(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
  now(): Date;
  signal?: AbortSignal;
}

/** `createJobEngine()` of authoring-core. Inputs are opaque here: the engine parsed them itself. */
export interface JobEngine {
  parseInput(kind: JobKind, input: unknown): unknown;
  nextStep(kind: JobKind, input: never, state: JobState): string | null;
  progress(kind: JobKind, input: never, state: JobState): JobProgress;
  runStep(
    call: { kind: JobKind; input: never; state: JobState; step: string },
    deps: StepDeps,
  ): Promise<StepOutcome>;
}

// --- the handler's dependencies ------------------------------------------------------------------------

export interface TokenClaims {
  sub?: string;
  role?: string;
  aal?: string;
  /** Seconds since the epoch. */
  exp?: number;
}

export interface AiJobDeps {
  core: AuthoringCore;
  engine: JobEngine;
  /** Whether ANTHROPIC_API_KEY is set. The key itself never enters the handler. */
  hasAnthropicKey(): boolean;
  /** Builds the model client for one step (only called when the key is set). */
  createLlm(settings: AiSettings): object;
  /** A client acting as the caller: RLS and the role checks of the RPCs apply. */
  userDb(req: Request): DbClient;
  /** The service role: only for the ai_job_* RPCs. */
  serviceDb(): DbClient;
  /** Claims of the bearer token. The platform verified the JWT (verify_jwt = true); the database re-checks it. */
  claimsOf(token: string): TokenClaims | null;
  /** `EdgeRuntime.waitUntil` in production. */
  waitUntil(promise: Promise<unknown>): void;
  now(): Date;
  uuid(): string;
  /** Browser origins allowed to call the function (the `ALLOWED_ORIGINS` secret). */
  allowedOrigins: readonly string[];
  /** Also allow `http://localhost:<port>` and `http://127.0.0.1:<port>` (admin app development). Default true. */
  allowLocalhost?: boolean;
  /** Wall-clock budget of one step in milliseconds. Default: the lease minus 15 seconds. */
  stepTimeoutMs?: number;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export type { AiJobErrorCode };
