// Test support for the `tutor-chat` edge function (not shipped: nothing in supabase/functions/tutor-chat imports it).
//
//   FakeTutorBackend  the SQL of migrations m3_tutor_settings_and_roles / m3_tutor_rpcs in TypeScript (settings, the daily
//                     counter, the in-flight slot, the idempotent turn save, the case, the usage log), so handler tests run
//                     whole turns. The real thing is tested by pgTAP (supabase/tests/database/09*.test.sql); this keeps the
//                     same rules so the two agree. It records everything it is given.
//   rlsTables         the caller's view of the tables the function reads with the caller's JWT (row level security in
//                     TypeScript: a guardian sees the children of their household and nothing else).

import type { DbError } from './tutor-chat-errors.ts';
import { fail, ok } from './ai-job-fake-db.ts';
import type { RpcHandler } from './ai-job-fake-db.ts';
import type { DbResult } from './tutor-chat-types.ts';

export type Row = Record<string, unknown>;

export interface StoredMessage {
  id: string;
  session_id: string;
  child_id: string;
  client_turn_id: string;
  seq: number;
  role: 'child' | 'tutor';
  input_mode: string | null;
  text: string | null;
  redaction_count: number;
  status: string;
  safety: unknown;
  evidence: unknown;
  show_activity: unknown;
  flagged: boolean;
  withheld: boolean;
}

export interface StoredSession {
  id: string;
  child_id: string;
  unit_id: string;
  version_no: number;
  turn_count: number;
  flagged: boolean;
  model: string | null;
  prompt_version: string | null;
  in_flight_turn_id: string | null;
  in_flight_until: number | null;
}

export interface StoredCase {
  id: string;
  session_id: string;
  client_turn_id: string;
  child_id: string;
  category: string;
  severity: string;
  status: string;
  excerpt: Array<{ role: string; text: string | null }>;
  due_at: number;
}

export interface UsageLogRow {
  session_id: string;
  label: string;
  task: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  est_cost_usd: number | null;
  stop_reason: string | null;
}

export interface BackendSettings {
  /** The TutorSettings as stored (the DEFAULT_TUTOR_SETTINGS of the contract, with overrides). */
  tutor: Record<string, unknown>;
  models: { authoring: string; tutor: string; moderation: string };
  kill_switch: boolean;
  prices: Record<
    string,
    {
      input_per_mtok: number;
      output_per_mtok: number;
      cache_read_per_mtok: number;
      cache_write_per_mtok: number;
    }
  >;
}

export const CONSENT_VERSION = 'tutor-v1-draft';

const CATEGORY_ORDER = [
  'self_harm',
  'abuse_disclosure',
  'distress',
  'sexual',
  'violence',
  'personal_info_shared',
  'jailbreak',
  'off_topic',
];

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export class FakeTutorBackend {
  readonly sessions: StoredSession[] = [];
  readonly messages: StoredMessage[] = [];
  readonly cases: StoredCase[] = [];
  readonly usage: UsageLogRow[] = [];
  /** `child_id:day` -> counter. */
  readonly days = new Map<string, { turns: number; last: string | null }>();
  /** Consent rows of the ledger, oldest first. */
  readonly consents: Array<{ child_id: string; action: 'grant' | 'withdraw'; version: string }> = [];
  settings: BackendSettings;
  /** Errors to return from the next calls of an RPC, in order (a transient failure, a missing session, ...). */
  readonly failures = new Map<string, DbError[]>();
  /** Calls whose result is held back until the test releases them. */
  private counter = 0;

  constructor(
    private readonly options: {
      now: () => Date;
      settings: BackendSettings;
      /** Unit ids that exist (tutor_open_session checks it). */
      unitIds: string[];
      /** child id -> household id, for children that are not deleted. */
      children: Record<string, string>;
    },
  ) {
    this.settings = options.settings;
  }

  private newId(): string {
    this.counter += 1;
    return `5e550000-0000-4000-8000-${this.counter.toString(16).padStart(12, '0')}`;
  }
  private day(): string {
    // Africa/Lagos is UTC+1 all year
    return new Date(this.options.now().getTime() + 3_600_000).toISOString().slice(0, 10);
  }

  /** The RPCs the edge function calls with the SERVICE ROLE. */
  serviceRpcs(): Record<string, RpcHandler> {
    const wrap = (name: string, handler: RpcHandler): RpcHandler => {
      return (args) => {
        const queued = this.failures.get(name);
        const next = queued?.shift();
        if (next) return { data: null, error: next };
        return handler(args);
      };
    };
    return {
      tutor_get_settings: wrap('tutor_get_settings', () => ok(this.effectiveSettings())),
      tutor_get_ai_settings: wrap('tutor_get_ai_settings', () =>
        ok({
          models: this.settings.models,
          kill_switch: this.settings.kill_switch,
          effort: {},
          prompt_version: 'm2-v1',
        }),
      ),
      tutor_get_turn: wrap('tutor_get_turn', (args) =>
        ok(this.turnResult(String(args['p_child_id']), String(args['p_client_turn_id']))),
      ),
      tutor_reserve_turn: wrap('tutor_reserve_turn', (args) => this.reserve(args)),
      tutor_open_session: wrap('tutor_open_session', (args) => this.openSession(args)),
      tutor_save_turn: wrap('tutor_save_turn', (args) => this.saveTurn(args)),
      tutor_log_usage: wrap('tutor_log_usage', (args) => this.logUsage(args)),
      tutor_open_case: wrap('tutor_open_case', (args) => this.openCase(args)),
    };
  }

  /** The RPCs the caller's JWT may call (the guardian). */
  userRpcs(guardianOf: (childId: string) => boolean): Record<string, RpcHandler> {
    return {
      get_tutor_consent: (args) => {
        const childId = String(args['p_child_id']);
        if (!guardianOf(childId)) return fail('child_not_found', 'P0002');
        const latest = [...this.consents].reverse().find((row) => row.child_id === childId);
        return ok({
          granted: latest?.action === 'grant',
          version: latest?.action === 'grant' ? latest.version : null,
          required_version: CONSENT_VERSION,
        });
      },
    };
  }

  grantConsent(childId: string, version: string = CONSENT_VERSION): void {
    this.consents.push({ child_id: childId, action: 'grant', version });
  }
  withdrawConsent(childId: string): void {
    this.consents.push({ child_id: childId, action: 'withdraw', version: CONSENT_VERSION });
  }

  private ownerConfirmed(): boolean {
    const owner = this.settings.tutor['owner'];
    return isRecord(owner) && typeof owner['confirmed_at'] === 'string' && owner['confirmed_at'] !== '';
  }

  /** `enabled` is the stored switch AND a confirmed owner; `owner` is null until confirmed (as the SQL does). */
  private effectiveSettings(): Row {
    return {
      ...this.settings.tutor,
      enabled: this.settings.tutor['enabled'] === true && this.ownerConfirmed(),
      owner: this.ownerConfirmed() ? this.settings.tutor['owner'] : null,
    };
  }

  messagesOf(childId: string, turnId: string): StoredMessage[] {
    return this.messages.filter((m) => m.child_id === childId && m.client_turn_id === turnId);
  }

  private turnResult(childId: string, turnId: string): Row | null {
    const reply = this.messages.find(
      (m) => m.child_id === childId && m.client_turn_id === turnId && m.role === 'tutor',
    );
    if (!reply) return null;
    return {
      session_id: reply.session_id,
      message_id: reply.id,
      status: reply.status,
      reply: reply.text,
      safety_action: isRecord(reply.safety) ? (reply.safety['action'] ?? 'allow') : 'allow',
      show_activity: reply.show_activity ?? null,
    };
  }

  private reserve(args: Record<string, unknown>): DbResult<unknown> {
    const limit = Number(args['p_limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) return fail('invalid_limit', '22023');
    const childId = String(args['p_child_id']);
    if (!(childId in this.options.children)) return fail('child_not_found', 'P0002');
    const key = `${childId}:${this.day()}`;
    const row = this.days.get(key) ?? { turns: 0, last: null };
    this.days.set(key, row);
    const turnId = typeof args['p_client_turn_id'] === 'string' ? args['p_client_turn_id'] : null;
    if (turnId !== null && row.last === turnId) return ok({ allowed: true, turns: row.turns, limit });
    if (row.turns >= limit) return ok({ allowed: false, turns: row.turns, limit });
    row.turns += 1;
    row.last = turnId;
    return ok({ allowed: true, turns: row.turns, limit });
  }

  private openSession(args: Record<string, unknown>): DbResult<unknown> {
    const childId = String(args['p_child_id']);
    const turnId = String(args['p_client_turn_id']);
    const unitId = String(args['p_unit_id']);
    const leaseMs = Number(args['p_lease_seconds']) * 1000;
    const historyTurns = Number(args['p_history_turns'] ?? 0);
    const now = this.options.now().getTime();
    if (!(childId in this.options.children)) return fail('child_not_found', 'P0002');
    if (!this.options.unitIds.includes(unitId)) return fail('unit_not_found', 'P0002');

    const storedChild = this.messages.find(
      (m) => m.child_id === childId && m.client_turn_id === turnId && m.role === 'child',
    );
    if (storedChild) {
      return ok({ stored: true, busy: false, session_id: storedChild.session_id });
    }

    let session: StoredSession | undefined;
    let created = false;
    if (typeof args['p_session_id'] === 'string') {
      session = this.sessions.find((s) => s.id === args['p_session_id'] && s.child_id === childId);
      if (!session) return fail('session_not_found', 'P0002');
      if (session.unit_id !== unitId) return fail('session_unit_mismatch', '22023');
    } else {
      session = this.sessions.find((s) => s.child_id === childId && s.in_flight_turn_id === turnId);
      if (!session) {
        session = {
          id: this.newId(),
          child_id: childId,
          unit_id: unitId,
          version_no: Number(args['p_version_no']),
          turn_count: 0,
          flagged: false,
          model: null,
          prompt_version: null,
          in_flight_turn_id: turnId,
          in_flight_until: now + leaseMs,
        };
        this.sessions.push(session);
        created = true;
      }
    }
    if (!created) {
      if (session.in_flight_until !== null && session.in_flight_until > now) {
        return ok({ stored: false, busy: true, session_id: session.id });
      }
      session.in_flight_turn_id = turnId;
      session.in_flight_until = now + leaseMs;
    }
    const history = this.messages
      .filter((m) => m.session_id === session.id && m.status === 'complete' && m.text !== null)
      .sort((a, b) => a.seq - b.seq)
      .slice(-historyTurns * 2)
      .map((m) => ({ role: m.role, text: m.text }));
    return ok({
      stored: false,
      busy: false,
      session_id: session.id,
      created,
      history: historyTurns === 0 ? [] : history,
      turn_count: session.turn_count,
    });
  }

  private saveTurn(args: Record<string, unknown>): DbResult<unknown> {
    const childId = String(args['p_child_id']);
    const turnId = String(args['p_client_turn_id']);
    const session = this.sessions.find((s) => s.id === args['p_session_id'] && s.child_id === childId);
    if (!session) return fail('session_not_found', 'P0002');
    const status = String(args['p_status']);
    if (!['complete', 'replaced', 'blocked', 'safe_reply', 'failed'].includes(status)) {
      return fail('invalid_turn_status', '22023');
    }
    const existing = this.messages.find(
      (m) => m.child_id === childId && m.client_turn_id === turnId && m.role === 'tutor',
    );
    if (existing) {
      if (session.in_flight_turn_id === turnId) {
        session.in_flight_turn_id = null;
        session.in_flight_until = null;
      }
      return ok({ ...this.turnResult(childId, turnId), duplicate: true, scrubbed: 0, case_id: null });
    }
    const safety = isRecord(args['p_safety']) ? args['p_safety'] : {};
    const openCase = safety['open_case'] === true;
    const withhold = safety['withhold_from_guardian'] === true;
    const seq = session.turn_count * 2 + 1;
    const childMessageId = this.newId();
    const messageId = typeof args['p_message_id'] === 'string' ? args['p_message_id'] : this.newId();
    const flagged = openCase || withhold;
    this.messages.push(
      {
        id: childMessageId,
        session_id: session.id,
        child_id: childId,
        client_turn_id: turnId,
        seq,
        role: 'child',
        input_mode: String(args['p_input_mode']),
        text: String(args['p_child_text']),
        redaction_count: Number(args['p_redaction_count']),
        status,
        safety: null,
        evidence: [],
        show_activity: null,
        flagged,
        withheld: withhold,
      },
      {
        id: messageId,
        session_id: session.id,
        child_id: childId,
        client_turn_id: turnId,
        seq: seq + 1,
        role: 'tutor',
        input_mode: null,
        text: status === 'failed' ? null : String(args['p_reply_text']),
        redaction_count: 0,
        status,
        safety,
        evidence: args['p_evidence'] ?? [],
        show_activity: args['p_show_activity'] ?? null,
        flagged,
        withheld: withhold,
      },
    );
    session.turn_count += 1;
    session.flagged = session.flagged || flagged;
    session.model = typeof args['p_model'] === 'string' ? args['p_model'] : session.model;
    session.prompt_version =
      typeof args['p_prompt_version'] === 'string' ? args['p_prompt_version'] : session.prompt_version;
    if (session.in_flight_turn_id === turnId) {
      session.in_flight_turn_id = null;
      session.in_flight_until = null;
    }
    let caseId: string | null = null;
    if (openCase) {
      const categories = Array.isArray(safety['categories']) ? safety['categories'] : [];
      const names = categories
        .filter((c): c is Row => isRecord(c) && c['severity'] !== 'none')
        .map((c) => String(c['category']));
      const category = CATEGORY_ORDER.find((name) => names.includes(name)) ?? 'distress';
      const severity =
        typeof safety['case_severity'] === 'string'
          ? safety['case_severity']
          : category === 'self_harm' || category === 'abuse_disclosure'
            ? 'high'
            : category === 'distress'
              ? 'medium'
              : 'low';
      caseId = this.ensureCase(childId, session.id, turnId, category, severity).id;
    }
    if (args['p_refund_turn'] === true && status === 'failed') {
      const row = this.days.get(`${childId}:${this.day()}`);
      if (row && row.last === turnId) {
        row.turns = Math.max(row.turns - 1, 0);
        row.last = null;
      }
    }
    return ok({
      ...this.turnResult(childId, turnId),
      child_message_id: childMessageId,
      duplicate: false,
      scrubbed: 0,
      case_id: caseId,
    });
  }

  private ensureCase(
    childId: string,
    sessionId: string,
    turnId: string,
    category: string,
    severity: string,
  ): StoredCase {
    const existing = this.cases.find((c) => c.child_id === childId && c.client_turn_id === turnId);
    if (existing) return existing;
    const sla = this.settings.tutor['sla_hours'] as Record<string, number>;
    const excerpt = this.messages
      .filter((m) => m.session_id === sessionId && m.text !== null)
      .sort((a, b) => a.seq - b.seq)
      .slice(-6)
      .map((m) => ({ role: m.role, text: m.text }));
    const created: StoredCase = {
      id: this.newId(),
      session_id: sessionId,
      client_turn_id: turnId,
      child_id: childId,
      category,
      severity,
      status: 'open',
      excerpt,
      due_at: this.options.now().getTime() + Number(sla[severity]) * 3_600_000,
    };
    this.cases.push(created);
    for (const message of this.messages) {
      if (message.child_id === childId && message.client_turn_id === turnId) message.flagged = true;
    }
    return created;
  }

  private openCase(args: Record<string, unknown>): DbResult<unknown> {
    const message = this.messages.find((m) => m.id === args['p_message_id']);
    if (!message) return fail('message_not_found', 'P0002');
    const before = this.cases.length;
    const created = this.ensureCase(
      message.child_id,
      message.session_id,
      message.client_turn_id,
      String(args['p_category']),
      String(args['p_severity']),
    );
    return ok({ case_id: created.id, created: this.cases.length > before });
  }

  private cost(model: string, record: Row): number | null {
    let best: string | undefined;
    for (const key of Object.keys(this.settings.prices)) {
      if (model.startsWith(key) && (best === undefined || key.length > best.length)) best = key;
    }
    if (best === undefined) return null;
    const price = this.settings.prices[best] as BackendSettings['prices'][string];
    const n = (value: unknown): number => (typeof value === 'number' ? value : 0);
    return (
      (n(record['input_tokens']) * price.input_per_mtok +
        n(record['output_tokens']) * price.output_per_mtok +
        n(record['cache_read_tokens']) * price.cache_read_per_mtok +
        n(record['cache_creation_tokens']) * price.cache_write_per_mtok) /
      1_000_000
    );
  }

  private logUsage(args: Record<string, unknown>): DbResult<unknown> {
    const sessionId = String(args['p_session_id']);
    if (!this.sessions.some((s) => s.id === sessionId)) return fail('session_not_found', 'P0002');
    const records = Array.isArray(args['p_usage']) ? args['p_usage'] : [];
    for (const record of records) {
      if (!isRecord(record) || !['tutor', 'moderation'].includes(String(record['task']))) {
        return fail('invalid_usage', '22023');
      }
    }
    for (const record of records as Row[]) {
      this.usage.push({
        session_id: sessionId,
        label: String(record['label'] ?? 'tutor'),
        task: String(record['task']),
        model: String(record['model']),
        input_tokens: Number(record['input_tokens'] ?? 0),
        output_tokens: Number(record['output_tokens'] ?? 0),
        est_cost_usd: this.cost(String(record['model']), record),
        stop_reason: typeof record['stop_reason'] === 'string' ? record['stop_reason'] : null,
      });
    }
    return ok(records.length);
  }
}

// --- row level security, in TypeScript ---------------------------------------------------------------------------------

export interface World {
  /** children: id, household_id, display_alias, level_code, reading_mode, deleted_at, and anything else (a real name...) */
  children: Row[];
  /** household_members: household_id, user_id, role, status, deleted_at */
  household_members: Row[];
  published_units: Row[];
  subjects: Row[];
  levels: Row[];
  characters: Row[];
  member_display: Row[];
}

/** What a signed-in user's client can read. A guardian sees the children of the households they guard, a granted tutor
 * also sees their children (but the function refuses tutors). Published units: the current, non-tombstoned ones. */
export function rlsTables(world: World, userId: string): Record<string, Row[]> {
  const memberships = world.household_members.filter(
    (m) => m['user_id'] === userId && m['status'] === 'active' && m['deleted_at'] == null,
  );
  const guarded = new Set(memberships.filter((m) => m['role'] === 'guardian').map((m) => m['household_id']));
  const households = new Set(memberships.map((m) => m['household_id']));
  return {
    children: world.children.filter((c) => guarded.has(c['household_id'])),
    household_members: world.household_members.filter(
      (m) => m['user_id'] === userId || guarded.has(m['household_id']),
    ),
    published_units: world.published_units.filter((u) => u['is_current'] === true),
    subjects: world.subjects,
    levels: world.levels,
    characters: world.characters.filter((c) => c['active'] === true),
    member_display: world.member_display.filter((m) => households.has(m['household_id'])),
  };
}
