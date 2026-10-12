// Structural types for the `tutor-chat` edge function.
//
// The function cannot import the contract or the tutor-core source (edge functions only bundle files inside
// supabase/functions), so everything it needs from them is declared here as the smallest structural shape, and the real
// thing is INJECTED: `core` is the vendored tutor-core bundle in production and the TypeScript source in Vitest;
// `runTurn` wraps `runTutorTurn`; `prepareUnit` wraps `parseUnit` + `buildGrounding` + `buildMasteryGuard`.
// tutor-chat-handler.test.ts assigns the real contract to these types, so a drift between the two breaks the build of
// the tests.

import type { DbClient, DbResult, Json, Parser, Query, TokenClaims } from './ai-job-types.ts';

export type { DbClient, DbResult, Json, Parser, Query, TokenClaims };

// --- the contract, as far as the function uses it --------------------------------------------------------

export type TutorInputMode = 'text' | 'voice';

export interface TurnRequest {
  action: 'turn';
  child_id: string;
  client_turn_id: string;
  session_id?: string;
  unit_id: string;
  version_no: number;
  section_id?: string;
  question_id?: string;
  input: { mode: TutorInputMode; text: string; confidence?: number };
  helper_present: boolean;
}

export interface FetchTurnRequest {
  action: 'fetch_turn';
  child_id: string;
  client_turn_id: string;
}

export type TutorRequest = TurnRequest | FetchTurnRequest;

export type SafetyAction = 'allow' | 'steer' | 'redirect' | 'blocked' | 'safe_reply';
export type TurnStatus = 'complete' | 'replaced' | 'blocked' | 'safe_reply' | 'failed';

/** One SSE `data:` line. Validated by the contract's `TutorStreamEvent` before it is sent (unknown fields are dropped). */
export type TutorStreamEvent =
  | { type: 'meta'; session_id: string; message_id: string }
  | { type: 'delta'; text: string }
  | { type: 'tool'; name: 'show_activity'; input: { question_id: string } }
  | { type: 'replace'; text: string; reason: 'safety' | 'filter' }
  | { type: 'safety'; action: SafetyAction }
  | { type: 'done'; message_id: string }
  | { type: 'error'; code: string; retryable: boolean };

export interface SafetyDecision {
  action: SafetyAction;
  reply_key: string | null;
  categories: Array<{ category: string; severity: string }>;
  open_case: boolean;
  case_severity: 'low' | 'medium' | 'high' | null;
  withhold_from_guardian: boolean;
  from_patterns: boolean;
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

export interface TutorSettings {
  enabled: boolean;
  daily_turns_per_child: number;
  retention_days: number;
  output_check: boolean;
  max_history_turns: number;
  max_reply_tokens: number;
  persona_name: string | null;
  safe_replies: Record<string, string>;
  helpline: string | null;
  owner: { name: string; role?: string; contact: string; confirmed_at: string } | null;
  sla_hours: { high: number; medium: number; low: number };
  guardian_visible_categories: string[];
}

export interface TutorTurnOutcome {
  child_text_redacted: string;
  redaction_count: number;
  reply_text: string | null;
  status: TurnStatus;
  safety: SafetyDecision;
  verdict: unknown;
  show_activity: { question_id: string } | null;
  evidence: Array<{ kind: string; question_id?: string; note: string }>;
  usage: UsageRecord[];
  model: string | null;
  error_code: string | null;
}

export interface TutorTurnRun {
  events: AsyncIterable<unknown>;
  outcome: Promise<TutorTurnOutcome>;
}

/** What the pipeline receives (TutorTurnInput of the contract). The raw message is in `message.text` only. */
export interface TutorTurnInput {
  child: {
    alias: string;
    level_code: string;
    stage: string;
    reading_mode: 'reader' | 'pre_reader';
  };
  grounding: unknown;
  position: { section_id?: string; question_id?: string };
  history: Array<{ role: 'child' | 'tutor'; text: string }>;
  message: { mode: TutorInputMode; text: string };
  helper_present: boolean;
  cast: Array<{ slug: string; name: string; traits: unknown; voice: Record<string, Json> }>;
  known_names?: string[];
  ids?: { session_id: string; message_id: string };
  mastery_guard?: readonly (readonly string[])[];
}

/** What the glue gives the pipeline besides the input. */
export interface TutorRunContext {
  settings: TutorSettings;
  /** The model ids per task (`ai.models`). */
  models: { authoring: string; tutor: string; moderation: string };
  /** Aborts the turn when its wall-clock budget is spent. Never aborted by a client that went away. */
  signal: AbortSignal;
}

/** What the function takes from the tutor-core module: schemas and constants. */
export interface TutorCore {
  TutorRequest: Parser<TutorRequest>;
  TutorSettings: Parser<TutorSettings>;
  TutorStreamEvent: Parser<TutorStreamEvent>;
  CURRENT_TUTOR_CONSENT_VERSION: string;
  TUTOR_PROMPT_VERSION: string;
}

/** The published unit, prepared for the tutor: what the model may know and the mastery answers the sanitiser guards. */
export interface PreparedUnit {
  grounding: unknown;
  masteryGuard: readonly (readonly string[])[];
}

export interface PrepareUnitArgs {
  /** `published_units.content`, unparsed. */
  content: unknown;
  unitId: string;
  versionNo: number;
  /** The subject's display name when it could be read, else the builder derives one from the slug. */
  subjectName: string | undefined;
}

// --- the handler's dependencies ------------------------------------------------------------------------

export interface TutorChatDeps {
  core: TutorCore;
  /** Parses the published content and builds the grounding. Throws when the content does not parse. */
  prepareUnit(args: PrepareUnitArgs): PreparedUnit;
  /** Parser of `characters.traits` (the CastTraits schema of authoring-core). */
  castTraits: Parser<Record<string, unknown>>;
  /** Starts a turn: the pipeline (`runTutorTurn`) with its models, built by the glue. Must not throw. */
  runTurn(input: TutorTurnInput, context: TutorRunContext): TutorTurnRun;
  /** Whether ANTHROPIC_API_KEY is set. The key itself never enters the handler. */
  hasAnthropicKey(): boolean;
  /** A client acting as the caller: RLS and the role checks of the RPCs apply. */
  userDb(req: Request): DbClient;
  /** The service role: only for the tutor_* RPCs, and only after the caller is authorised. */
  serviceDb(): DbClient;
  /** Claims of the bearer token. The platform verified the JWT (verify_jwt = true); the database re-checks it. */
  claimsOf(token: string): TokenClaims | null;
  /** `EdgeRuntime.waitUntil` in production. */
  waitUntil(promise: Promise<unknown>): void;
  now(): Date;
  uuid(): string;
  /** Browser origins allowed to call the function (the `ALLOWED_ORIGINS` secret). Native apps send no Origin. */
  allowedOrigins: readonly string[];
  /** Also allow `http://localhost:<port>` and `http://127.0.0.1:<port>`. Default true. */
  allowLocalhost?: boolean;
  /** Milliseconds between SSE keep-alive comments. Default 15 000. */
  keepAliveMs?: number;
  /** Wall-clock budget of one turn. Default 140 000 ms. */
  turnTimeoutMs?: number;
  /** Seconds a turn holds its session's in-flight slot. Default 180. */
  leaseSeconds?: number;
  /** Structured log. NEVER receives message text (a test checks every call). */
  log?: (event: string, detail: Record<string, unknown>) => void;
}
