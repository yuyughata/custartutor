// Test support for the `tutor-chat` handler: an environment (fake database, tutor backend, clock, dependencies), JWTs,
// request helpers, an SSE reader, a scripted fake run and a small world (households, children, a published unit).
// Not shipped.

import * as authoringContract from '../../../packages/authoring-core/src/contract';
import * as tutorCore from '../../../packages/tutor-core/src/index';
import { FakeDb } from './ai-job-fake-db.ts';
import { decodeJwtClaims, handleTutorChat } from './tutor-chat-handler.ts';
import { FakeTutorBackend, rlsTables } from './tutor-chat-fake-db.ts';
import type { BackendSettings, Row, World } from './tutor-chat-fake-db.ts';
import type {
  PreparedUnit,
  PrepareUnitArgs,
  TutorChatDeps,
  TutorCore,
  TutorRunContext,
  TutorStreamEvent,
  TutorTurnInput,
  TutorTurnOutcome,
  TutorTurnRun,
} from './tutor-chat-types.ts';

// --- ids ----------------------------------------------------------------------------------------------------------------

export const GA = 'e9a00000-0000-4000-8000-000000000001'; // guardian of household A
export const GB = 'e9a00000-0000-4000-8000-000000000002'; // guardian of household B
export const TU = 'e9a00000-0000-4000-8000-000000000003'; // tutor of household A with a grant for Ada
export const PL = 'e9a00000-0000-4000-8000-000000000004'; // plain user

export const IDS = {
  householdA: 'e9c00000-0000-4000-8000-00000000000a',
  householdB: 'e9c00000-0000-4000-8000-00000000000b',
  ada: 'e9d00000-0000-4000-8000-000000000001',
  bola: 'e9d00000-0000-4000-8000-000000000002',
  chidi: 'e9d00000-0000-4000-8000-000000000003',
  gone: 'e9d00000-0000-4000-8000-000000000004',
  unit: 'ab900000-0000-4000-8000-000000000001',
  unit2: 'ab900000-0000-4000-8000-000000000002',
  unpublished: 'ab900000-0000-4000-8000-0000000000ff',
  turn: (n: number) => `e9f00000-0000-4000-8000-${String(n).padStart(12, '0')}`,
};

/** The tutor-core module as the handler sees it. The real contract must satisfy the structural type. */
export const core: TutorCore = {
  TutorRequest: tutorCore.TutorRequest as unknown as TutorCore['TutorRequest'],
  TutorSettings: tutorCore.TutorSettings as unknown as TutorCore['TutorSettings'],
  TutorStreamEvent: tutorCore.TutorStreamEvent as unknown as TutorCore['TutorStreamEvent'],
  CURRENT_TUTOR_CONSENT_VERSION: tutorCore.CURRENT_TUTOR_CONSENT_VERSION,
  TUTOR_PROMPT_VERSION: tutorCore.TUTOR_PROMPT_VERSION,
};
export const castTraits = authoringContract.CastTraits as unknown as TutorChatDeps['castTraits'];

export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function makeJwt(claims: Record<string, unknown>): string {
  return `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url(JSON.stringify(claims))}.signature`;
}

export interface Clock {
  t: number;
  now(): Date;
  advance(ms: number): void;
}

export function makeClock(start = Date.UTC(2026, 9, 12, 8, 0, 0)): Clock {
  const clock: Clock = {
    t: start,
    now: () => new Date(clock.t),
    advance: (ms) => {
      clock.t += ms;
    },
  };
  return clock;
}

// --- a world -------------------------------------------------------------------------------------------------------------

export const SECRET_ANSWER = 'SECRET-MASTERY-ANSWER';

export function makeWorld(): World {
  const unitContent = (version: number): Row => ({
    schema_version: 1,
    header: { subject_slug: 'basic-science', level_code: 'P1', title: `Unit version ${version}` },
  });
  return {
    children: [
      // the real columns of `children`: alias only, never a name
      { id: IDS.ada, household_id: IDS.householdA, display_alias: 'Ada', level_code: 'P1', reading_mode: 'reader', avatar: 'lion', daily_limit_min: 30, deleted_at: null },
      { id: IDS.bola, household_id: IDS.householdA, display_alias: 'Bola', level_code: 'P2', reading_mode: 'pre_reader', avatar: null, daily_limit_min: null, deleted_at: null },
      { id: IDS.chidi, household_id: IDS.householdB, display_alias: 'Chidi', level_code: 'P3', reading_mode: 'reader', avatar: null, daily_limit_min: null, deleted_at: null },
      { id: IDS.gone, household_id: IDS.householdA, display_alias: 'Gone', level_code: 'P1', reading_mode: 'reader', avatar: null, daily_limit_min: null, deleted_at: '2026-10-01T00:00:00Z' },
    ],
    household_members: [
      { household_id: IDS.householdA, user_id: GA, role: 'guardian', status: 'active', deleted_at: null },
      { household_id: IDS.householdA, user_id: TU, role: 'tutor', status: 'active', deleted_at: null },
      { household_id: IDS.householdB, user_id: GB, role: 'guardian', status: 'active', deleted_at: null },
    ],
    published_units: [
      // version 1 is history (content staff only); version 2 is the current snapshot
      { unit_id: IDS.unit, version_no: 1, is_current: false, content: unitContent(1) },
      { unit_id: IDS.unit, version_no: 2, is_current: true, content: unitContent(2) },
      { unit_id: IDS.unit2, version_no: 1, is_current: true, content: unitContent(1) },
    ],
    subjects: [{ slug: 'basic-science', name: 'Basic Science' }],
    levels: [
      { code: 'P1', stage: 'absorb' },
      { code: 'P2', stage: 'connect' },
      { code: 'P3', stage: 'connect' },
    ],
    characters: [
      { slug: 'zari', name: 'Zari', active: true, traits: { age_years: 7, gender: 'female', pronouns: 'she/her' }, voice: {} },
      { slug: 'zuri', name: 'Zuri', active: true, traits: { age_years: 4, age_note: 'almost 5' }, voice: { style: 'short' } },
      { slug: 'broken', name: 'Broken', active: true, traits: { age_years: 'not a number' }, voice: {} },
      { slug: 'retired', name: 'Retired', active: false, traits: {}, voice: {} },
    ],
    member_display: [
      { household_id: IDS.householdA, user_id: GA, display_name: 'Mrs Okafor', role: 'guardian' },
      { household_id: IDS.householdA, user_id: TU, display_name: 'Mr Bello', role: 'tutor' },
      { household_id: IDS.householdB, user_id: GB, display_name: 'Mr Danjuma', role: 'guardian' },
    ],
  };
}

export const OWNER = { name: 'Ngozi Eze', contact: 'ngozi@example.org', confirmed_at: '2026-10-12T09:00:00Z' };

export function defaultBackendSettings(): BackendSettings {
  return {
    tutor: { ...structuredClone(tutorCore.DEFAULT_TUTOR_SETTINGS), enabled: true, owner: OWNER },
    models: { authoring: 'claude-opus-5-5', tutor: 'claude-sonnet-5-5', moderation: 'claude-haiku-5-5' },
    kill_switch: false,
    prices: {},
  };
}

// --- a scripted fake run ----------------------------------------------------------------------------------------------

export const ALLOW = {
  action: 'allow' as const,
  reply_key: null,
  categories: [],
  open_case: false,
  case_severity: null,
  withhold_from_guardian: false,
  from_patterns: false,
};

export const USAGE_TUTOR = {
  label: 'tutor:reply',
  task: 'tutor',
  model: 'claude-sonnet-5-5-20261001',
  input_tokens: 1200,
  output_tokens: 80,
  cache_read_tokens: 900,
  cache_creation_tokens: 0,
  stop_reason: 'end_turn',
  duration_ms: 1500,
};
export const USAGE_MODERATION = {
  label: 'moderation:input',
  task: 'moderation',
  model: 'claude-haiku-5-5',
  input_tokens: 300,
  output_tokens: 40,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  stop_reason: 'end_turn',
  duration_ms: 400,
};

export function okOutcome(reply: string, overrides: Partial<TutorTurnOutcome> = {}): TutorTurnOutcome {
  return {
    child_text_redacted: 'hello tutor',
    redaction_count: 0,
    reply_text: reply,
    status: 'complete',
    safety: ALLOW,
    verdict: null,
    show_activity: null,
    evidence: [],
    usage: [USAGE_MODERATION, USAGE_TUTOR],
    model: 'claude-sonnet-5-5-20261001',
    error_code: null,
    ...overrides,
  };
}

export interface FakeRunScript {
  events: unknown[];
  outcome: TutorTurnOutcome | Error;
  /** The run waits for this promise before it yields its first event (a slow model / classifier). */
  gate?: Promise<void>;
  /** The run waits for this promise after its last event, before the outcome resolves. */
  gateOutcome?: Promise<void>;
  /** The events iterator throws after yielding all of `events`. */
  throwAfterEvents?: boolean;
}

/** A pipeline stand-in: yields the scripted events, then resolves the scripted outcome. */
export function fakeRun(script: FakeRunScript): TutorTurnRun {
  async function* events(): AsyncGenerator<unknown> {
    if (script.gate) await script.gate;
    for (const event of script.events) yield event;
    if (script.throwAfterEvents) throw new Error('the event stream broke');
  }
  const outcome = (async (): Promise<TutorTurnOutcome> => {
    if (script.gate) await script.gate;
    if (script.gateOutcome) await script.gateOutcome;
    if (script.outcome instanceof Error) throw script.outcome;
    return script.outcome;
  })();
  // never an unhandled rejection when a test replaces the outcome with an error
  outcome.catch(() => {});
  return { events: events(), outcome };
}

export function delta(text: string): TutorStreamEvent {
  return { type: 'delta', text };
}

// --- the environment ------------------------------------------------------------------------------------------------------

export interface SendOptions {
  sub?: string;
  role?: string;
  origin?: string;
  method?: string;
  token?: string | null;
  exp?: number;
  rawBody?: string;
}

export interface EnvOptions {
  /** What a turn runs. Default: a plain allowed reply. */
  runTurn?: (input: TutorTurnInput, context: TutorRunContext) => TutorTurnRun;
  prepareUnit?: (args: PrepareUnitArgs) => PreparedUnit;
  settings?: Partial<BackendSettings>;
  tutorSettings?: Record<string, unknown>;
  world?: World;
  hasKey?: boolean;
  allowedOrigins?: string[];
  /** Households' consent: children whose consent is granted at the start (default: Ada and Bola). */
  consented?: string[];
  keepAliveMs?: number;
  turnTimeoutMs?: number;
}

export interface Env {
  world: World;
  backend: FakeTutorBackend;
  clock: Clock;
  deps: TutorChatDeps;
  userDbs: FakeDb[];
  service: FakeDb;
  /** Everything handed to waitUntil. */
  pending: Promise<unknown>[];
  logs: Array<{ event: string; detail: Record<string, unknown> }>;
  /** The pipeline inputs received, one per turn that started. */
  inputs: TutorTurnInput[];
  contexts: TutorRunContext[];
  prepared: PrepareUnitArgs[];
  flush(): Promise<void>;
  send(body: unknown, options?: SendOptions): Promise<Response>;
  /** A valid `turn` request (override any field). */
  turnBody(overrides?: Record<string, unknown>): Record<string, unknown>;
  /** The names of the service-role RPCs called, in order. */
  serviceCalls(): string[];
}

export function makeEnv(options: EnvOptions = {}): Env {
  const clock = makeClock();
  const world = options.world ?? makeWorld();
  const children: Record<string, string> = {};
  for (const child of world.children) {
    if (child['deleted_at'] == null) children[String(child['id'])] = String(child['household_id']);
  }
  const base = defaultBackendSettings();
  const settings: BackendSettings = {
    ...base,
    ...options.settings,
    tutor: { ...base.tutor, ...options.tutorSettings },
  };
  const backend = new FakeTutorBackend({
    now: clock.now,
    settings,
    unitIds: [IDS.unit, IDS.unit2],
    children,
  });
  for (const childId of options.consented ?? [IDS.ada, IDS.bola]) backend.grantConsent(childId);

  const service = new FakeDb({}, backend.serviceRpcs());
  const userDbs: FakeDb[] = [];
  const pending: Promise<unknown>[] = [];
  const logs: Env['logs'] = [];
  const inputs: TutorTurnInput[] = [];
  const contexts: TutorRunContext[] = [];
  const prepared: PrepareUnitArgs[] = [];

  const deps: TutorChatDeps = {
    core,
    prepareUnit: (args) => {
      prepared.push(args);
      if (options.prepareUnit) return options.prepareUnit(args);
      return {
        grounding: { unit_id: args.unitId, version_no: args.versionNo, title: 'Unit', mastery_prompts: [] },
        masteryGuard: [[SECRET_ANSWER]],
      };
    },
    castTraits,
    runTurn: (input, context) => {
      inputs.push(input);
      contexts.push(context);
      if (options.runTurn) return options.runTurn(input, context);
      return fakeRun({
        events: [delta('Hello Ada! '), delta('What shall we count?')],
        outcome: okOutcome('Hello Ada! What shall we count?'),
      });
    },
    hasAnthropicKey: () => options.hasKey ?? true,
    userDb: (req) => {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const sub = decodeJwtClaims(token)?.sub ?? '';
      const guardianOf = (childId: string): boolean => {
        const child = world.children.find((c) => c['id'] === childId);
        return (
          !!child &&
          world.household_members.some(
            (m) =>
              m['user_id'] === sub &&
              m['household_id'] === child['household_id'] &&
              m['role'] === 'guardian' &&
              m['status'] === 'active',
          )
        );
      };
      const db = new FakeDb(rlsTables(world, sub), backend.userRpcs(guardianOf));
      userDbs.push(db);
      return db;
    },
    serviceDb: () => service,
    claimsOf: decodeJwtClaims,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    now: clock.now,
    uuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `b1000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
      };
    })(),
    allowedOrigins: options.allowedOrigins ?? ['https://app.example.com'],
    ...(options.keepAliveMs !== undefined ? { keepAliveMs: options.keepAliveMs } : {}),
    ...(options.turnTimeoutMs !== undefined ? { turnTimeoutMs: options.turnTimeoutMs } : {}),
    log: (event, detail) => {
      logs.push({ event, detail });
    },
  };

  const env: Env = {
    world,
    backend,
    clock,
    deps,
    userDbs,
    service,
    pending,
    logs,
    inputs,
    contexts,
    prepared,
    async flush() {
      while (pending.length > 0) await pending.shift();
    },
    send(body, sendOptions = {}) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sendOptions.token !== null) {
        headers['Authorization'] = `Bearer ${
          sendOptions.token ??
          makeJwt({
            sub: sendOptions.sub ?? GA,
            role: sendOptions.role ?? 'authenticated',
            aal: 'aal1',
            exp: sendOptions.exp ?? Math.floor(clock.t / 1000) + 3600,
          })
        }`;
      }
      if (sendOptions.origin) headers['Origin'] = sendOptions.origin;
      const method = sendOptions.method ?? 'POST';
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'OPTIONS') {
        init.body = sendOptions.rawBody ?? JSON.stringify(body);
      }
      return handleTutorChat(new Request('https://x.supabase.co/functions/v1/tutor-chat', init), deps);
    },
    turnBody(overrides = {}) {
      return {
        action: 'turn',
        child_id: IDS.ada,
        client_turn_id: IDS.turn(1),
        unit_id: IDS.unit,
        version_no: 2,
        input: { mode: 'text', text: 'hello tutor' },
        helper_present: false,
        ...overrides,
      };
    },
    serviceCalls() {
      return service.calls.map((call) => call.name);
    },
  };
  return env;
}

// --- reading a stream -----------------------------------------------------------------------------------------------------

export interface SseResult {
  events: TutorStreamEvent[];
  /** Raw text of the whole body. */
  raw: string;
  keepAlives: number;
  frames: string[];
}

export async function readSse(response: Response): Promise<SseResult> {
  const raw = await response.text();
  const frames = raw.split('\n\n').filter((frame) => frame !== '');
  const events: TutorStreamEvent[] = [];
  let keepAlives = 0;
  for (const frame of frames) {
    if (frame.startsWith(': keep-alive')) {
      keepAlives += 1;
    } else if (frame.startsWith('data: ')) {
      events.push(JSON.parse(frame.slice('data: '.length)) as TutorStreamEvent);
    } else {
      throw new Error(`unexpected SSE frame: ${frame}`);
    }
  }
  return { events, raw, keepAlives, frames };
}

/** Sends a turn and reads its whole stream (the pump is flushed first, so the turn is stored when this resolves). */
export async function runTurnToEnd(
  env: Env,
  overrides: Record<string, unknown> = {},
  options: SendOptions = {},
): Promise<{ response: Response; sse: SseResult }> {
  const response = await env.send(env.turnBody(overrides), options);
  if (response.status !== 200) throw new Error(`turn failed: ${response.status}`);
  const sse = await readSse(response);
  await env.flush();
  return { response, sse };
}
