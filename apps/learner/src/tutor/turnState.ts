import type {
  SafetyAction,
  TutorChatRequest,
  TutorStreamEvent,
  TutorTurnResult,
} from '@custar/tutor-core/client';
import { errorView, type ErrorView, type TutorFailure } from './errorCopy';

/**
 * The chat of one lesson visit, as a pure reducer. It lives in memory only: nothing the child types is written
 * anywhere on the device, and it is gone when the lesson screen is left (plan section 2).
 */

export interface TutorBubble {
  /** Local id, only for list keys. */
  id: string;
  role: 'child' | 'tutor';
  text: string;
  /** Tutor bubbles only. */
  streaming?: boolean;
  /** The safety action the server reported for this reply (no category detail ever reaches the client). */
  safety?: SafetyAction;
  /** The practice question the tutor suggested (advisory; never mastery). */
  activity?: { questionId: string } | null;
  /** The server replaced the streamed text. */
  replaced?: boolean;
}

export interface ActiveTurn {
  clientTurnId: string;
  request: TutorChatRequest;
  tutorBubbleId: string;
}

export type ChatPhase = 'idle' | 'waiting' | 'streaming' | 'failed';

export interface ChatState {
  bubbles: TutorBubble[];
  /** Set by the first `meta` event; sent with later turns so the server keeps one session per lesson visit. */
  sessionId: string | null;
  /** The turn in flight, or the one that failed and can be retried. */
  turn: ActiveTurn | null;
  phase: ChatPhase;
  error: ErrorView | null;
  /** The failure behind `error`, for the controller (fall back to the offline tutor, retry). */
  failure: TutorFailure | null;
}

export const initialChatState: ChatState = {
  bubbles: [],
  sessionId: null,
  turn: null,
  phase: 'idle',
  error: null,
  failure: null,
};

export type ChatAction =
  | {
      type: 'send';
      request: TutorChatRequest;
      childBubbleId: string;
      tutorBubbleId: string;
    }
  | { type: 'event'; event: TutorStreamEvent }
  | { type: 'result'; result: TutorTurnResult }
  | { type: 'failed'; failure: TutorFailure }
  /** Retry after a failure: a new tutor bubble; the turn keeps (or is given) the client turn id to use. */
  | { type: 'retry'; tutorBubbleId: string; request?: TutorChatRequest }
  /** Forget a failure that retrying cannot fix (consent was off, the limit was reached), so the child can ask again. A retryable failure keeps its Try again card. */
  | { type: 'clearFailure' };

export function isBusy(state: ChatState): boolean {
  return state.phase === 'waiting' || state.phase === 'streaming';
}

function patchBubble(
  bubbles: TutorBubble[],
  id: string,
  patch: (bubble: TutorBubble) => TutorBubble,
): TutorBubble[] {
  return bubbles.map((bubble) => (bubble.id === id ? patch(bubble) : bubble));
}

function fail(state: ChatState, failure: TutorFailure): ChatState {
  const turn = state.turn;
  return {
    ...state,
    // A half-written reply is not shown; Retry starts the reply again.
    bubbles: turn
      ? state.bubbles.filter((bubble) => bubble.id !== turn.tutorBubbleId)
      : state.bubbles,
    phase: 'failed',
    failure,
    error: errorView(failure),
  };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'send':
      return {
        ...state,
        bubbles: [
          ...state.bubbles,
          { id: action.childBubbleId, role: 'child', text: action.request.input.text },
          { id: action.tutorBubbleId, role: 'tutor', text: '', streaming: true },
        ],
        turn: {
          clientTurnId: action.request.client_turn_id,
          request: action.request,
          tutorBubbleId: action.tutorBubbleId,
        },
        phase: 'waiting',
        error: null,
        failure: null,
      };

    case 'event': {
      const turn = state.turn;
      if (!turn || state.phase === 'failed') return state;
      const event = action.event;
      const id = turn.tutorBubbleId;
      switch (event.type) {
        case 'meta':
          return { ...state, sessionId: event.session_id };
        case 'delta':
          return {
            ...state,
            phase: 'streaming',
            bubbles: patchBubble(state.bubbles, id, (bubble) => ({
              ...bubble,
              text: bubble.text + event.text,
            })),
          };
        case 'replace':
          return {
            ...state,
            bubbles: patchBubble(state.bubbles, id, (bubble) => ({
              ...bubble,
              text: event.text,
              replaced: true,
            })),
          };
        case 'safety':
          return {
            ...state,
            bubbles: patchBubble(state.bubbles, id, (bubble) => ({
              ...bubble,
              safety: event.action,
            })),
          };
        case 'tool':
          return {
            ...state,
            bubbles: patchBubble(state.bubbles, id, (bubble) => ({
              ...bubble,
              activity: { questionId: event.input.question_id },
            })),
          };
        case 'done':
          return {
            ...state,
            bubbles: patchBubble(state.bubbles, id, (bubble) => ({ ...bubble, streaming: false })),
          };
        case 'error':
          return fail(state, { code: event.code, retryable: event.retryable });
        default:
          return state; // unknown event types are ignored (the contract says clients must)
      }
    }

    case 'result': {
      const turn = state.turn;
      if (!turn) return state;
      if (action.result.status === 'failed' && action.result.reply === null) {
        return fail(state, { code: 'upstream', retryable: true });
      }
      const result = action.result;
      return {
        ...state,
        sessionId: result.session_id,
        turn: null,
        phase: 'idle',
        error: null,
        failure: null,
        bubbles: patchBubble(state.bubbles, turn.tutorBubbleId, (bubble) => ({
          ...bubble,
          // The stored text is what the child should see; keep what streamed only when nothing was stored.
          text: result.reply ?? bubble.text,
          streaming: false,
          safety: result.safety_action !== 'allow' ? result.safety_action : bubble.safety,
          activity: result.show_activity
            ? { questionId: result.show_activity.question_id }
            : (bubble.activity ?? null),
          ...(result.status === 'replaced' ? { replaced: true } : {}),
        })),
      };
    }

    case 'failed':
      return state.turn ? fail(state, action.failure) : state;

    case 'retry': {
      const turn = state.turn;
      if (!turn) return state;
      const request = action.request ?? turn.request;
      return {
        ...state,
        bubbles: [
          ...state.bubbles.filter((bubble) => bubble.id !== turn.tutorBubbleId),
          { id: action.tutorBubbleId, role: 'tutor', text: '', streaming: true },
        ],
        turn: {
          clientTurnId: request.client_turn_id,
          request,
          tutorBubbleId: action.tutorBubbleId,
        },
        phase: 'waiting',
        error: null,
        failure: null,
      };
    }

    case 'clearFailure':
      return state.phase === 'failed' && !state.error?.canRetry
        ? { ...state, phase: 'idle', turn: null, error: null, failure: null }
        : state;
  }
}
