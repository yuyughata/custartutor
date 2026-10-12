// The M2 contract: what the model port, the step engine, the server and the admin app agree on.
//
// This file is the single source of truth for everything that crosses a package boundary in the content
// engine (docs/m2-plan.md, ADR 0007). Pure types and Zod schemas: no I/O, no SDK imports, so it runs in Deno,
// Node and the browser. The authoring-core implementation, the `ai-job` edge function and the admin app are
// all written against it; change it only together with all three.
import { z } from 'zod';
import {
  Id,
  LevelCode,
  Scheme,
  SectionType,
  Slug,
  Stage,
  Term,
  Text,
  Theme,
  UnitKind,
} from '@custar/content-schema';

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

// ---------------------------------------------------------------------------------------------
// 1. The model port
// ---------------------------------------------------------------------------------------------

/** The kind of work a call does. The adapter resolves it to a model id through `LlmModels`. */
export const LLM_TASKS = ['authoring', 'tutor', 'moderation'] as const;
export const LlmTask = z.enum(LLM_TASKS);
export type LlmTask = z.infer<typeof LlmTask>;

export const LlmModels = z.object({
  authoring: z.string().min(1),
  tutor: z.string().min(1),
  moderation: z.string().min(1),
});
export type LlmModels = z.infer<typeof LlmModels>;

/** Defaults; the live values are the `ai.models` row of `app_settings`. */
export const DEFAULT_MODELS: LlmModels = {
  authoring: 'claude-opus-5-5',
  tutor: 'claude-sonnet-5-5',
  moderation: 'claude-haiku-5-5',
};

/** Reasoning effort. Always set explicitly (never rely on the model default). */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const Effort = z.enum(EFFORTS);
export type Effort = z.infer<typeof Effort>;

/** One block of the system prompt. `cache: true` marks the end of a cacheable prefix. */
export interface LlmSystemBlock {
  text: string;
  cache?: boolean;
}

export type LlmContentPart =
  | { type: 'text'; text: string }
  /** A PDF handed to Claude natively (text and page images). */
  | { type: 'pdf'; base64: string; title?: string };

/** The last message must be a `user` message: these models reject assistant prefill. */
export interface LlmMessage {
  role: 'user' | 'assistant';
  content: string | LlmContentPart[];
}

export interface LlmRequest<T> {
  task: LlmTask;
  /** For logs and `ai_usage`, for example `unit_generate:section:come_and_explore`. */
  label: string;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  /** The structured-output schema. The adapter converts it to JSON Schema and validates the reply with it. */
  schema: z.ZodType<T>;
  schemaName: string;
  effort: Effort;
  maxTokens: number;
  /** Aborts the call when the step's deadline is near. */
  signal?: AbortSignal;
}

export interface LlmUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
}

export interface LlmResult<T> {
  value: T;
  usage: LlmUsage;
  /** The model that actually served the call (after any fallback). */
  model: string;
  stopReason: string;
}

export interface LlmClient {
  /**
   * One structured call. Resolves with a value that already passed `schema`. Rejects with an `LlmError`
   * subclass: never with a half-valid value.
   */
  generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>>;
}

export type LlmErrorCode = 'refusal' | 'schema' | 'truncated' | 'transport' | 'aborted';

/** Base of every model-port failure. `retryable` means: the same call may succeed later without a change. */
export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly retryable: boolean;
  /** Server-suggested wait (from `retry-after`), when there was one. */
  readonly retryAfterMs?: number;
  /** HTTP status when there was one. */
  readonly status?: number;
  /** Raw text of the model reply, kept for the job's diagnostics (never shown to children). */
  readonly raw?: string;

  constructor(
    code: LlmErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      status?: number;
      raw?: string;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'LlmError';
    this.code = code;
    this.retryable = options.retryable ?? code === 'transport';
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    if (options.status !== undefined) this.status = options.status;
    if (options.raw !== undefined) this.raw = options.raw;
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Settings (app_settings) and usage
// ---------------------------------------------------------------------------------------------

/** Keys of the `app_settings` table that the content engine reads. Values are validated on read. */
export const APP_SETTING_KEYS = [
  'ai.models',
  'ai.kill_switch',
  'ai.budget',
  'ai.prices',
  'ai.effort',
  'ai.prompt_version',
] as const;
export type AppSettingKey = (typeof APP_SETTING_KEYS)[number];

export const Price = z.object({
  /** US dollars per million tokens. */
  input_per_mtok: z.number().nonnegative(),
  output_per_mtok: z.number().nonnegative(),
  cache_read_per_mtok: z.number().nonnegative(),
  cache_write_per_mtok: z.number().nonnegative(),
});
export type Price = z.infer<typeof Price>;

/**
 * The assembled view of the settings. Prices are NOT built in: they are entered by the owner, because a
 * wrong built-in price would make the cost panel confidently wrong. No price for a model means the cost of
 * its calls is stored as null and shown as "unknown".
 */
export const AiSettings = z.object({
  models: LlmModels,
  kill_switch: z.boolean(),
  budget: z.object({
    max_usd_per_job: z.number().positive().nullable(),
    daily_usd_cap: z.number().positive().nullable(),
  }),
  prices: z.record(z.string(), Price),
  /** Per step-family override of the default effort, for example `{ "unit_generate:core": "high" }`. */
  effort: z.record(z.string(), Effort),
  prompt_version: z.string().min(1),
});
export type AiSettings = z.infer<typeof AiSettings>;

export const DEFAULT_AI_SETTINGS: AiSettings = {
  models: DEFAULT_MODELS,
  kill_switch: false,
  budget: { max_usd_per_job: null, daily_usd_cap: null },
  prices: {},
  effort: {},
  prompt_version: 'm2-v1',
};

/** One model call, as the engine reports it and as `ai_usage` stores it. */
export const UsageRecord = z.object({
  label: z.string(),
  task: LlmTask,
  model: z.string(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cache_read_tokens: z.number().int().nonnegative(),
  cache_creation_tokens: z.number().int().nonnegative(),
  stop_reason: z.string().nullable(),
  duration_ms: z.number().int().nonnegative(),
});
export type UsageRecord = z.infer<typeof UsageRecord>;

/**
 * The price entry for a model id: an exact match, else the longest entry whose key is a prefix of the id (the
 * API may report a dated snapshot such as `claude-opus-5-5-20261001` for the alias `claude-opus-5-5`).
 */
export function priceFor(model: string, prices: AiSettings['prices']): Price | undefined {
  const exact = prices[model];
  if (exact) return exact;
  let best: string | undefined;
  for (const key of Object.keys(prices)) {
    if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
  }
  return best === undefined ? undefined : prices[best];
}

/** Estimated US-dollar cost of one call, or null when the model has no price entered. */
export function estimateCostUsd(
  usage: Pick<
    UsageRecord,
    'model' | 'input_tokens' | 'output_tokens' | 'cache_read_tokens' | 'cache_creation_tokens'
  >,
  prices: AiSettings['prices'],
): number | null {
  const price = priceFor(usage.model, prices);
  if (!price) return null;
  const mtok = 1_000_000;
  return (
    (usage.input_tokens * price.input_per_mtok +
      usage.output_tokens * price.output_per_mtok +
      usage.cache_read_tokens * price.cache_read_per_mtok +
      usage.cache_creation_tokens * price.cache_write_per_mtok) /
    mtok
  );
}

// ---------------------------------------------------------------------------------------------
// 3. The cast bible (characters.traits)
// ---------------------------------------------------------------------------------------------

/**
 * `characters.traits`. Only facts the owner supplied are facts. Everything else the generator may say about
 * a character must come from `derived_guidance`, which is labelled as derived from age and is editable in
 * the admin app. `relationship_note` is empty until the owner says how the characters are related: the
 * generator must never call two characters siblings or friends on its own.
 */
export const CastTraits = z.object({
  age_years: z.number().int().min(2).max(20).optional(),
  /** Free text such as "almost 5", kept because `age_years` rounds down. */
  age_note: z.string().optional(),
  gender: z.enum(['female', 'male']).optional(),
  pronouns: z.string().optional(),
  relationship_note: z.string().optional(),
  /** Personality traits supplied by the owner. Empty until supplied. */
  personality: z.array(z.string()).default([]),
  /** Writing and behaviour guidance derived from age only. Labelled as such in prompts and in the UI. */
  derived_guidance: z.string().optional(),
});
export type CastTraits = z.infer<typeof CastTraits>;

export interface CastMember {
  slug: string;
  name: string;
  traits: CastTraits;
  /** `characters.voice`: how the character speaks, owner-supplied. Free-form. */
  voice: Record<string, Json>;
}

/** The facts the owner gave on 2026-10-12. Seeded into `characters` by the M2 migration. */
export const OWNER_CAST_FACTS: Record<string, Partial<CastTraits>> = {
  zari: { age_years: 7, gender: 'female', pronouns: 'she/her' },
  zuri: { age_years: 4, age_note: 'almost 5', gender: 'male', pronouns: 'he/him' },
};

// ---------------------------------------------------------------------------------------------
// 4. Jobs: kinds, params, inputs, results
// ---------------------------------------------------------------------------------------------

export const JOB_KINDS = ['scheme_ingest', 'chapter_plan', 'unit_generate', 'unit_revise'] as const;
export const JobKind = z.enum(JOB_KINDS);
export type JobKind = z.infer<typeof JobKind>;

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'cancelled'] as const;
export const JobStatus = z.enum(JOB_STATUSES);
export type JobStatus = z.infer<typeof JobStatus>;

const Uuid = z.string().uuid();

/** Advisory notes for the human reviewer: never blocking, never auto-applied. */
export const Flag = z.object({
  code: z.string(),
  severity: z.enum(['note', 'concern']),
  message: z.string(),
  /** Scheme week the note is about. */
  week_no: z.number().int().optional(),
  /** Location in a unit, for example `sections[3].blocks[1]`. */
  path: z.string().optional(),
});
export type Flag = z.infer<typeof Flag>;

// --- scheme_ingest ---

export const SchemeSource = z.discriminatedUnion('type', [
  /** A PDF uploaded to the private `scheme-uploads` bucket. Claude reads it natively. */
  z.object({ type: z.literal('pdf'), path: z.string().min(1), filename: z.string() }),
  /** Text the admin app extracted (for example from a DOCX with mammoth) or pasted. */
  z.object({
    type: z.literal('text'),
    text: z.string().min(1).max(300_000),
    filename: z.string(),
  }),
]);
export type SchemeSource = z.infer<typeof SchemeSource>;

/** What the admin app sends to `ai-job` `create`. */
export const SchemeIngestParams = z.object({
  subject_id: Uuid,
  level_code: LevelCode,
  term: Term,
  source: SchemeSource,
});
export type SchemeIngestParams = z.infer<typeof SchemeIngestParams>;

/** What the engine receives (the server resolves ids to slugs and names). */
export const SchemeIngestInput = z.object({
  subject_slug: Slug,
  subject_name: z.string(),
  level_code: LevelCode,
  term: Term,
  source: SchemeSource,
});
export type SchemeIngestInput = z.infer<typeof SchemeIngestInput>;

/** An editable draft: nothing is saved until the admin applies it with `save_scheme_draft`. */
export const SchemeIngestResult = z.object({
  scheme: Scheme,
  flags: z.array(Flag),
  source_note: z.string(),
});
export type SchemeIngestResult = z.infer<typeof SchemeIngestResult>;

// --- chapter_plan ---

export const ChapterPlanParams = z.object({ scheme_id: Uuid });
export type ChapterPlanParams = z.infer<typeof ChapterPlanParams>;

export const ChapterPlanInput = z.object({
  scheme_id: Uuid,
  scheme: Scheme,
  subject_name: z.string(),
  cast: z.array(z.custom<CastMember>()),
});
export type ChapterPlanInput = z.infer<typeof ChapterPlanInput>;

export const PlannedUnit = z.object({
  /** 1-based ordinal within the term: the same numbering as `UnitContent.header.unit_no`. */
  unit_no: z.number().int().min(1),
  week_no: z.number().int().min(1).max(15),
  kind: UnitKind,
  title: Text,
  /** Drafted from the scheme topic and subtopics; the admin edits it. */
  objective: Text,
  stage: Stage,
  stage_to: Stage.optional(),
  periods: z.number().int().min(1).max(10),
});
export type PlannedUnit = z.infer<typeof PlannedUnit>;

export const PlannedChapter = z.object({
  chapter_no: z.number().int().min(1),
  title: Text,
  /** A proposed cross-subject theme for the chapter; optional. */
  theme: Theme.optional(),
  /** 3 to 5 units (the validator of `publish_unit_version` enforces the same bound). */
  units: z.array(PlannedUnit).min(1).max(5),
});
export type PlannedChapter = z.infer<typeof PlannedChapter>;

export const ChapterPlan = z.object({ chapters: z.array(PlannedChapter).min(1) });
export type ChapterPlan = z.infer<typeof ChapterPlan>;

export const ChapterPlanResult = z.object({ plan: ChapterPlan, flags: z.array(Flag) });
export type ChapterPlanResult = z.infer<typeof ChapterPlanResult>;

// --- unit_generate ---

export const UnitGenerateParams = z.object({
  unit_id: Uuid,
  /** Free-text instruction from the admin ("keep the market story, use cassava as the example"). */
  notes: z.string().max(2000).optional(),
});
export type UnitGenerateParams = z.infer<typeof UnitGenerateParams>;

export const PriorUnitDigest = z.object({
  unit_no: z.number().int(),
  title: z.string(),
  objective: z.string().nullable(),
  /** Key terms the unit taught, for the "Remember?" section. Empty when the unit has no content yet. */
  key_terms: z.array(z.string()),
});
export type PriorUnitDigest = z.infer<typeof PriorUnitDigest>;

export const UnitGenerateInput = z.object({
  unit: z.object({
    id: Uuid,
    kind: UnitKind,
    unit_no: z.number().int().min(1),
    week_no: z.number().int().min(1).max(15).nullable(),
    title: z.string(),
    objective: z.string(),
    stage: Stage,
    stage_to: Stage.optional(),
    periods: z.number().int().min(1).max(10),
  }),
  chapter: z.object({ number: z.number().int().min(1), title: z.string() }),
  subject: z.object({ slug: Slug, name: z.string() }),
  level_code: LevelCode,
  term: Term,
  theme: Theme.optional(),
  /** The scheme week this unit teaches, verbatim. */
  scheme_week: z.object({ topic: z.string(), subtopics: z.array(z.string()) }).nullable(),
  /** Earlier units of the same subject and level, nearest last, for spiral review. */
  prior_units: z.array(PriorUnitDigest),
  /** Enrichment section types used by the previous unit of the subject (rotation). */
  previous_enrichment: z.array(SectionType),
  cast: z.array(z.custom<CastMember>()),
  notes: z.string().optional(),
});
export type UnitGenerateInput = z.infer<typeof UnitGenerateInput>;

// --- unit_revise ---

export const UnitReviseParams = z.object({
  unit_version_id: Uuid,
  instruction: z.string().min(1).max(4000),
  /** Restrict the change to these section ids; omitted = the model decides. */
  section_ids: z.array(Id).optional(),
});
export type UnitReviseParams = z.infer<typeof UnitReviseParams>;

export const UnitReviseInput = z.object({
  unit_id: Uuid,
  base_version_id: Uuid,
  base_version_no: z.number().int().min(1),
  /** The base version's `UnitContent` (JSON). The engine parses it. */
  base_content: z.custom<Json>(),
  instruction: z.string(),
  section_ids: z.array(Id).optional(),
  previous_enrichment: z.array(SectionType),
  cast: z.array(z.custom<CastMember>()),
});
export type UnitReviseInput = z.infer<typeof UnitReviseInput>;

// --- the engine's draft output and what the job row keeps ---

/** Claude-judged advisory checks for the reviewer. `code` is one of neutrality | reading_level | facts | cast | safety | other. */
export const ReviewFlag = Flag;
export type ReviewFlag = Flag;

/** What the engine produces for unit_generate and unit_revise: the whole unit, ready to be saved as a draft. */
export interface UnitDraftOutput {
  /** A parsed, linted `UnitContent` as JSON. */
  content: Json;
  /** The deterministic lint report (`lintUnit`, plus `lintVersionIds` for a revision). */
  lint: { errors: Flag[]; warnings: Flag[]; ok: boolean };
  review: ReviewFlag[];
  /** One or two sentences for the admin: what was drafted or what changed. */
  summary: string;
  /** For a revision: ids of the sections and questions that changed. */
  changed?: { section_ids: string[]; question_ids: string[] };
}

/** What the job row stores for unit_generate and unit_revise (the content itself is in `unit_versions`). */
export const UnitDraftResult = z.object({
  unit_version_id: Uuid,
  version: z.number().int().min(1),
  lint: z.object({ errors: z.number().int(), warnings: z.number().int(), ok: z.boolean() }),
  review: z.array(Flag),
  summary: z.string(),
  changed: z
    .object({ section_ids: z.array(z.string()), question_ids: z.array(z.string()) })
    .optional(),
});
export type UnitDraftResult = z.infer<typeof UnitDraftResult>;

/** The `lint_report` column of `unit_versions` for an AI draft. */
export interface StoredLintReport {
  errors: Flag[];
  warnings: Flag[];
  ok: boolean;
  review: ReviewFlag[];
  summary?: string;
}

export type JobParams = {
  scheme_ingest: SchemeIngestParams;
  chapter_plan: ChapterPlanParams;
  unit_generate: UnitGenerateParams;
  unit_revise: UnitReviseParams;
};

export type JobInput = {
  scheme_ingest: SchemeIngestInput;
  chapter_plan: ChapterPlanInput;
  unit_generate: UnitGenerateInput;
  unit_revise: UnitReviseInput;
};

/** What the engine's last step returns, per kind. */
export type EngineResult = {
  scheme_ingest: SchemeIngestResult;
  chapter_plan: ChapterPlanResult;
  unit_generate: UnitDraftOutput;
  unit_revise: UnitDraftOutput;
};

/** What the job row keeps in `result`, per kind. */
export type StoredResult = {
  scheme_ingest: SchemeIngestResult;
  chapter_plan: ChapterPlanResult;
  unit_generate: UnitDraftResult;
  unit_revise: UnitDraftResult;
};

// ---------------------------------------------------------------------------------------------
// 5. The step engine
// ---------------------------------------------------------------------------------------------

/** Accumulated step outputs, persisted in `ai_jobs.state` after every step. */
export interface JobState {
  outputs: Record<string, Json>;
}

export function emptyJobState(): JobState {
  return { outputs: {} };
}

export interface JobProgress {
  /** Steps finished, in order. */
  done: string[];
  /** The step that runs next, or null when the job is complete. */
  next: string | null;
  /** Total steps if known so far (some plans grow after an early step). */
  total: number;
}

export interface StepDeps {
  llm: LlmClient;
  settings: AiSettings;
  /** Reads an uploaded file from the `scheme-uploads` bucket. */
  loadUpload(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
  now(): Date;
  /** Aborted when the step's wall-clock budget is nearly spent. */
  signal?: AbortSignal;
}

export type StepErrorCode =
  'refusal' | 'schema' | 'truncated' | 'transport' | 'aborted' | 'invalid_input' | 'internal';

/** Thrown by a step. `retryable` steps are retried by the client with the same state. */
export class StepError extends Error {
  readonly code: StepErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;
  readonly step: string;
  /** Model calls that were made and billed before the step failed (a refusal or a bad reply still costs tokens). */
  readonly usage: UsageRecord[];

  constructor(
    step: string,
    code: StepErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      retryAfterMs?: number;
      cause?: unknown;
      usage?: UsageRecord[];
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'StepError';
    this.step = step;
    this.code = code;
    this.retryable = options.retryable ?? (code === 'transport' || code === 'aborted');
    if (options.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs;
    this.usage = options.usage ?? [];
  }
}

export interface StepOutcome<K extends JobKind = JobKind> {
  /** Merged into `state.outputs[step]` by the server. */
  output: Json;
  usage: UsageRecord[];
  /** Present on the last step only. */
  result?: EngineResult[K];
}

export interface JobEngine {
  /** Validates and normalises a server-built input. Throws `StepError('input', 'invalid_input')`. */
  parseInput<K extends JobKind>(kind: K, input: unknown): JobInput[K];
  /** The next step, or null when the job is complete. May depend on earlier outputs (for example one step per planned section). */
  nextStep<K extends JobKind>(kind: K, input: JobInput[K], state: JobState): string | null;
  progress<K extends JobKind>(kind: K, input: JobInput[K], state: JobState): JobProgress;
  /** Runs exactly one step. Idempotent for the same `(input, state, step)`. */
  runStep<K extends JobKind>(
    call: { kind: K; input: JobInput[K]; state: JobState; step: string },
    deps: StepDeps,
  ): Promise<StepOutcome<K>>;
}

// ---------------------------------------------------------------------------------------------
// 6. The job row and the `ai-job` protocol
// ---------------------------------------------------------------------------------------------

export const JobError = z.object({
  code: z.string(),
  message: z.string(),
  step: z.string().optional(),
  retryable: z.boolean().optional(),
});
export type JobError = z.infer<typeof JobError>;

/**
 * What clients read from `ai_jobs` (column-level grant: `state` and `input` are not readable, so polling is
 * cheap). `result` is the stored result of the job kind.
 */
export const JobRow = z.object({
  id: Uuid,
  kind: JobKind,
  status: JobStatus,
  progress: z.object({
    done: z.array(z.string()),
    next: z.string().nullable(),
    total: z.number().int(),
  }),
  /** Non-null and in the future while a step is in flight. */
  lease_until: z.string().nullable(),
  /** Failed attempts of the current step. */
  attempts: z.number().int().nonnegative(),
  /** The last (possibly retryable) error, kept while the job is still running. */
  error: JobError.nullable(),
  result: z.custom<Json>().nullable(),
  unit_id: Uuid.nullable(),
  scheme_id: Uuid.nullable(),
  created_by: Uuid.nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  finished_at: z.string().nullable(),
});
export type JobRow = z.infer<typeof JobRow>;

export const MAX_STEP_ATTEMPTS = 3;
/** A step's lease; a step that is still running after this is presumed dead and may be re-run. */
export const STEP_LEASE_SECONDS = 150;

/** Request bodies of the `ai-job` edge function (POST, caller's JWT, admin at aal2). */
export const AiJobRequest = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    kind: JobKind,
    params: z.record(z.string(), z.unknown()),
    /** Same key + same caller = same job (a double click does not create two). */
    idempotency_key: z.string().min(8).max(100).optional(),
  }),
  z.object({ action: z.literal('step'), job_id: Uuid }),
  z.object({ action: z.literal('cancel'), job_id: Uuid }),
]);
export type AiJobRequest = z.infer<typeof AiJobRequest>;

/**
 * Success: `{ job }`. For `step`, HTTP 202 means the step was started in the background (poll the row);
 * 200 means nothing was started (terminal job, or a step already in flight: `busy: true`).
 */
export interface AiJobResponse {
  job: JobRow;
  busy?: boolean;
}

export const AI_JOB_ERROR_CODES = [
  'unauthenticated', // no/invalid JWT
  'forbidden', // not content staff
  'mfa_required', // aal1
  'kill_switch', // ai.kill_switch is on
  'budget_exceeded', // daily or per-job cap reached
  'invalid_request',
  'not_found',
  'conflict', // for example the unit changed since the job was created
  'internal',
] as const;
export type AiJobErrorCode = (typeof AI_JOB_ERROR_CODES)[number];

export interface AiJobErrorBody {
  error: { code: AiJobErrorCode; message: string };
}

/** The client-side port of the protocol. Live: the edge function plus a select on `ai_jobs`. Demo: in memory. */
export interface JobApi {
  create(kind: JobKind, params: Record<string, unknown>, idempotencyKey?: string): Promise<JobRow>;
  /** Starts the next step if none is in flight. Never waits for the step to finish. */
  step(jobId: string): Promise<AiJobResponse>;
  get(jobId: string): Promise<JobRow>;
  cancel(jobId: string): Promise<JobRow>;
}

/** Turns client params into a full engine input by reading the database. Server and demo backend implement it. */
export type JobInputResolver = <K extends JobKind>(
  kind: K,
  params: JobParams[K],
) => Promise<JobInput[K]>;
