// Helpers for the tutor tests only. Nothing in the app imports this file.
import { matchText, type TutorNode, type TutorScript } from '@custar/content-schema';
import type {
  TutorApi,
  TutorChatRequest,
  TutorConsentState,
  TutorLiteLine,
  TutorLiteState,
  TutorLiteStep,
  TutorSessionSummary,
  TutorStreamEvent,
  TutorTranscriptMessage,
  TutorTurnResult,
} from '@custar/tutor-core/client';
import type { LiteContext, LiteEngine } from './liteEngine';

export const CHILD = '00000000-0000-4000-8000-00000000c1a0';
export const UNIT = '00000000-0000-4000-8000-0000000000a1';
export const SESSION = '00000000-0000-4000-8000-0000000005e1';
export const MESSAGE = '00000000-0000-4000-8000-0000000000e1';

export function turnResult(overrides: Partial<TutorTurnResult> = {}): TutorTurnResult {
  return {
    session_id: SESSION,
    message_id: MESSAGE,
    status: 'complete',
    reply: 'A fish lives in water.',
    safety_action: 'allow',
    show_activity: null,
    ...overrides,
  };
}

export function request(overrides: Partial<TutorChatRequest> = {}): TutorChatRequest {
  return {
    action: 'turn',
    child_id: CHILD,
    client_turn_id: '00000000-0000-4000-8000-00000000d001',
    unit_id: UNIT,
    version_no: 1,
    input: { mode: 'text', text: 'Where does a fish live?' },
    helper_present: false,
    ...overrides,
  };
}

export interface FakeTutorApi extends TutorApi {
  calls: { sendTurn: TutorChatRequest[]; fetchTurn: [string, string][] };
}

export function fakeTutorApi(
  behaviour: {
    sendTurn?: (
      request: TutorChatRequest,
      onEvent: (event: TutorStreamEvent) => void,
      signal?: AbortSignal,
    ) => Promise<TutorTurnResult>;
    fetchTurn?: (childId: string, clientTurnId: string) => Promise<TutorTurnResult | null>;
    consent?: TutorConsentState;
    sessions?: TutorSessionSummary[];
    transcript?: TutorTranscriptMessage[];
  } = {},
): FakeTutorApi {
  const calls: FakeTutorApi['calls'] = { sendTurn: [], fetchTurn: [] };
  return {
    calls,
    consent: () =>
      Promise.resolve(behaviour.consent ?? { granted: true, version: 'v', required_version: 'v' }),
    setConsent: () => Promise.resolve(),
    sendTurn: (req, onEvent, signal) => {
      calls.sendTurn.push(req);
      return behaviour.sendTurn
        ? behaviour.sendTurn(req, onEvent, signal)
        : Promise.resolve(turnResult());
    },
    fetchTurn: (childId, clientTurnId) => {
      calls.fetchTurn.push([childId, clientTurnId]);
      return behaviour.fetchTurn
        ? behaviour.fetchTurn(childId, clientTurnId)
        : Promise.resolve(null);
    },
    listSessions: () => Promise.resolve(behaviour.sessions ?? []),
    getTranscript: () => Promise.resolve(behaviour.transcript ?? []),
  };
}

// ---- a simple scripted Tutor Lite engine, just enough to test the controller --------------------

const line = (node: TutorNode, text: string, kind: TutorLiteLine['kind']): TutorLiteLine => ({
  node_id: node.id,
  text,
  kind,
});

function nextIndex(script: TutorScript, node: TutorNode): number {
  if (node.next) return script.nodes.findIndex((candidate) => candidate.id === node.next);
  return script.nodes.findIndex((candidate) => candidate.id === node.id) + 1;
}

function present(
  script: TutorScript,
  index: number,
  state: TutorLiteState,
  lines: TutorLiteLine[],
): TutorLiteStep {
  let at = index;
  for (;;) {
    const node = script.nodes[at];
    if (!node) {
      return {
        state: { ...state, node_id: null, finished: true },
        lines,
        expecting: false,
        graded: null,
      };
    }
    lines.push(line(node, node.say, 'say'));
    if (node.expect) {
      return { state: { ...state, node_id: node.id }, lines, expecting: true, graded: null };
    }
    at = nextIndex(script, node);
  }
}

export function fakeLiteEngine(): LiteEngine {
  const emptyState: TutorLiteState = {
    node_id: null,
    attempts: 0,
    hints_used: 0,
    cursors: {},
    finished: false,
  };
  const current = (context: LiteContext, state: TutorLiteState) =>
    context.script.nodes.find((node) => node.id === state.node_id);
  return {
    start: (context) => present(context.script, 0, emptyState, []),
    reply(context, state, text) {
      const node = current(context, state);
      if (!node) return { state, lines: [], expecting: false, graded: null };
      const accepted = node.expect?.accepted ?? [];
      const correct = matchText(text, accepted) !== null;
      if (!correct) {
        const next = { ...state, attempts: state.attempts + 1 };
        return {
          state: next,
          lines: node.on_incorrect[0] ? [line(node, node.on_incorrect[0], 'incorrect')] : [],
          expecting: true,
          graded: { correct: false },
        };
      }
      const lines = node.on_correct[0] ? [line(node, node.on_correct[0], 'correct')] : [];
      const step = present(
        context.script,
        nextIndex(context.script, node),
        { ...state, attempts: 0, hints_used: 0 },
        lines,
      );
      return { ...step, graded: { correct: true } };
    },
    hint(context, state) {
      const node = current(context, state);
      const text = node?.hint[state.hints_used];
      return {
        state: { ...state, hints_used: state.hints_used + 1 },
        lines: node && text ? [line(node, text, 'hint')] : [],
        expecting: true,
        graded: null,
      };
    },
    skip(context, state) {
      const node = current(context, state);
      if (!node) return { state, lines: [], expecting: false, graded: null };
      return present(context.script, nextIndex(context.script, node), state, []);
    },
  };
}

export const DEMO_SCRIPT: TutorScript = {
  nodes: [
    {
      id: 'n_hello',
      say: 'Hello! Let us talk about water.',
      on_correct: [],
      on_incorrect: [],
      hint: [],
    },
    {
      id: 'n_ask',
      say: 'Where does a fish live?',
      expect: { accepted: ['water', 'in water', 'the river'] },
      on_correct: ['Yes! A fish lives in water.'],
      on_incorrect: ['Not quite. Think about a river.'],
      hint: ['It is wet.', 'Rivers and seas have it.'],
    },
    {
      id: 'n_ask2',
      say: 'What do we drink?',
      expect: { accepted: ['water'] },
      on_correct: ['Good!'],
      on_incorrect: ['Try again.'],
      hint: ['It is clear.'],
    },
    { id: 'n_bye', say: 'Well done today.', on_correct: [], on_incorrect: [], hint: [] },
  ],
};
