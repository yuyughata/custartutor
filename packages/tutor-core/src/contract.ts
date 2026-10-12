// The M3 contract: what the tutor pipeline, the `tutor-chat` edge function and the learner app agree on.
//
// Single source of truth for everything that crosses a package boundary in the tutor (docs/m3-plan.md, ADR 0008,
// docs/safeguarding-protocol.md). Pure types and Zod schemas: no I/O, no SDK imports, so it runs in Deno, Node and
// React Native. Change it only together with every package that imports it.
import { z } from 'zod';
import type {
  CastMember,
  Effort,
  Json,
  LlmClient,
  LlmMessage,
  LlmSystemBlock,
  LlmUsage,
  UsageRecord,
} from '@custar/authoring-core';
import { Id } from '@custar/content-schema';
import type { LevelCode, Stage } from '@custar/content-schema';

const Uuid = z.string().uuid();

// ---------------------------------------------------------------------------------------------
// 1. Settings (app_settings) and the gates that keep the tutor off until it is safe to run
// ---------------------------------------------------------------------------------------------

/** Keys of `app_settings` that the tutor reads. The M3 migration extends the table's key check with these. */
export const TUTOR_SETTING_KEYS = [
  'tutor.enabled',
  'tutor.daily_turns_per_child',
  'tutor.retention_days',
  'tutor.output_check',
  'tutor.max_history_turns',
  'tutor.max_reply_tokens',
  'tutor.persona_name',
  'tutor.safe_replies',
  'tutor.helpline',
  'safeguarding.owner',
  'safeguarding.sla_hours',
  'safeguarding.guardian_visible_categories',
] as const;
export type TutorSettingKey = (typeof TUTOR_SETTING_KEYS)[number];

/** The kinds of fixed, human-approved replies the tutor uses when it must not improvise. */
export const SAFE_REPLY_KEYS = ['self_harm', 'abuse', 'distress', 'blocked', 'redirect'] as const;
export const SafeReplyKey = z.enum(SAFE_REPLY_KEYS);
export type SafeReplyKey = z.infer<typeof SafeReplyKey>;

/**
 * DRAFT wording, for the safeguarding owner to review and replace (docs/safeguarding-protocol.md). Plain words,
 * short sentences, no promise of secrecy, no medical or legal claim, no phone number (the owner supplies verified
 * helpline details in `tutor.helpline`). The model never writes these replies: they are fixed text.
 */
export const DEFAULT_SAFE_REPLIES: Record<SafeReplyKey, string> = {
  self_harm:
    'I am really glad you told me. What you feel matters a lot. Please tell a grown-up you trust right now, like your mum, your dad, an aunty, an uncle or your teacher. If you feel you might hurt yourself, go to a grown-up straight away. You are not alone.',
  abuse:
    'Thank you for telling me. You were brave. It is not your fault. Please tell a grown-up you trust, like a teacher or someone in your family who makes you feel safe. You deserve to be safe.',
  distress:
    'I am sorry you feel this way. It is okay to feel sad or scared. Please tell a grown-up you trust how you feel. We can come back to our lesson when you are ready.',
  blocked:
    'That is not something I can talk about. Let us go back to our lesson. If something is worrying you, please tell a grown-up you trust.',
  redirect: 'I am here to help you with your lesson. Let us go back to it together.',
};

/**
 * `safeguarding.owner`: the named human who owns the safeguarding queue. The tutor cannot be switched on
 * (`set_tutor_enabled`) until this exists and `confirmed_at` is set: it is a business decision, not a default.
 */
export const SafeguardingOwner = z.object({
  name: z.string().min(1),
  role: z.string().optional(),
  contact: z.string().min(1),
  confirmed_at: z.string().min(1),
});
export type SafeguardingOwner = z.infer<typeof SafeguardingOwner>;

export const SafeguardingSeverity = z.enum(['low', 'medium', 'high']);
export type SafeguardingSeverity = z.infer<typeof SafeguardingSeverity>;

export const TutorSettings = z.object({
  /** Master switch. False until a super_admin turns it on, which needs a confirmed `safeguarding.owner`. */
  enabled: z.boolean(),
  /** Turns (child messages) per child per day. */
  daily_turns_per_child: z.number().int().min(1).max(500),
  /** Days to keep tutor messages that were not flagged. Flagged material follows the case. */
  retention_days: z.number().int().min(1).max(3650),
  /** Run the second (Haiku) check on the finished reply. On by default: safety over cost. */
  output_check: z.boolean(),
  /** Past messages sent to the model, newest last. */
  max_history_turns: z.number().int().min(0).max(40),
  max_reply_tokens: z.number().int().min(64).max(2000),
  /** Optional name the tutor goes by. null: no name (the tutor says "I"). */
  persona_name: z.string().min(1).max(40).nullable(),
  safe_replies: z.record(SafeReplyKey, z.string().min(1).max(600)),
  /** Free text shown to the household next to safe replies (the owner supplies verified numbers). */
  helpline: z.string().max(600).nullable(),
  owner: SafeguardingOwner.nullable(),
  /** Hours within which a case of each severity should be looked at. A target for the owner to confirm. */
  sla_hours: z.object({ high: z.number(), medium: z.number(), low: z.number() }),
  /** Categories whose flagged turns a guardian may read. The rest are withheld until a reviewer decides. */
  guardian_visible_categories: z.array(z.string()),
});
export type TutorSettings = z.infer<typeof TutorSettings>;

export const DEFAULT_TUTOR_SETTINGS: TutorSettings = {
  enabled: false,
  daily_turns_per_child: 40,
  retention_days: 90,
  output_check: true,
  max_history_turns: 12,
  max_reply_tokens: 400,
  persona_name: null,
  safe_replies: DEFAULT_SAFE_REPLIES,
  helpline: null,
  owner: null,
  sla_hours: { high: 4, medium: 24, low: 72 },
  guardian_visible_categories: [
    'jailbreak',
    'off_topic',
    'personal_info_shared',
    'sexual',
    'violence',
  ],
};

// ---------------------------------------------------------------------------------------------
// 2. Moderation and the safety decision
// ---------------------------------------------------------------------------------------------

export const MODERATION_CATEGORIES = [
  'self_harm',
  'abuse_disclosure',
  'distress',
  'sexual',
  'violence',
  'personal_info_shared',
  'jailbreak',
  'off_topic',
] as const;
export const ModerationCategory = z.enum(MODERATION_CATEGORIES);
export type ModerationCategory = z.infer<typeof ModerationCategory>;

export const SEVERITIES = ['none', 'low', 'medium', 'high'] as const;
export const Severity = z.enum(SEVERITIES);
export type Severity = z.infer<typeof Severity>;

/** The structured reply of the Haiku classifier (flat: every category always present). */
export const ModerationVerdict = z.object({
  self_harm: Severity,
  abuse_disclosure: Severity,
  distress: Severity,
  sexual: Severity,
  violence: Severity,
  personal_info_shared: Severity,
  jailbreak: Severity,
  off_topic: Severity,
  /** One short sentence for the reviewer. Must not repeat names, numbers or addresses. */
  summary: z.string().max(300),
});
export type ModerationVerdict = z.infer<typeof ModerationVerdict>;

/**
 * What happens to the turn:
 *  - `allow`       the tutor answers normally.
 *  - `steer`       the tutor answers with an instruction to stay on the lesson (mild off-topic).
 *  - `redirect`    no model reply: the fixed `redirect` reply (jailbreak, prompt-injection attempts).
 *  - `blocked`     no model reply: the fixed `blocked` reply (sexual or graphic content).
 *  - `safe_reply`  no model reply: a fixed safe reply (`self_harm`, `abuse` or `distress`) AND a case is opened.
 */
export const SAFETY_ACTIONS = ['allow', 'steer', 'redirect', 'blocked', 'safe_reply'] as const;
export const SafetyAction = z.enum(SAFETY_ACTIONS);
export type SafetyAction = z.infer<typeof SafetyAction>;

export const SafetyDecision = z.object({
  action: SafetyAction,
  /** For `safe_reply`: which fixed reply. */
  reply_key: SafeReplyKey.nullable(),
  /** The categories that drove the decision, with their severities (deterministic patterns count too). */
  categories: z.array(z.object({ category: ModerationCategory, severity: Severity })),
  /** Open a safeguarding case. Always true for self_harm, abuse_disclosure and distress. */
  open_case: z.boolean(),
  case_severity: SafeguardingSeverity.nullable(),
  /** The turn is withheld from guardians until a reviewer decides. */
  withhold_from_guardian: z.boolean(),
  /** The deterministic patterns hit without the classifier (it failed or disagreed). */
  from_patterns: z.boolean(),
});
export type SafetyDecision = z.infer<typeof SafetyDecision>;

// ---------------------------------------------------------------------------------------------
// 3. The tutor-chat protocol
// ---------------------------------------------------------------------------------------------

export const TUTOR_INPUT_MODES = ['text', 'voice'] as const;
export const TutorInputMode = z.enum(TUTOR_INPUT_MODES);

export const MAX_CHILD_MESSAGE_CHARS = 500;

/** POST body of `tutor-chat` for a new turn (caller's JWT = the guardian's session). */
export const TutorChatRequest = z.object({
  action: z.literal('turn').default('turn'),
  child_id: Uuid,
  /** Client-generated; the same id never produces a second turn (a retry returns the stored one). */
  client_turn_id: Uuid,
  /** Omitted on the first turn of a lesson: the server opens a session and returns its id in `meta`. */
  session_id: Uuid.optional(),
  unit_id: Uuid,
  /** The pack version the child is playing; the tutor is grounded in exactly that version. */
  version_no: z.number().int().min(1),
  /** Where the child is, for grounding. */
  section_id: Id.optional(),
  question_id: Id.optional(),
  input: z.object({
    mode: TutorInputMode,
    text: z.string().min(1).max(MAX_CHILD_MESSAGE_CHARS),
    /** STT confidence for voice input (0 to 1). */
    confidence: z.number().min(0).max(1).optional(),
  }),
  /** A human helper is sitting with the child (helper mode). */
  helper_present: z.boolean().default(false),
});
export type TutorChatRequest = z.infer<typeof TutorChatRequest>;

/** POST body to get the stored result of a turn (a dropped stream, a retry after a timeout). */
export const FetchTurnRequest = z.object({
  action: z.literal('fetch_turn'),
  child_id: Uuid,
  client_turn_id: Uuid,
});
export type FetchTurnRequest = z.infer<typeof FetchTurnRequest>;

export const TutorRequest = z.discriminatedUnion('action', [
  TutorChatRequest.extend({ action: z.literal('turn') }),
  FetchTurnRequest,
]);

export const TUTOR_ERROR_CODES = [
  'unauthenticated', // no/invalid JWT
  'forbidden', // the child is not the caller's
  'consent_required', // no current AI-tutor consent for this child
  'tutor_disabled', // tutor.enabled is false (or no safeguarding owner)
  'kill_switch', // ai.kill_switch is on
  'daily_limit', // tutor.daily_turns_per_child reached
  'invalid_request',
  'unit_not_found',
  'busy', // another turn of this session is still running
  'upstream', // the model call failed (the child sees a calm "try again")
  'internal',
] as const;
export const TutorErrorCode = z.enum(TUTOR_ERROR_CODES);
export type TutorErrorCode = z.infer<typeof TutorErrorCode>;

/**
 * Advisory activity suggestion from the tutor, validated against the pack. Never grants mastery.
 * `question_id` must be a question of the unit that is NOT in the mastery check.
 */
export const ShowActivity = z.object({ question_id: Id });
export type ShowActivity = z.infer<typeof ShowActivity>;

/** Advisory evidence (the plan's `record_mastery_evidence`): stored with the message, never a progress event. */
export const TutorEvidence = z.object({
  kind: z.enum(['understood', 'struggling', 'misconception']),
  question_id: Id.optional(),
  /** Short, already redacted. */
  note: z.string().max(200),
});
export type TutorEvidence = z.infer<typeof TutorEvidence>;

/** One SSE `data:` line (JSON). The child-facing client ignores event types it does not know. */
export const TutorStreamEvent = z.discriminatedUnion('type', [
  z.object({ type: z.literal('meta'), session_id: Uuid, message_id: Uuid }),
  z.object({ type: z.literal('delta'), text: z.string() }),
  z.object({ type: z.literal('tool'), name: z.literal('show_activity'), input: ShowActivity }),
  /** The text shown so far is wrong: show this instead (output check, filter). */
  z.object({ type: z.literal('replace'), text: z.string(), reason: z.enum(['safety', 'filter']) }),
  /** A calm UI hint (for example: suggest telling a grown-up). Carries no category detail. */
  z.object({ type: z.literal('safety'), action: SafetyAction }),
  z.object({ type: z.literal('done'), message_id: Uuid }),
  z.object({ type: z.literal('error'), code: TutorErrorCode, retryable: z.boolean() }),
]);
export type TutorStreamEvent = z.infer<typeof TutorStreamEvent>;

export const TURN_STATUSES = ['complete', 'replaced', 'blocked', 'safe_reply', 'failed'] as const;
export const TurnStatus = z.enum(TURN_STATUSES);
export type TurnStatus = z.infer<typeof TurnStatus>;

/** The stored result of a turn: the reply of `fetch_turn`, and what `sendTurn` resolves with. */
export const TutorTurnResult = z.object({
  session_id: Uuid,
  message_id: Uuid,
  status: TurnStatus,
  /** The text the child should see (after any replacement); null when the turn failed. */
  reply: z.string().nullable(),
  safety_action: SafetyAction,
  show_activity: ShowActivity.nullable(),
});
export type TutorTurnResult = z.infer<typeof TutorTurnResult>;

export interface TutorErrorBody {
  error: { code: TutorErrorCode; message: string; retryable: boolean };
}

// ---------------------------------------------------------------------------------------------
// 4. Grounding and the turn pipeline (tutor-core implements; the edge function calls)
// ---------------------------------------------------------------------------------------------

/**
 * What the model may know about the unit. Built from the published unit by `buildGrounding`. It deliberately
 * leaves out every answer of the `mastery_check` section: the tutor can help a child think, it cannot hand
 * over the answers that grant mastery (CLAUDE.md rule 4).
 */
export interface TutorGrounding {
  unit_id: string;
  version_no: number;
  title: string;
  subject_name: string;
  level_code: LevelCode;
  stage: Stage;
  /** The NERDC objective, verbatim. */
  objective: string;
  /** Key terms with their definitions, from the unit. */
  vocabulary: { term: string; meaning: string }[];
  /** Plain-text digest of each section, in order, with its id and heading. */
  sections: { id: string; heading: string; type: string; digest: string }[];
  /** Questions the tutor may discuss, with answers; excludes the mastery check entirely. */
  practice: { id: string; prompt: string; answer: string | null }[];
  /** Questions of the mastery check: prompts only, never answers. */
  mastery_prompts: { id: string; prompt: string }[];
}

export interface TutorTurnInput {
  /** The child's alias only: a real name never reaches the pipeline. */
  child: {
    alias: string;
    level_code: LevelCode;
    stage: Stage;
    reading_mode: 'reader' | 'pre_reader';
  };
  grounding: TutorGrounding;
  position: { section_id?: string; question_id?: string };
  /** Earlier turns of this session, already redacted, oldest first. */
  history: { role: 'child' | 'tutor'; text: string }[];
  /** The child's message as received (RAW): the pipeline redacts it before anything else. */
  message: { mode: 'text' | 'voice'; text: string };
  helper_present: boolean;
  cast: CastMember[];
  /** Names that must never leave the server (guardian-supplied real names), replaced if they appear. */
  known_names?: string[];
}

export interface TutorTurnOutcome {
  /** What may be stored: the child's text after redaction. */
  child_text_redacted: string;
  redaction_count: number;
  /** The final text the child saw; null when the turn failed before any reply. */
  reply_text: string | null;
  status: TurnStatus;
  safety: SafetyDecision;
  verdict: ModerationVerdict | null;
  show_activity: ShowActivity | null;
  evidence: TutorEvidence[];
  /** Every model call of the turn (tutor, classifier, output check), including failed ones that were billed. */
  usage: UsageRecord[];
  model: string | null;
  error_code: TutorErrorCode | null;
}

/** The streaming model port. The classifier and the output check use `LlmClient.generate` (task 'moderation'). */
export interface TutorLlmRequest {
  label: string;
  system: LlmSystemBlock[];
  messages: LlmMessage[];
  tools: {
    name: 'show_activity' | 'record_evidence';
    description: string;
    schema: Record<string, Json>;
  }[];
  effort: Effort;
  maxTokens: number;
  signal?: AbortSignal;
}

export type TutorLlmEvent =
  | { type: 'text'; text: string }
  /** A complete tool call (not forced: the model decides). Arguments are untrusted until validated. */
  | { type: 'tool'; name: string; input: unknown }
  | { type: 'done'; usage: LlmUsage; model: string; stopReason: string };

/** Throws `LlmError` (from authoring-core) subclasses; a refusal is `LlmError('refusal')`. */
export interface TutorLlm {
  stream(request: TutorLlmRequest): AsyncIterable<TutorLlmEvent>;
}

export interface TutorTurnDeps {
  /** Structured calls: the moderation classifier (task 'moderation') and the output check. */
  llm: LlmClient;
  tutorLlm: TutorLlm;
  settings: TutorSettings;
  now(): Date;
  signal?: AbortSignal;
}

/** The pipeline's result: stream events as they happen, plus what to persist once the stream ends. */
export interface TutorTurnRun {
  events: AsyncIterable<TutorStreamEvent>;
  /** Resolves after `events` is exhausted (never rejects: failures become `status: 'failed'`). */
  outcome: Promise<TutorTurnOutcome>;
}

// ---------------------------------------------------------------------------------------------
// 5. Tutor Lite (offline, scripted, deterministic)
// ---------------------------------------------------------------------------------------------

export interface TutorLiteLine {
  node_id: string;
  text: string;
  kind: 'say' | 'correct' | 'incorrect' | 'hint' | 'wrap';
}

/** JSON-serialisable, so the learner app can persist it in SQLite and resume after a restart. */
export interface TutorLiteState {
  node_id: string | null;
  attempts: number;
  hints_used: number;
  /** Which on_correct / on_incorrect / hint line to use next, per node (variety without randomness). */
  cursors: Record<string, number>;
  finished: boolean;
}

export interface TutorLiteStep {
  state: TutorLiteState;
  /** Lines to show now, in order. The last one is the node waiting for a reply when `expecting` is true. */
  lines: TutorLiteLine[];
  /** True when the child must reply before the script goes on. */
  expecting: boolean;
  /** The grading of the child's reply, when there was one. Deterministic; never grants mastery. */
  graded: { correct: boolean } | null;
}

// ---------------------------------------------------------------------------------------------
// 6. The learner app's port to the tutor
// ---------------------------------------------------------------------------------------------

export interface TutorConsentState {
  granted: boolean;
  /** Version the household accepted, or null. */
  version: string | null;
  /** The version the app needs. A new version asks again. */
  required_version: string;
}

export const CURRENT_TUTOR_CONSENT_VERSION = 'tutor-v1-draft';
export const TUTOR_CONSENT_SCOPE = 'ai_tutor';

export interface TutorTranscriptMessage {
  id: string;
  role: 'child' | 'tutor';
  text: string;
  created_at: string;
  /** True when the text was withheld pending review; `text` is then a neutral placeholder. */
  withheld: boolean;
}

export interface TutorSessionSummary {
  id: string;
  unit_id: string;
  started_at: string;
  turns: number;
  /** A reviewer is looking at part of this session. */
  has_withheld: boolean;
}

export class TutorApiError extends Error {
  readonly code: TutorErrorCode | 'offline' | 'elevation_required';
  readonly retryable: boolean;
  constructor(code: TutorApiError['code'], message?: string, retryable = false) {
    super(message ?? code);
    this.name = 'TutorApiError';
    this.code = code;
    this.retryable = retryable;
  }
}

/**
 * The learner app's port. Live: the `tutor-chat` edge function (SSE through `expo/fetch`) and RPCs. Demo: an
 * in-memory scripted stand-in that is labelled as not Claude. Transcript methods need a live grown-up elevation.
 */
export interface TutorApi {
  consent(childId: string): Promise<TutorConsentState>;
  /** Needs a grown-up elevation (grant) and records a row in the append-only consent ledger. */
  setConsent(childId: string, action: 'grant' | 'withdraw'): Promise<void>;
  /** Streams events to `onEvent`, resolves with the stored result. Rejects with `TutorApiError`. */
  sendTurn(
    request: TutorChatRequest,
    onEvent: (event: TutorStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TutorTurnResult>;
  fetchTurn(childId: string, clientTurnId: string): Promise<TutorTurnResult | null>;
  listSessions(childId: string, limit?: number): Promise<TutorSessionSummary[]>;
  getTranscript(sessionId: string): Promise<TutorTranscriptMessage[]>;
}
