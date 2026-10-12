// The `ai-job` edge function without the platform: a pure request handler with injected dependencies, so it is unit
// tested in Node with a fake database and a fake engine (ai-job-handler.test.ts). The Deno glue is
// supabase/functions/ai-job/index.ts.
//
// Protocol: AiJobRequest / AiJobResponse / AiJobErrorBody of packages/authoring-core/src/contract.ts, ADR 0007.
//
//   create  validate the params, build the engine input by reading the database AS THE CALLER (ai-job-context.ts),
//           let the engine validate it, insert the job with create_ai_job (caller's JWT). 201 { job }.
//   step    checks (finished? key set? kill switch? busy? budgets?), takes the lease with the service role, answers
//           202 { job } at once and runs ONE step in the background (waitUntil): the engine step, then
//           ai_job_complete_step / ai_job_fail_step (service role, only these RPCs). For unit jobs the last step
//           first saves the draft with create_unit_version_draft using the caller's JWT. 200 { job, busy? } when
//           nothing was started.
//   cancel  cancel_ai_job (caller's JWT). 200 { job }.
//
// Authorisation is the database's: the caller must be content staff at aal2. The handler reads the role and the
// `aal` claim only to give a precise error; every RPC checks them again.
//
// What may reach job.error: a fixed sentence per error code, the step name and the code. Never the engine's own
// message (it can quote a reply), a prompt, a key or a stack trace; those go to the logs, scrubbed and bounded.

import {
  AiJobHttpError,
  mapDbError,
  scrub,
  type AiJobErrorCode,
  type DbError,
} from './ai-job-errors.ts';
import { SCHEME_UPLOADS_BUCKET, createJobInputResolver } from './ai-job-context.ts';
import type {
  AiJobDeps,
  AiJobRequest,
  AiSettings,
  DbClient,
  JobKind,
  JobParamsMap,
  Json,
  Parser,
  StepOutcome,
  TokenClaims,
  UnitDraftOutput,
  UsageRecord,
} from './ai-job-types.ts';
import { TERMINAL_STATUSES } from './ai-job-types.ts';

export const MAX_BODY_CHARS = 600_000;
const CONTENT_STAFF = ['super_admin', 'content_editor', 'reviewer'] as const;
/** Every job ends in a write that only these roles may do (a draft, a scheme draft, a plan), so only they start one. */
const JOB_WRITERS = ['super_admin', 'content_editor'] as const;
/** The columns of ai_jobs a client may read (the table has column-level grants). */
export const JOB_COLUMNS =
  'id,kind,status,progress,lease_until,attempts,error,result,unit_id,scheme_id,created_by,created_at,updated_at,finished_at';
const STEP_SAFETY_SECONDS = 15;

type Row = Record<string, unknown>;
type Log = (event: string, detail: Record<string, unknown>) => void;

// --- CORS --------------------------------------------------------------------------------------------

const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const LOCALHOST = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/;

export function isAllowedOrigin(
  origin: string,
  allowed: readonly string[],
  allowLocalhost: boolean = true,
): boolean {
  if (allowed.includes(origin)) return true;
  return allowLocalhost && LOCALHOST.test(origin);
}

/**
 * Headers for a browser request: the origin is reflected only when it is on the allow-list (or localhost for
 * development), never `*`. `{}` for a request without an Origin (not a browser), `null` for a refused origin.
 */
export function corsHeadersFor(
  origin: string | null,
  options: Pick<AiJobDeps, 'allowedOrigins' | 'allowLocalhost'>,
): Record<string, string> | null {
  if (origin === null) return {};
  if (!isAllowedOrigin(origin, options.allowedOrigins, options.allowLocalhost ?? true)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '86400',
  };
}

// --- tokens ------------------------------------------------------------------------------------------

/** The claims of a JWT payload. The signature is NOT checked here: the platform did (verify_jwt) and PostgREST will. */
export function decodeJwtClaims(token: string): TokenClaims | null {
  const payload = token.split('.')[1];
  if (!payload) return null;
  try {
    const base64 = payload.replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, '='));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const claims = parsed as Record<string, unknown>;
    return {
      ...(typeof claims['sub'] === 'string' ? { sub: claims['sub'] } : {}),
      ...(typeof claims['role'] === 'string' ? { role: claims['role'] } : {}),
      ...(typeof claims['aal'] === 'string' ? { aal: claims['aal'] } : {}),
      ...(typeof claims['exp'] === 'number' ? { exp: claims['exp'] } : {}),
    };
  } catch {
    return null;
  }
}

// --- failures of a step --------------------------------------------------------------------------------

/** Fixed, safe sentences. The engine's own messages are never stored (they can quote a model reply). */
const STEP_MESSAGES: Record<string, string> = {
  refusal: 'The model declined to answer this step.',
  schema: "The model's answer did not match the expected format.",
  truncated: "The model's answer was cut off before it was finished.",
  transport: 'The model service could not be reached or is busy. Try again.',
  aborted: 'The step ran out of time.',
  invalid_input: 'The job input is not valid.',
  conflict:
    'The unit changed while the draft was being written. Open the latest version and try again.',
  internal: 'Something went wrong while running this step.',
};

/** A failure the handler itself raises inside a step (saving the draft, reading the upload). Message is safe. */
class StepFailure extends Error {
  readonly code: string;
  readonly retryable: boolean;
  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = 'StepFailure';
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ClassifiedFailure {
  code: string;
  message: string;
  retryable: boolean;
  step: string | undefined;
  /** Calls the failed step had already made (and been billed for). */
  usage: UsageRecord[];
  /** For the logs only: scrubbed and bounded. */
  detail: string;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Works on shapes, not classes: the engine may come from a separately bundled copy of the contract. */
export function classifyFailure(error: unknown): ClassifiedFailure {
  const detail = scrub(error instanceof Error ? `${error.name}: ${error.message}` : String(error));
  if (error instanceof StepFailure) {
    return {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      step: undefined,
      usage: [],
      detail,
    };
  }
  if (isRecord(error) || error instanceof Error) {
    const shape = error as unknown as Row;
    const name = shape['name'];
    const code = shape['code'];
    const usage = Array.isArray(shape['usage']) ? (shape['usage'] as UsageRecord[]) : [];
    if (
      (name === 'StepError' || name === 'LlmError' || name === 'LlmCallError') &&
      typeof code === 'string'
    ) {
      const known = code in STEP_MESSAGES;
      return {
        code: known ? code : 'internal',
        message: STEP_MESSAGES[known ? code : 'internal'] as string,
        retryable:
          typeof shape['retryable'] === 'boolean'
            ? shape['retryable']
            : code === 'transport' || code === 'aborted',
        step: typeof shape['step'] === 'string' ? shape['step'] : undefined,
        usage: name === 'StepError' ? usage : [],
        detail,
      };
    }
    if (name === 'AbortError' || name === 'TimeoutError') {
      return {
        code: 'aborted',
        message: STEP_MESSAGES['aborted'] as string,
        retryable: true,
        step: undefined,
        usage: [],
        detail,
      };
    }
  }
  return {
    code: 'internal',
    message: STEP_MESSAGES['internal'] as string,
    retryable: true,
    step: undefined,
    usage: [],
    detail,
  };
}

// --- the handler -----------------------------------------------------------------------------------------

interface Access {
  userId: string;
  role: string;
  claims: TokenClaims;
  db: DbClient;
}

export async function handleAiJob(req: Request, deps: AiJobDeps): Promise<Response> {
  const log: Log = deps.log ?? (() => {});
  const origin = req.headers.get('Origin');
  const cors = corsHeadersFor(origin, deps);
  if (cors === null) {
    return json(
      403,
      {
        error: {
          code: 'forbidden',
          message: 'This origin is not allowed to call the content engine.',
        },
      },
      {},
    );
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const requestId = deps.uuid();
  try {
    if (req.method !== 'POST') throw new AiJobHttpError('invalid_request', 'Use POST.', 405);
    const access = await authenticate(req, deps, log);
    const body = await readBody(req);
    const parsed = deps.core.AiJobRequest.safeParse(body);
    if (!parsed.success) throw invalidRequest('The request is not valid', parsed.error.issues);
    const request = parsed.data;

    switch (request.action) {
      case 'create':
        requireRole(access, JOB_WRITERS);
        return json(201, { job: await createJob(deps, access, request, log) }, cors);
      case 'step': {
        requireRole(access, JOB_WRITERS);
        const stepped = await stepJob(deps, access, request.job_id, log);
        return json(stepped.status, stepped.body, cors);
      }
      case 'cancel': {
        requireRole(access, CONTENT_STAFF);
        const cancelled = await access.db.rpc('cancel_ai_job', { p_job_id: request.job_id });
        if (cancelled.error) throw mapDbError(cancelled.error, log);
        return json(200, { job: cancelled.data }, cors);
      }
    }
  } catch (error) {
    if (error instanceof AiJobHttpError) {
      return json(error.status, { error: { code: error.code, message: error.message } }, cors);
    }
    log('unhandled_error', {
      requestId,
      detail: scrub(error instanceof Error ? error.message : String(error)),
    });
    return json(
      500,
      {
        error: {
          code: 'internal',
          message: 'The server could not complete the request. Try again.',
        },
      },
      cors,
    );
  }
  // unreachable: the switch above returns for every action
  throw new AiJobHttpError('invalid_request', 'Unknown action.');
}

function json(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

function invalidRequest(
  prefix: string,
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>,
): AiJobHttpError {
  const detail = issues
    .slice(0, 3)
    .map((issue) => `${issue.path.map(String).join('.') || '(request)'}: ${issue.message}`)
    .join('; ');
  return new AiJobHttpError(
    'invalid_request',
    detail === '' ? prefix : `${prefix} (${scrub(detail, 400)}).`,
  );
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS)
    throw new AiJobHttpError('invalid_request', 'The request body is too large.', 413);
  try {
    return JSON.parse(text);
  } catch {
    throw new AiJobHttpError('invalid_request', 'The request body is not valid JSON.');
  }
}

async function authenticate(req: Request, deps: AiJobDeps, log: Log): Promise<Access> {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new AiJobHttpError('unauthenticated', 'Sign in to use the content engine.');
  const claims = deps.claimsOf(match[1] as string);
  if (!claims || !claims.sub || claims.role !== 'authenticated') {
    throw new AiJobHttpError('unauthenticated', 'Sign in to use the content engine.');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= deps.now().getTime()) {
    throw new AiJobHttpError('unauthenticated', 'Your session has expired. Sign in again.');
  }
  if (claims.aal !== 'aal2') {
    throw new AiJobHttpError(
      'mfa_required',
      'Confirm your sign-in with your authenticator app to use the content engine.',
    );
  }
  const db = deps.userDb(req);
  const found = await db.from('admin_users').select('role').eq('user_id', claims.sub).maybeSingle();
  if (found.error) throw mapDbError(found.error, log);
  const role = found.data?.['role'];
  if (typeof role !== 'string' || !(CONTENT_STAFF as readonly string[]).includes(role)) {
    throw new AiJobHttpError('forbidden', 'Only content staff can use the content engine.');
  }
  return { userId: claims.sub, role, claims, db };
}

function requireRole(access: Access, allowed: readonly string[]): void {
  if (!allowed.includes(access.role)) {
    throw new AiJobHttpError(
      'forbidden',
      'Your role cannot do this. Ask a super admin for the content editor role.',
    );
  }
}

// --- create ----------------------------------------------------------------------------------------------

function paramsParser(deps: AiJobDeps, kind: JobKind): Parser<JobParamsMap[JobKind]> {
  switch (kind) {
    case 'scheme_ingest':
      return deps.core.SchemeIngestParams as Parser<JobParamsMap[JobKind]>;
    case 'chapter_plan':
      return deps.core.ChapterPlanParams as Parser<JobParamsMap[JobKind]>;
    case 'unit_generate':
      return deps.core.UnitGenerateParams as Parser<JobParamsMap[JobKind]>;
    case 'unit_revise':
      return deps.core.UnitReviseParams as Parser<JobParamsMap[JobKind]>;
  }
}

/** The params as stored on the row (debugging only): the bulky text of an ingest is replaced by its length. */
function storedParams(kind: JobKind, params: JobParamsMap[JobKind]): Json {
  if (kind === 'scheme_ingest') {
    const ingest = params as JobParamsMap['scheme_ingest'];
    if (ingest.source.type === 'text') {
      return {
        ...(ingest as unknown as Record<string, Json>),
        source: {
          type: 'text',
          filename: ingest.source.filename,
          characters: (ingest.source.text ?? '').length,
        },
      };
    }
  }
  return params as unknown as Json;
}

type CreateRequest = Extract<AiJobRequest, { action: 'create' }>;

async function createJob(
  deps: AiJobDeps,
  access: Access,
  request: CreateRequest,
  log: Log,
): Promise<unknown> {
  const parsed = paramsParser(deps, request.kind).safeParse(request.params);
  if (!parsed.success)
    throw invalidRequest(`The ${request.kind} request is not valid`, parsed.error.issues);

  const resolver = createJobInputResolver({
    db: access.db,
    userId: access.userId,
    core: deps.core,
    log,
  });
  const resolved = await resolver.resolve(request.kind, parsed.data as never);

  let input: unknown;
  try {
    input = deps.engine.parseInput(request.kind, resolved.input);
  } catch (error) {
    const reason = error instanceof Error ? scrub(error.message, 400) : 'the input does not fit';
    throw new AiJobHttpError('invalid_request', `The job could not be set up: ${reason}`);
  }

  const created = await access.db.rpc('create_ai_job', {
    p_kind: request.kind,
    p_params: storedParams(request.kind, parsed.data),
    p_input: input,
    p_unit_id: resolved.unitId,
    p_scheme_id: resolved.schemeId,
    p_idempotency_key: request.idempotency_key ?? null,
  });
  if (created.error) throw mapDbError(created.error, log);
  return created.data;
}

// --- step ------------------------------------------------------------------------------------------------

interface Lease {
  job: Row;
  kind: JobKind;
  input: unknown;
  state: { outputs: Record<string, Json> };
  leaseToken: string;
}

async function stepJob(
  deps: AiJobDeps,
  access: Access,
  jobId: string,
  log: Log,
): Promise<{ status: number; body: unknown }> {
  const found = await access.db.from('ai_jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle();
  if (found.error) throw mapDbError(found.error, log);
  const job = found.data;
  if (!job) throw new AiJobHttpError('not_found', 'That job does not exist, or you cannot see it.');
  if (job['created_by'] !== access.userId) {
    throw new AiJobHttpError('forbidden', 'Only the person who started a job can run its steps.');
  }
  if ((TERMINAL_STATUSES as readonly string[]).includes(String(job['status']))) {
    return { status: 200, body: { job } };
  }

  // Not having a key is a problem of the project, not of the job: nothing is leased and no attempt is used, so
  // the same job continues as soon as the secret is set.
  if (!deps.hasAnthropicKey()) {
    throw new AiJobHttpError('internal', 'ANTHROPIC_API_KEY is not set for this project');
  }

  const settingsResult = await access.db.rpc('get_ai_settings');
  if (settingsResult.error) throw mapDbError(settingsResult.error, log);
  const settingsParsed = deps.core.AiSettings.safeParse(settingsResult.data);
  if (!settingsParsed.success) {
    log('settings_invalid', {
      issues: scrub(JSON.stringify(settingsParsed.error.issues.slice(0, 3))),
    });
    throw new AiJobHttpError(
      'internal',
      'The AI settings are not valid. Check them on the Usage screen.',
    );
  }
  const settings = settingsParsed.data;
  if (settings.kill_switch) {
    throw new AiJobHttpError('kill_switch', 'AI drafting is switched off (ai.kill_switch).');
  }

  const now = deps.now().getTime();
  const leaseUntil =
    typeof job['lease_until'] === 'string' ? Date.parse(job['lease_until']) : Number.NaN;
  if (!Number.isNaN(leaseUntil) && leaseUntil > now)
    return { status: 200, body: { job, busy: true } };

  const service = deps.serviceDb();
  await assertBudget(service, jobId, log);

  const leased = await service.rpc('ai_job_acquire_lease', {
    p_job_id: jobId,
    p_lease_seconds: deps.core.STEP_LEASE_SECONDS,
  });
  if (leased.error) throw mapDbError(leased.error, log);
  const lease = parseLease(leased.data);
  if (lease.kind === 'not_acquired') {
    return { status: 200, body: lease.busy ? { job: lease.job, busy: true } : { job: lease.job } };
  }

  // From here the job holds a lease: whatever happens next is reported through the lease token.
  const step = nextStepOf(deps, lease, log);
  if (step.kind === 'failed') {
    await failStep(service, lease.value, 'next_step', step.failure, log);
    const after = await access.db.from('ai_jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle();
    return { status: 200, body: { job: after.data ?? lease.value.job } };
  }

  deps.waitUntil(
    runStepInBackground(deps, access, service, settings, lease.value, step.step, log).catch(
      (error: unknown) => {
        log('step_runner_crashed', {
          jobId,
          detail: scrub(error instanceof Error ? error.message : String(error)),
        });
      },
    ),
  );
  return { status: 202, body: { job: lease.value.job } };
}

async function assertBudget(service: DbClient, jobId: string, log: Log): Promise<void> {
  const checked = await service.rpc('ai_job_budget_check', { p_job_id: jobId });
  if (checked.error) throw mapDbError(checked.error, log);
  const budget = isRecord(checked.data) ? checked.data : {};
  if (budget['kill_switch'] === true) {
    throw new AiJobHttpError('kill_switch', 'AI drafting is switched off (ai.kill_switch).');
  }
  const num = (value: unknown): number | null => (typeof value === 'number' ? value : null);
  const jobCap = num(budget['max_usd_per_job']);
  const jobCost = num(budget['job_cost_usd']) ?? 0;
  if (jobCap !== null && jobCost >= jobCap) {
    throw new AiJobHttpError(
      'budget_exceeded',
      `This job has used its budget of $${jobCap} ($${jobCost.toFixed(4)} spent). Raise the cap on the Usage screen or cancel the job.`,
    );
  }
  const dayCap = num(budget['daily_usd_cap']);
  const dayCost = num(budget['day_cost_usd']) ?? 0;
  if (dayCap !== null && dayCost >= dayCap) {
    throw new AiJobHttpError(
      'budget_exceeded',
      `Today's AI budget of $${dayCap} is used up ($${dayCost.toFixed(4)} spent). It resets at midnight UTC.`,
    );
  }
}

type LeaseResult =
  { kind: 'not_acquired'; busy: boolean; job: unknown } | { kind: 'acquired'; value: Lease };

function parseLease(data: unknown): LeaseResult {
  if (!isRecord(data) || !isRecord(data['job'])) {
    throw new AiJobHttpError('internal', 'The server could not take the lease. Try again.');
  }
  if (data['acquired'] !== true) {
    return { kind: 'not_acquired', busy: data['reason'] === 'busy', job: data['job'] };
  }
  const state =
    isRecord(data['state']) && isRecord(data['state']['outputs'])
      ? (data['state']['outputs'] as Record<string, Json>)
      : {};
  if (typeof data['lease_token'] !== 'string' || typeof data['kind'] !== 'string') {
    throw new AiJobHttpError('internal', 'The server could not take the lease. Try again.');
  }
  return {
    kind: 'acquired',
    value: {
      job: data['job'],
      kind: data['kind'] as JobKind,
      input: data['input'],
      state: { outputs: state },
      leaseToken: data['lease_token'],
    },
  };
}

function nextStepOf(
  deps: AiJobDeps,
  lease: { value: Lease },
  log: Log,
): { kind: 'step'; step: string } | { kind: 'failed'; failure: ClassifiedFailure } {
  try {
    const input = deps.engine.parseInput(lease.value.kind, lease.value.input);
    lease.value.input = input;
    const step = deps.engine.nextStep(lease.value.kind, input as never, lease.value.state);
    if (step === null) {
      return {
        kind: 'failed',
        failure: {
          code: 'internal',
          message: 'The engine has no step left but the job is not finished.',
          retryable: false,
          step: undefined,
          usage: [],
          detail: '',
        },
      };
    }
    return { kind: 'step', step };
  } catch (error) {
    const failure = classifyFailure(error);
    log('next_step_failed', { code: failure.code, detail: failure.detail });
    return { kind: 'failed', failure: { ...failure, retryable: false } };
  }
}

async function failStep(
  service: DbClient,
  lease: Lease,
  step: string,
  failure: ClassifiedFailure,
  log: Log,
): Promise<void> {
  const reported = await service.rpc('ai_job_fail_step', {
    p_job_id: lease.job['id'],
    p_lease_token: lease.leaseToken,
    p_step: failure.step ?? step,
    p_error: { code: failure.code, message: failure.message },
    p_retryable: failure.retryable,
    p_usage: failure.usage,
  });
  if (reported.error) {
    // The lease simply expires and the step is retried; the attempt cap bounds it.
    log('fail_step_rpc_failed', {
      jobId: lease.job['id'],
      code: reported.error.code ?? null,
      detail: scrub(reported.error.message ?? ''),
    });
  }
}

async function runStepInBackground(
  deps: AiJobDeps,
  access: Access,
  service: DbClient,
  settings: AiSettings,
  lease: Lease,
  step: string,
  log: Log,
): Promise<void> {
  const jobId = String(lease.job['id']);
  let billed: UsageRecord[] = [];
  try {
    const timeoutMs =
      deps.stepTimeoutMs ?? (deps.core.STEP_LEASE_SECONDS - STEP_SAFETY_SECONDS) * 1000;
    const outcome: StepOutcome = await deps.engine.runStep(
      { kind: lease.kind, input: lease.input as never, state: lease.state, step },
      {
        llm: deps.createLlm(settings),
        settings,
        loadUpload: (path) => loadUpload(access, path),
        now: () => deps.now(),
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    billed = outcome.usage ?? [];

    const state = { outputs: { ...lease.state.outputs, [step]: outcome.output } };
    const progress = deps.engine.progress(lease.kind, lease.input as never, state);
    const finished =
      outcome.result !== undefined ||
      deps.engine.nextStep(lease.kind, lease.input as never, state) === null;

    let result: Json | null = null;
    if (finished) {
      if (outcome.result === undefined) {
        throw new StepFailure('internal', 'The last step returned no result.', false);
      }
      result = await storeResult(deps, access, lease, outcome, settings, log);
    }

    const completed = await service.rpc('ai_job_complete_step', {
      p_job_id: jobId,
      p_lease_token: lease.leaseToken,
      p_step: step,
      p_output: outcome.output,
      p_usage: billed,
      p_progress: progress,
      p_result: result,
    });
    if (completed.error) {
      log('complete_step_rpc_failed', {
        jobId,
        step,
        code: completed.error.code ?? null,
        detail: scrub(completed.error.message ?? ''),
      });
    } else if (completed.data === false) {
      log('step_output_discarded', { jobId, step });
    }
  } catch (error) {
    const failure = classifyFailure(error);
    if (failure.usage.length === 0) failure.usage = billed;
    log('step_failed', {
      jobId,
      step,
      code: failure.code,
      retryable: failure.retryable,
      detail: failure.detail,
    });
    await failStep(service, lease, step, failure, log);
  }
}

/** What the job row keeps as `result`. Scheme and plan drafts stay in the row; a unit draft is saved first. */
async function storeResult(
  deps: AiJobDeps,
  access: Access,
  lease: Lease,
  outcome: StepOutcome,
  settings: AiSettings,
  log: Log,
): Promise<Json> {
  if (lease.kind === 'scheme_ingest' || lease.kind === 'chapter_plan')
    return outcome.result as Json;

  const draft = outcome.result as UnitDraftOutput;
  const input = lease.input as {
    unit?: { id: string };
    unit_id?: string;
    base_version_id?: string;
  };
  const unitId = lease.kind === 'unit_generate' ? input.unit?.id : input.unit_id;
  if (typeof unitId !== 'string')
    throw new StepFailure('internal', STEP_MESSAGES['internal'] as string, false);

  let baseId: string | null;
  if (lease.kind === 'unit_revise') {
    baseId = input.base_version_id ?? null;
  } else {
    const latest = await access.db
      .from('unit_versions')
      .select('id')
      .eq('unit_id', unitId)
      .order('version', { ascending: false })
      .limit(1);
    if (latest.error) throw dbFailure(latest.error, log);
    const first = latest.data?.[0];
    baseId = first && typeof first['id'] === 'string' ? first['id'] : null;
  }

  const saved = await access.db.rpc('create_unit_version_draft', {
    p_unit_id: unitId,
    p_content: draft.content,
    p_lint_report: {
      errors: draft.lint.errors,
      warnings: draft.lint.warnings,
      ok: draft.lint.ok,
      review: draft.review,
      summary: draft.summary,
    },
    p_generated_by: 'ai',
    p_model: modelOf(outcome.usage ?? [], settings),
    p_prompt_version: settings.prompt_version,
    p_base_version_id: baseId,
  });
  if (saved.error) throw dbFailure(saved.error, log);
  const version = isRecord(saved.data) ? saved.data : {};
  if (typeof version['id'] !== 'string' || typeof version['version'] !== 'number') {
    throw new StepFailure('internal', STEP_MESSAGES['internal'] as string, true);
  }
  return {
    unit_version_id: version['id'],
    version: version['version'],
    lint: {
      errors: draft.lint.errors.length,
      warnings: draft.lint.warnings.length,
      ok: draft.lint.ok,
    },
    review: draft.review,
    summary: draft.summary,
    ...(draft.changed ? { changed: draft.changed } : {}),
  };
}

/** A database error while saving the draft: a stale base is a conflict (not retried), anything else is. */
function dbFailure(error: DbError, log: Log): StepFailure {
  if (error.message === 'stale_base') {
    return new StepFailure('conflict', STEP_MESSAGES['conflict'] as string, false);
  }
  if (error.message === 'admin_role_required' || error.message === 'unit_not_editable') {
    return new StepFailure('forbidden', 'The draft could not be saved with your account.', false);
  }
  log('save_draft_failed', { code: error.code ?? null, detail: scrub(error.message ?? '') });
  return new StepFailure('internal', STEP_MESSAGES['internal'] as string, true);
}

/** The model that did the authoring (the last authoring call), else the last call, else the configured one. */
function modelOf(usage: UsageRecord[], settings: AiSettings): string {
  const authoring = [...usage].reverse().find((record) => record.task === 'authoring');
  return authoring?.model ?? usage[usage.length - 1]?.model ?? settings.models.authoring;
}

const MIME_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  txt: 'text/plain',
};

/** Reads an upload with the CALLER's storage client, so the bucket policy (own prefix, aal2) decides. */
async function loadUpload(
  access: Access,
  path: string,
): Promise<{ bytes: Uint8Array; mime: string }> {
  const parts = path.split('/');
  if (
    parts[0] !== access.userId ||
    parts.length < 2 ||
    parts.some((part) => part === '' || part === '..')
  ) {
    throw new StepFailure('invalid_input', STEP_MESSAGES['invalid_input'] as string, false);
  }
  const downloaded = await access.db.storage.from(SCHEME_UPLOADS_BUCKET).download(path);
  if (downloaded.error || !downloaded.data) {
    throw new StepFailure('transport', 'The uploaded file could not be read. Try again.', true);
  }
  const extension = (parts[parts.length - 1] as string).split('.').pop()?.toLowerCase() ?? '';
  return {
    bytes: new Uint8Array(await downloaded.data.arrayBuffer()),
    mime: downloaded.data.type || MIME_BY_EXTENSION[extension] || 'application/octet-stream',
  };
}

export type { AiJobErrorCode };
