// createDemoTutorApi: the learner app's TutorApi for DEMO MODE. Everything lives in memory (consent, sessions,
// messages) and nothing leaves the device. A turn runs through the REAL pipeline of this package (redaction,
// patterns, router, sanitiser), so crisis input shows the real fixed safe replies and the real safety UI; only the
// tutor's wording is scripted (demoTutor.ts). It reports `isDemo: true` and the model id 'demo-scripted-tutor', and
// every reply it writes starts with "Demo tutor (not Claude):".
import { DEFAULT_CAST } from '@custar/authoring-core';
import type { CastMember } from '@custar/authoring-core';
import type { UnitContent } from '@custar/content-schema';
import { CURRENT_TUTOR_CONSENT_VERSION, DEFAULT_TUTOR_SETTINGS, TutorApiError } from '../contract';
import type {
  TutorApi,
  TutorChatRequest,
  TutorConsentState,
  TutorSessionSummary,
  TutorSettings,
  TutorStreamEvent,
  TutorTranscriptMessage,
  TutorTurnInput,
  TutorTurnResult,
} from '../contract';
import { runTutorTurn } from '../pipeline/runTurn';
import { buildGrounding, buildMasteryGuard } from '../prompt/grounding';
import { createDemoModerationLlm, createDemoTutorLlm, demoReplyText } from './demoTutor';

export type DemoTutorApi = TutorApi & { readonly isDemo: true };

export interface DemoUnit {
  unit: UnitContent;
  subject_name?: string;
}

export interface DemoTutorOptions {
  /** The published unit a child is playing. Return null for an unknown unit. */
  getUnit(unitId: string, versionNo: number): DemoUnit | null | Promise<DemoUnit | null>;
  /** The child's profile; the alias is all the model would ever see. */
  getChild?(childId: string): TutorTurnInput['child'];
  settings?: Partial<TutorSettings>;
  cast?: CastMember[];
  now?: () => Date;
  /** Stands in for a live grown-up elevation: transcripts and granting consent need it. Default true. */
  elevated?: boolean | (() => boolean);
  initialConsent?: boolean;
  /** Real names the demo must never echo. */
  knownNames?: (childId: string) => string[];
}

interface StoredMessage {
  id: string;
  role: 'child' | 'tutor';
  text: string;
  created_at: string;
  withheld: boolean;
}

interface Session {
  id: string;
  childId: string;
  unitId: string;
  startedAt: string;
  messages: StoredMessage[];
  tutorReplies: number;
}

export const WITHHELD_PLACEHOLDER = 'This message is being looked at by a reviewer.';
const DEFAULT_CHILD: TutorTurnInput['child'] = {
  alias: 'Friend',
  level_code: 'P1',
  stage: 'absorb',
  reading_mode: 'pre_reader',
};

export function createDemoTutorApi(options: DemoTutorOptions): DemoTutorApi {
  const now = options.now ?? (() => new Date(0));
  const settings: TutorSettings = { ...DEFAULT_TUTOR_SETTINGS, enabled: true, ...options.settings };
  const consent = new Map<string, boolean>();
  const sessions = new Map<string, Session>();
  const turns = new Map<string, TutorTurnResult>();
  const daily = new Map<string, number>();
  let counter = 0;
  const uuid = (): string =>
    `00000000-0000-4000-8000-${(counter += 1).toString(16).padStart(12, '0')}`;
  const elevated = (): boolean =>
    typeof options.elevated === 'function' ? options.elevated() : (options.elevated ?? true);
  const granted = (childId: string): boolean =>
    consent.get(childId) ?? options.initialConsent ?? false;

  return {
    isDemo: true,

    consent(childId: string): Promise<TutorConsentState> {
      const yes = granted(childId);
      return Promise.resolve({
        granted: yes,
        version: yes ? CURRENT_TUTOR_CONSENT_VERSION : null,
        required_version: CURRENT_TUTOR_CONSENT_VERSION,
      });
    },

    setConsent(childId: string, action: 'grant' | 'withdraw'): Promise<void> {
      if (action === 'grant' && !elevated())
        return Promise.reject(new TutorApiError('elevation_required'));
      consent.set(childId, action === 'grant');
      return Promise.resolve();
    },

    async sendTurn(
      request: TutorChatRequest,
      onEvent: (event: TutorStreamEvent) => void,
      signal?: AbortSignal,
    ): Promise<TutorTurnResult> {
      const stored = turns.get(`${request.child_id}:${request.client_turn_id}`);
      if (stored) {
        if (stored.reply !== null) onEvent({ type: 'delta', text: stored.reply });
        onEvent({ type: 'done', message_id: stored.message_id });
        return stored;
      }
      if (!settings.enabled) throw new TutorApiError('tutor_disabled');
      if (!granted(request.child_id)) throw new TutorApiError('consent_required');
      const day = `${request.child_id}:${now().toISOString().slice(0, 10)}`;
      if ((daily.get(day) ?? 0) >= settings.daily_turns_per_child)
        throw new TutorApiError('daily_limit');
      const found = await options.getUnit(request.unit_id, request.version_no);
      if (!found) throw new TutorApiError('unit_not_found');

      const session = sessions.get(request.session_id ?? '') ?? {
        id: request.session_id ?? uuid(),
        childId: request.child_id,
        unitId: request.unit_id,
        startedAt: now().toISOString(),
        messages: [],
        tutorReplies: 0,
      };
      sessions.set(session.id, session);
      daily.set(day, (daily.get(day) ?? 0) + 1);
      const messageId = uuid();

      const grounding = buildGrounding(found.unit, {
        versionNo: request.version_no,
        unitId: request.unit_id,
        ...(found.subject_name ? { subjectName: found.subject_name } : {}),
      });
      const replyText = demoReplyText({
        unit: found.unit,
        ...(request.section_id ? { sectionId: request.section_id } : {}),
        turnIndex: session.tutorReplies,
        childText: request.input.text,
      });
      const run = runTutorTurn(
        {
          llm: createDemoModerationLlm(request.input.text),
          tutorLlm: createDemoTutorLlm(replyText),
          settings,
          now,
          ...(signal ? { signal } : {}),
        },
        {
          child: options.getChild?.(request.child_id) ?? DEFAULT_CHILD,
          grounding,
          position: {
            ...(request.section_id ? { section_id: request.section_id } : {}),
            ...(request.question_id ? { question_id: request.question_id } : {}),
          },
          history: session.messages
            .filter((m) => !m.withheld)
            .map((m) => ({ role: m.role, text: m.text })),
          message: { mode: request.input.mode, text: request.input.text },
          helper_present: request.helper_present,
          cast: options.cast ?? DEFAULT_CAST,
          known_names: options.knownNames?.(request.child_id) ?? [],
          ids: { session_id: session.id, message_id: messageId },
          mastery_guard: buildMasteryGuard(found.unit),
        },
      );
      for await (const event of run.events) onEvent(event);
      const outcome = await run.outcome;
      if (outcome.status === 'failed') {
        throw new TutorApiError(outcome.error_code ?? 'upstream', undefined, true);
      }

      const at = now().toISOString();
      const withheld = outcome.safety.withhold_from_guardian;
      session.messages.push({
        id: uuid(),
        role: 'child',
        text: outcome.child_text_redacted,
        created_at: at,
        withheld,
      });
      session.messages.push({
        id: messageId,
        role: 'tutor',
        text: outcome.reply_text ?? '',
        created_at: at,
        withheld,
      });
      session.tutorReplies += 1;
      const result: TutorTurnResult = {
        session_id: session.id,
        message_id: messageId,
        status: outcome.status,
        reply: outcome.reply_text,
        safety_action: outcome.safety.action,
        show_activity: outcome.show_activity,
      };
      turns.set(`${request.child_id}:${request.client_turn_id}`, result);
      return result;
    },

    fetchTurn(childId: string, clientTurnId: string): Promise<TutorTurnResult | null> {
      return Promise.resolve(turns.get(`${childId}:${clientTurnId}`) ?? null);
    },

    listSessions(childId: string, limit = 20): Promise<TutorSessionSummary[]> {
      if (!elevated()) return Promise.reject(new TutorApiError('elevation_required'));
      const found = [...sessions.values()]
        .filter((session) => session.childId === childId)
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
        .slice(0, limit)
        .map((session) => ({
          id: session.id,
          unit_id: session.unitId,
          started_at: session.startedAt,
          turns: session.tutorReplies,
          has_withheld: session.messages.some((m) => m.withheld),
        }));
      return Promise.resolve(found);
    },

    getTranscript(sessionId: string): Promise<TutorTranscriptMessage[]> {
      if (!elevated()) return Promise.reject(new TutorApiError('elevation_required'));
      const session = sessions.get(sessionId);
      if (!session) return Promise.reject(new TutorApiError('invalid_request', 'Unknown session'));
      return Promise.resolve(
        session.messages.map((m) => ({
          id: m.id,
          role: m.role,
          text: m.withheld ? WITHHELD_PLACEHOLDER : m.text,
          created_at: m.created_at,
          withheld: m.withheld,
        })),
      );
    },
  };
}
