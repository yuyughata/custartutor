// The `tutor-chat` edge function without the platform: a pure request handler with injected dependencies, so it is unit
// tested in Node with a fake database and a fake (or the real, scripted) pipeline. The Deno glue is
// supabase/functions/tutor-chat/index.ts.
//
// Protocol: TutorRequest / TutorStreamEvent / TutorErrorBody of packages/tutor-core/src/contract.ts, ADR 0008.
//
//   fetch_turn  200 { result: TutorTurnResult | null } (the stored turn, or null when there is none)
//   turn        the GATES, in this order, each failing with a typed error BEFORE any model is called:
//                 1 JWT                       401 unauthenticated
//                 2 the body                  400 invalid_request
//                 3 the child is the caller's 403 forbidden (a guardian of its household; the same answer for a child that
//                                              does not exist, so the id of somebody else's child is never confirmed)
//                 4 tutor.enabled             503 tutor_disabled   (the database says false without a confirmed owner)
//                 5 ai.kill_switch            503 kill_switch
//                 6 consent for ai_tutor      403 consent_required (current version only)
//                 -- a turn that is already stored is REPLAYED here, for free: no budget, no model --
//                 7 the unit is published     404 unit_not_found   (the requested version if readable, else the current one)
//                 8 the key is configured     500 internal
//                 9 the daily budget          429 daily_limit      (tutor_reserve_turn, once per client_turn_id)
//                10 one turn in flight        409 busy             (tutor_open_session)
//               then 200 text/event-stream, and the turn runs inside waitUntil.
//
// THE STREAM. `data: <json>\n\n` per event, `: keep-alive` comments while the classifier holds the tutor's tokens back.
// The handler writes `meta` first, forwards what the pipeline emits (every event is parsed again with the contract's
// TutorStreamEvent, so no unknown field can leak), and sends `done` only AFTER the turn is stored, so a client that
// reacts to `done` by calling fetch_turn always finds it. The turn is persisted whether or not the client is still there.
//
// PRIVACY. The child's raw text is passed to the pipeline once, in memory, and nowhere else: it never reaches an RPC
// argument, a log line, an error or an event. What is stored is `outcome.child_text_redacted` and nothing else.
// Nothing in this file prints: `log` is the only output and it is never given message text.

import { TutorHttpError, mapDbError, scrub, type TutorErrorCode } from './tutor-chat-errors.ts';
import { createTutorContextReader } from './tutor-chat-context.ts';
import type {
  DbClient,
  FetchTurnRequest,
  PreparedUnit,
  SafetyAction,
  SafetyDecision,
  TokenClaims,
  TurnRequest,
  TurnStatus,
  TutorChatDeps,
  TutorSettings,
  TutorStreamEvent,
  TutorTurnInput,
  TutorTurnOutcome,
  TutorTurnRun,
} from './tutor-chat-types.ts';

export const MAX_BODY_CHARS = 16_384;
const DEFAULT_KEEP_ALIVE_MS = 15_000;
const DEFAULT_TURN_TIMEOUT_MS = 140_000;
const DEFAULT_LEASE_SECONDS = 180;
/** Stored in place of a child message that could not be redacted by the pipeline (it crashed): never the raw text. */
export const NOT_SAVED_TEXT = '[message not saved]';

type Row = Record<string, unknown>;
type Log = (event: string, detail: Record<string, unknown>) => void;

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const TURN_STATUSES: readonly string[] = ['complete', 'replaced', 'blocked', 'safe_reply', 'failed'];
const SAFETY_ACTIONS: readonly string[] = ['allow', 'steer', 'redirect', 'blocked', 'safe_reply'];

// --- CORS --------------------------------------------------------------------------------------------

const ALLOW_HEADERS = 'authorization, x-client-info, apikey, content-type';
const EXPOSE_HEADERS = 'X-Tutor-Grounding-Version, X-Tutor-Grounding-Fallback';
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
 * development), never `*`. `{}` for a request without an Origin (a native app: not a browser), `null` for a refused
 * origin.
 */
export function corsHeadersFor(
  origin: string | null,
  options: Pick<TutorChatDeps, 'allowedOrigins' | 'allowLocalhost'>,
): Record<string, string> | null {
  if (origin === null) return {};
  if (!isAllowedOrigin(origin, options.allowedOrigins, options.allowLocalhost ?? true)) return null;
  return {
    'Access-Control-Allow-Origin': origin,
    Vary: 'Origin',
    'Access-Control-Allow-Headers': ALLOW_HEADERS,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Expose-Headers': EXPOSE_HEADERS,
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

// --- responses ---------------------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown, headers: Record<string, string>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...headers, 'Content-Type': 'application/json' },
  });
}

/** `TutorErrorBody` with its status. */
function errorResponse(error: TutorHttpError, headers: Record<string, string>): Response {
  return jsonResponse(
    error.status,
    { error: { code: error.code, message: error.message, retryable: error.retryable } },
    headers,
  );
}

const encoder = new TextEncoder();

/** One SSE frame. */
export function sseFrame(event: TutorStreamEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

const KEEP_ALIVE_FRAME = ': keep-alive\n\n';

function sseHeaders(cors: Record<string, string>, extra: Record<string, string> = {}): Record<string, string> {
  return {
    ...cors,
    ...extra,
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  };
}

// --- request reading -----------------------------------------------------------------------------------

function authenticate(req: Request, deps: TutorChatDeps): { userId: string } {
  const header = req.headers.get('Authorization') ?? '';
  const match = /^Bearer\s+(\S+)$/i.exec(header);
  if (!match) throw new TutorHttpError('unauthenticated');
  const claims = deps.claimsOf(match[1] as string);
  if (!claims || !claims.sub || claims.role !== 'authenticated') {
    throw new TutorHttpError('unauthenticated');
  }
  if (typeof claims.exp === 'number' && claims.exp * 1000 <= deps.now().getTime()) {
    throw new TutorHttpError('unauthenticated', 'Your session has expired. Sign in again.');
  }
  return { userId: claims.sub };
}

async function readBody(req: Request): Promise<unknown> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) {
    throw new TutorHttpError('invalid_request', 'The request body is too large.', 413);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new TutorHttpError('invalid_request', 'The request body is not valid JSON.');
  }
}

/** Names the fields at fault, never their values (a value can be a child's words). */
function invalidRequest(
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey> }>,
): TutorHttpError {
  const fields = [
    ...new Set(issues.slice(0, 3).map((issue) => issue.path.map(String).join('.') || '(request)')),
  ];
  return new TutorHttpError(
    'invalid_request',
    `The request is not valid (${scrub(fields.join(', '), 120)}).`,
  );
}

// --- stored turns -----------------------------------------------------------------------------------------

interface StoredTurn {
  session_id: string;
  message_id: string;
  status: TurnStatus;
  reply: string | null;
  safety_action: SafetyAction;
  show_activity: { question_id: string } | null;
}

/** The row `tutor_get_turn` / `tutor_save_turn` returns, checked; anything else is our bug (500), never passed on. */
function parseStoredTurn(data: unknown, log: Log): StoredTurn | null {
  if (data === null || data === undefined) return null;
  if (
    !isRecord(data) ||
    typeof data['session_id'] !== 'string' ||
    typeof data['message_id'] !== 'string' ||
    typeof data['status'] !== 'string' ||
    !TURN_STATUSES.includes(data['status']) ||
    !(data['reply'] === null || typeof data['reply'] === 'string') ||
    typeof data['safety_action'] !== 'string' ||
    !SAFETY_ACTIONS.includes(data['safety_action'])
  ) {
    log('stored_turn_invalid', {});
    throw new TutorHttpError('internal');
  }
  const activity = data['show_activity'];
  return {
    session_id: data['session_id'],
    message_id: data['message_id'],
    status: data['status'] as TurnStatus,
    reply: data['reply'],
    safety_action: data['safety_action'] as SafetyAction,
    show_activity:
      isRecord(activity) && typeof activity['question_id'] === 'string'
        ? { question_id: activity['question_id'] }
        : null,
  };
}

/** The stored turn as the stream it would have been: what a retry receives. Nothing is bought, no model is called. */
function replayResponse(stored: StoredTurn, cors: Record<string, string>): Response {
  const events: TutorStreamEvent[] = [
    { type: 'meta', session_id: stored.session_id, message_id: stored.message_id },
  ];
  if (stored.status === 'failed' || stored.reply === null) {
    events.push({ type: 'error', code: 'upstream', retryable: true });
  } else {
    if (stored.safety_action !== 'allow') events.push({ type: 'safety', action: stored.safety_action });
    events.push({ type: 'delta', text: stored.reply });
    if (stored.show_activity) {
      events.push({ type: 'tool', name: 'show_activity', input: stored.show_activity });
    }
    events.push({ type: 'done', message_id: stored.message_id });
  }
  return new Response(events.map(sseFrame).join(''), { status: 200, headers: sseHeaders(cors) });
}

// --- the handler -------------------------------------------------------------------------------------------

export async function handleTutorChat(req: Request, deps: TutorChatDeps): Promise<Response> {
  const log: Log = deps.log ?? (() => {});
  const origin = req.headers.get('Origin');
  const cors = corsHeadersFor(origin, deps);
  if (cors === null) {
    return errorResponse(new TutorHttpError('forbidden', 'This origin is not allowed.'), {});
  }
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

  const requestId = deps.uuid();
  try {
    if (req.method !== 'POST') throw new TutorHttpError('invalid_request', 'Use POST.', 405);
    const access = authenticate(req, deps);
    const body = await readBody(req);
    const parsed = deps.core.TutorRequest.safeParse(body);
    if (!parsed.success) throw invalidRequest(parsed.error.issues);
    const db = deps.userDb(req);
    const request = parsed.data;
    if (request.action === 'fetch_turn') {
      return await fetchTurn(deps, db, access.userId, request, cors, log);
    }
    return await startTurn(deps, db, access.userId, request, cors, log, requestId);
  } catch (error) {
    if (error instanceof TutorHttpError) return errorResponse(error, cors);
    // never the message of an unexpected error: it may quote what the child wrote
    log('unhandled_error', { requestId, name: error instanceof Error ? error.name : typeof error });
    return errorResponse(new TutorHttpError('internal'), cors);
  }
}

async function fetchTurn(
  deps: TutorChatDeps,
  db: DbClient,
  userId: string,
  request: FetchTurnRequest,
  cors: Record<string, string>,
  log: Log,
): Promise<Response> {
  const reader = createTutorContextReader({ db, userId, castTraits: deps.castTraits, log });
  await reader.child(request.child_id);
  const fetched = await deps.serviceDb().rpc('tutor_get_turn', {
    p_child_id: request.child_id,
    p_client_turn_id: request.client_turn_id,
  });
  if (fetched.error) throw mapDbError(fetched.error, log);
  return jsonResponse(200, { result: parseStoredTurn(fetched.data, log) }, cors);
}

interface AiSettingsShape {
  killSwitch: boolean;
  models: { authoring: string; tutor: string; moderation: string };
}

async function loadSettings(
  service: DbClient,
  deps: TutorChatDeps,
  log: Log,
): Promise<{ settings: TutorSettings; ai: AiSettingsShape }> {
  const [tutor, ai] = await Promise.all([
    service.rpc('tutor_get_settings'),
    service.rpc('tutor_get_ai_settings'),
  ]);
  if (tutor.error) throw mapDbError(tutor.error, log);
  if (ai.error) throw mapDbError(ai.error, log);
  const settings = deps.core.TutorSettings.safeParse(tutor.data);
  if (!settings.success) {
    log('settings_invalid', {
      fields: scrub(
        settings.error.issues
          .slice(0, 3)
          .map((issue) => issue.path.map(String).join('.'))
          .join(','),
        120,
      ),
    });
    throw new TutorHttpError('internal');
  }
  const models = isRecord(ai.data) ? ai.data['models'] : null;
  if (
    !isRecord(ai.data) ||
    !isRecord(models) ||
    typeof models['tutor'] !== 'string' ||
    typeof models['moderation'] !== 'string' ||
    typeof ai.data['kill_switch'] !== 'boolean'
  ) {
    log('ai_settings_invalid', {});
    throw new TutorHttpError('internal');
  }
  return {
    settings: settings.data,
    ai: {
      killSwitch: ai.data['kill_switch'],
      models: {
        authoring: typeof models['authoring'] === 'string' ? models['authoring'] : models['tutor'],
        tutor: models['tutor'],
        moderation: models['moderation'],
      },
    },
  };
}

/** Consent is current only for the exact version the code and the database both require. */
async function requireConsent(
  db: DbClient,
  deps: TutorChatDeps,
  childId: string,
  log: Log,
): Promise<void> {
  const consent = await db.rpc('get_tutor_consent', { p_child_id: childId });
  if (consent.error) throw mapDbError(consent.error, log);
  const state = consent.data;
  const required = deps.core.CURRENT_TUTOR_CONSENT_VERSION;
  if (
    !isRecord(state) ||
    state['granted'] !== true ||
    state['version'] !== required ||
    state['required_version'] !== required
  ) {
    throw new TutorHttpError('consent_required');
  }
}

interface OpenedSession {
  sessionId: string;
  busy: boolean;
  stored: boolean;
  history: Array<{ role: 'child' | 'tutor'; text: string }>;
}

function parseOpenedSession(data: unknown, log: Log): OpenedSession {
  if (
    !isRecord(data) ||
    typeof data['session_id'] !== 'string' ||
    typeof data['busy'] !== 'boolean' ||
    typeof data['stored'] !== 'boolean'
  ) {
    log('open_session_invalid', {});
    throw new TutorHttpError('internal');
  }
  const history: OpenedSession['history'] = [];
  if (Array.isArray(data['history'])) {
    for (const item of data['history']) {
      if (
        isRecord(item) &&
        (item['role'] === 'child' || item['role'] === 'tutor') &&
        typeof item['text'] === 'string'
      ) {
        history.push({ role: item['role'], text: item['text'] });
      }
    }
  }
  return { sessionId: data['session_id'], busy: data['busy'], stored: data['stored'], history };
}

async function startTurn(
  deps: TutorChatDeps,
  db: DbClient,
  userId: string,
  request: TurnRequest,
  cors: Record<string, string>,
  log: Log,
  requestId: string,
): Promise<Response> {
  const reader = createTutorContextReader({ db, userId, castTraits: deps.castTraits, log });
  const child = await reader.child(request.child_id);
  const service = deps.serviceDb();

  // the gates that switch the tutor off, before anything costs anything
  const { settings, ai } = await loadSettings(service, deps, log);
  if (!settings.enabled) throw new TutorHttpError('tutor_disabled');
  if (ai.killSwitch) throw new TutorHttpError('kill_switch');
  await requireConsent(db, deps, request.child_id, log);

  // a turn that is already stored is replayed: it costs nothing and calls nothing
  const already = await service.rpc('tutor_get_turn', {
    p_child_id: request.child_id,
    p_client_turn_id: request.client_turn_id,
  });
  if (already.error) throw mapDbError(already.error, log);
  const storedBefore = parseStoredTurn(already.data, log);
  if (storedBefore) return replayResponse(storedBefore, cors);

  // everything that can fail without a side effect is read and checked before the budget is touched
  const unit = await reader.unit(request.unit_id, request.version_no);
  const subjectName = await reader.subjectName(unit.subjectSlug);
  let prepared: PreparedUnit;
  try {
    prepared = deps.prepareUnit({
      content: unit.content,
      unitId: request.unit_id,
      versionNo: unit.versionNo,
      subjectName,
    });
  } catch {
    log('unit_content_invalid', { unitId: request.unit_id, versionNo: unit.versionNo });
    throw new TutorHttpError('internal');
  }
  const [stage, cast, knownNames] = await Promise.all([
    reader.stage(child.levelCode),
    reader.cast(),
    reader.knownNames(child.householdId),
  ]);
  if (!deps.hasAnthropicKey()) {
    log('anthropic_key_missing', { requestId });
    throw new TutorHttpError('internal');
  }

  // the budget: one count per client turn id, then the single in-flight slot of the session
  const reserved = await service.rpc('tutor_reserve_turn', {
    p_child_id: request.child_id,
    p_limit: settings.daily_turns_per_child,
    p_client_turn_id: request.client_turn_id,
  });
  if (reserved.error) throw mapDbError(reserved.error, log);
  if (!isRecord(reserved.data) || typeof reserved.data['allowed'] !== 'boolean') {
    log('reserve_invalid', {});
    throw new TutorHttpError('internal');
  }
  if (!reserved.data['allowed']) throw new TutorHttpError('daily_limit');

  const opened = await service.rpc('tutor_open_session', {
    p_child_id: request.child_id,
    p_session_id: request.session_id ?? null,
    p_unit_id: request.unit_id,
    p_version_no: unit.versionNo,
    p_client_turn_id: request.client_turn_id,
    p_history_turns: settings.max_history_turns,
    p_lease_seconds: deps.leaseSeconds ?? DEFAULT_LEASE_SECONDS,
  });
  if (opened.error) throw mapDbError(opened.error, log);
  const session = parseOpenedSession(opened.data, log);
  if (session.stored) {
    // the first submit finished between the lookup above and now
    const again = await service.rpc('tutor_get_turn', {
      p_child_id: request.child_id,
      p_client_turn_id: request.client_turn_id,
    });
    if (again.error) throw mapDbError(again.error, log);
    const storedNow = parseStoredTurn(again.data, log);
    if (storedNow) return replayResponse(storedNow, cors);
    throw new TutorHttpError('busy');
  }
  if (session.busy) throw new TutorHttpError('busy');

  // from here the turn holds the session's in-flight slot: nothing below may throw before the pump starts
  const messageId = deps.uuid();
  const input: TutorTurnInput = {
    child: {
      alias: child.alias,
      level_code: child.levelCode,
      stage,
      reading_mode: child.readingMode,
    },
    grounding: prepared.grounding,
    position: {
      ...(request.section_id !== undefined ? { section_id: request.section_id } : {}),
      ...(request.question_id !== undefined ? { question_id: request.question_id } : {}),
    },
    history: session.history,
    message: { mode: request.input.mode, text: request.input.text },
    helper_present: request.helper_present,
    cast,
    known_names: knownNames,
    ids: { session_id: session.sessionId, message_id: messageId },
    mastery_guard: prepared.masteryGuard,
  };

  return streamTurn({
    deps,
    service,
    cors,
    log,
    requestId,
    request,
    settings,
    models: ai.models,
    input,
    sessionId: session.sessionId,
    messageId,
    groundingVersion: unit.versionNo,
    groundingFallback: unit.fallback,
  });
}

// --- the stream and the persistence -------------------------------------------------------------------------

interface StreamTurnArgs {
  deps: TutorChatDeps;
  service: DbClient;
  cors: Record<string, string>;
  log: Log;
  requestId: string;
  request: TurnRequest;
  settings: TutorSettings;
  models: AiSettingsShape['models'];
  input: TutorTurnInput;
  sessionId: string;
  messageId: string;
  groundingVersion: number;
  groundingFallback: boolean;
}

const ALLOW_DECISION: SafetyDecision = {
  action: 'allow',
  reply_key: null,
  categories: [],
  open_case: false,
  case_severity: null,
  withhold_from_guardian: false,
  from_patterns: false,
};

function failedOutcome(): TutorTurnOutcome {
  return {
    child_text_redacted: NOT_SAVED_TEXT,
    redaction_count: 0,
    reply_text: null,
    status: 'failed',
    safety: ALLOW_DECISION,
    verdict: null,
    show_activity: null,
    evidence: [],
    usage: [],
    model: null,
    error_code: 'internal',
  };
}

const CATEGORY_ORDER = [
  'self_harm',
  'abuse_disclosure',
  'distress',
  'sexual',
  'violence',
  'personal_info_shared',
  'jailbreak',
  'off_topic',
] as const;

/** The category that drove the decision, and the severity of its case (the same rule the database applies). */
function caseOf(safety: SafetyDecision): { category: string; severity: 'low' | 'medium' | 'high' } {
  const listed = safety.categories.filter((entry) => entry.severity !== 'none');
  const category =
    CATEGORY_ORDER.find((name) => listed.some((entry) => entry.category === name)) ??
    (safety.reply_key === 'self_harm'
      ? 'self_harm'
      : safety.reply_key === 'abuse'
        ? 'abuse_disclosure'
        : 'distress');
  const severity =
    safety.case_severity ??
    (category === 'self_harm' || category === 'abuse_disclosure'
      ? 'high'
      : category === 'distress'
        ? 'medium'
        : 'low');
  return { category, severity };
}

function wasBilled(outcome: TutorTurnOutcome): boolean {
  return outcome.usage.some(
    (record) =>
      record.input_tokens + record.output_tokens + record.cache_read_tokens + record.cache_creation_tokens > 0,
  );
}

function streamTurn(args: StreamTurnArgs): Response {
  const { deps, service, log, request, sessionId, messageId } = args;
  let clientGone = false;
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
    },
    cancel() {
      // the client went away: the turn still runs to the end and is stored (fetch_turn finds it)
      clientGone = true;
    },
  });

  const write = (text: string): void => {
    if (clientGone || !controller) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      clientGone = true;
    }
  };
  const send = (event: TutorStreamEvent): void => write(sseFrame(event));

  const pump = async (): Promise<void> => {
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), deps.turnTimeoutMs ?? DEFAULT_TURN_TIMEOUT_MS);
    const keepAlive = setInterval(() => write(KEEP_ALIVE_FRAME), deps.keepAliveMs ?? DEFAULT_KEEP_ALIVE_MS);
    let sentError = false;
    try {
      send({ type: 'meta', session_id: sessionId, message_id: messageId });

      let run: TutorTurnRun | null = null;
      try {
        run = deps.runTurn(args.input, {
          settings: args.settings,
          models: args.models,
          signal: abort.signal,
        });
      } catch {
        log('run_failed_to_start', { requestId: args.requestId });
      }

      if (run) {
        try {
          for await (const raw of run.events) {
            const parsed = deps.core.TutorStreamEvent.safeParse(raw);
            if (!parsed.success) {
              log('event_dropped', { requestId: args.requestId });
              continue;
            }
            const event = parsed.data;
            // the handler owns `meta` (already sent) and `done` (sent once the turn is stored)
            if (event.type === 'meta' || event.type === 'done') continue;
            if (event.type === 'error') sentError = true;
            send(event);
          }
        } catch {
          log('events_failed', { requestId: args.requestId });
        }
      }

      let outcome: TutorTurnOutcome = failedOutcome();
      if (run) {
        try {
          outcome = await run.outcome;
        } catch {
          log('outcome_rejected', { requestId: args.requestId });
        }
      }

      const saved = await persist(args, outcome);

      if (!saved) {
        if (!sentError) send({ type: 'error', code: 'internal', retryable: true });
      } else if (saved.status === 'failed') {
        if (!sentError) {
          const code: TutorErrorCode = outcome.error_code === 'internal' ? 'internal' : 'upstream';
          send({ type: 'error', code, retryable: true });
        }
      } else {
        send({ type: 'done', message_id: messageId });
      }
    } catch {
      log('pump_failed', { requestId: args.requestId });
      if (!sentError) send({ type: 'error', code: 'internal', retryable: true });
    } finally {
      clearTimeout(timeout);
      clearInterval(keepAlive);
      try {
        controller?.close();
      } catch {
        // already closed by a cancel
      }
    }
  };

  deps.waitUntil(pump());

  return new Response(body, {
    status: 200,
    headers: sseHeaders(args.cors, {
      'X-Tutor-Grounding-Version': String(args.groundingVersion),
      ...(args.groundingFallback ? { 'X-Tutor-Grounding-Fallback': '1' } : {}),
    }),
  });
}

/**
 * Stores the turn, logs every model call, makes sure the case exists. Returns the stored turn, or null when it could not
 * be stored. Only `outcome.child_text_redacted` (never the raw message) reaches the database.
 */
async function persist(
  args: StreamTurnArgs,
  outcome: TutorTurnOutcome,
): Promise<StoredTurn | null> {
  const { service, log, request, sessionId, messageId } = args;
  const replyUsable =
    outcome.status !== 'failed' &&
    typeof outcome.reply_text === 'string' &&
    outcome.reply_text.trim() !== '';
  const status: TurnStatus = replyUsable ? outcome.status : 'failed';
  const childText =
    outcome.child_text_redacted.trim() === '' ? NOT_SAVED_TEXT : outcome.child_text_redacted.slice(0, 1000);
  const saveArgs = {
    p_child_id: request.child_id,
    p_session_id: sessionId,
    p_client_turn_id: request.client_turn_id,
    p_message_id: messageId,
    p_input_mode: request.input.mode,
    p_child_text: childText,
    p_redaction_count: Math.min(Math.max(Math.trunc(outcome.redaction_count) || 0, 0), 1000),
    p_reply_text: replyUsable ? outcome.reply_text : null,
    p_status: status,
    p_safety: outcome.safety,
    p_evidence: outcome.evidence,
    p_show_activity: outcome.show_activity,
    p_model: outcome.model,
    p_prompt_version: args.deps.core.TUTOR_PROMPT_VERSION,
    // a turn that failed before any model call was billed gives its place in the day's count back
    p_refund_turn: status === 'failed' && !wasBilled(outcome),
  };

  let saved: StoredTurn | null = null;
  let caseId: unknown = null;
  for (let attempt = 0; attempt < 2 && saved === null; attempt += 1) {
    try {
      const result = await service.rpc('tutor_save_turn', saveArgs);
      if (result.error) {
        log('save_turn_failed', { requestId: args.requestId, attempt, ...dbCode(result.error) });
        continue;
      }
      saved = parseStoredTurn(result.data, log);
      if (isRecord(result.data)) {
        caseId = result.data['case_id'] ?? null;
        if (typeof result.data['scrubbed'] === 'number' && result.data['scrubbed'] > 0) {
          // the database found something a redactor missed: a bug to fix, reported by count only
          log('db_scrubbed', { requestId: args.requestId, count: result.data['scrubbed'] });
        }
      }
    } catch {
      log('save_turn_threw', { requestId: args.requestId, attempt });
    }
  }

  // money was spent whether or not the turn could be stored
  if (outcome.usage.length > 0) {
    try {
      const logged = await service.rpc('tutor_log_usage', {
        p_session_id: sessionId,
        p_usage: outcome.usage,
      });
      if (logged.error) log('log_usage_failed', { requestId: args.requestId, ...dbCode(logged.error) });
    } catch {
      log('log_usage_threw', { requestId: args.requestId });
    }
  }

  // The database opens the case in the same transaction as the save; asking again is idempotent (one case per turn) and
  // keeps a case from being lost if that ever changes.
  if (saved && outcome.safety.open_case) {
    try {
      const { category, severity } = caseOf(outcome.safety);
      const opened = await service.rpc('tutor_open_case', {
        p_message_id: messageId,
        p_category: category,
        p_severity: severity,
      });
      if (opened.error) {
        log('open_case_failed', { requestId: args.requestId, ...dbCode(opened.error) });
      } else if (caseId === null) {
        log('case_opened_late', { requestId: args.requestId });
      }
    } catch {
      log('open_case_threw', { requestId: args.requestId });
    }
  }
  return saved;
}

function dbCode(error: { code?: string; message?: string }): Record<string, unknown> {
  return { dbCode: error.code ?? null };
}

