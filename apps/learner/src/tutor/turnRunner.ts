import {
  MAX_CHILD_MESSAGE_CHARS,
  type TutorApi,
  type TutorChatRequest,
} from '@custar/tutor-core/client';
import { toFailure } from './errorCopy';
import type { ChatAction } from './turnState';

/**
 * Runs one tutor turn against a `TutorApi` and reports it as reducer actions. Pure of React and of storage:
 * the message text goes to the API and into the reducer, and nowhere else (never logged, never persisted).
 */

export interface TurnTarget {
  childId: string;
  unitId: string;
  versionNo: number;
  sectionId?: string | undefined;
  questionId?: string | undefined;
  sessionId?: string | null | undefined;
  helperPresent?: boolean | undefined;
}

/** The text the child may send: trimmed, not empty, at most MAX_CHILD_MESSAGE_CHARS. Null when not sendable. */
export function sendableText(raw: string): string | null {
  const text = raw.trim();
  if (text.length === 0) return null;
  return text.length > MAX_CHILD_MESSAGE_CHARS ? text.slice(0, MAX_CHILD_MESSAGE_CHARS) : text;
}

export function buildTurnRequest(
  target: TurnTarget,
  text: string,
  clientTurnId: string,
): TutorChatRequest {
  return {
    action: 'turn',
    child_id: target.childId,
    client_turn_id: clientTurnId,
    ...(target.sessionId ? { session_id: target.sessionId } : {}),
    unit_id: target.unitId,
    version_no: target.versionNo,
    ...(target.sectionId ? { section_id: target.sectionId } : {}),
    ...(target.questionId ? { question_id: target.questionId } : {}),
    input: { mode: 'text', text },
    helper_present: target.helperPresent ?? false,
  };
}

export interface RunOptions {
  api: TutorApi;
  request: TutorChatRequest;
  dispatch: (action: ChatAction) => void;
  signal?: AbortSignal | undefined;
}

function wasAborted(signal: AbortSignal | undefined, error: unknown): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === 'AbortError');
}

/** Sends the turn and streams its events into `dispatch`. Resolves when the turn ended, well or badly. */
export async function runTurn({ api, request, dispatch, signal }: RunOptions): Promise<void> {
  try {
    const result = await api.sendTurn(
      request,
      (event) => dispatch({ type: 'event', event }),
      signal,
    );
    if (signal?.aborted) return;
    dispatch({ type: 'result', result });
  } catch (error) {
    if (wasAborted(signal, error)) return;
    dispatch({ type: 'failed', failure: toFailure(error) });
  }
}

export interface RetryOptions extends RunOptions {
  /** Makes the id for a brand-new turn, used when the stored turn had failed on the server. */
  newClientTurnId: () => string;
  /** Makes the local id of the tutor bubble the retried reply streams into. */
  newBubbleId: () => string;
}

/**
 * A retry after a failure. The server keeps every turn under its `client_turn_id`, so the first question is
 * whether the turn already finished there (a dropped stream often means it did): ask with `fetchTurn`, and
 * resend only when it returns null. A turn the server stored as failed gets a new id, because the same id
 * would just return that failure again.
 */
export async function retryTurn({
  api,
  request,
  dispatch,
  signal,
  newClientTurnId,
  newBubbleId,
}: RetryOptions): Promise<void> {
  const bubbleId = newBubbleId();
  dispatch({ type: 'retry', tutorBubbleId: bubbleId });
  try {
    const stored = await api.fetchTurn(request.child_id, request.client_turn_id);
    if (signal?.aborted) return;
    if (stored && stored.status !== 'failed') {
      dispatch({ type: 'result', result: stored });
      return;
    }
    let resend = request;
    if (stored) {
      resend = { ...request, client_turn_id: newClientTurnId() };
      dispatch({ type: 'retry', tutorBubbleId: bubbleId, request: resend });
    }
    await runTurn({ api, request: resend, dispatch, ...(signal ? { signal } : {}) });
  } catch (error) {
    if (wasAborted(signal, error)) return;
    dispatch({ type: 'failed', failure: toFailure(error) });
  }
}
