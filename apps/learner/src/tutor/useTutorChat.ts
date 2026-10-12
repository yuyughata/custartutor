import { useCallback, useEffect, useReducer, useRef } from 'react';
import type { TutorApi } from '@custar/tutor-core/client';
import { buildTurnRequest, retryTurn, runTurn, sendableText, type TurnTarget } from './turnRunner';
import { chatReducer, initialChatState, isBusy, type ChatState } from './turnState';

export interface UseTutorChat {
  state: ChatState;
  /** Sends the child's message. Returns false when nothing was sent (empty, or a reply is still coming). */
  send(rawText: string): boolean;
  /** After a failure: asks the server whether the turn finished, and only then resends. */
  retry(): void;
  /** Drops a failure that a retry cannot fix, so the child can ask a new question. */
  clearFailure(): void;
}

/**
 * The live chat of one lesson visit. State is in memory only; leaving the lesson screen drops it and aborts a
 * reply that is still streaming (the server keeps the turn under its client id).
 */
export function useTutorChat(options: {
  api: TutorApi;
  newId: () => string;
  /** Where the child is now. Read at send time, so it never goes stale. */
  target: () => Omit<TurnTarget, 'sessionId'>;
}): UseTutorChat {
  const { api, newId, target } = options;
  const [state, dispatch] = useReducer(chatReducer, initialChatState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const targetRef = useRef(target);
  targetRef.current = target;
  const controller = useRef<AbortController | null>(null);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const send = useCallback(
    (rawText: string): boolean => {
      const text = sendableText(rawText);
      if (text === null || isBusy(stateRef.current) || stateRef.current.phase === 'failed') {
        return false;
      }
      const request = buildTurnRequest(
        { ...targetRef.current(), sessionId: stateRef.current.sessionId },
        text,
        newId(),
      );
      dispatch({ type: 'send', request, childBubbleId: newId(), tutorBubbleId: newId() });
      controller.current = new AbortController();
      void runTurn({ api, request, dispatch, signal: controller.current.signal });
      return true;
    },
    [api, newId],
  );

  const retry = useCallback(() => {
    const turn = stateRef.current.turn;
    if (!turn || isBusy(stateRef.current)) return;
    controller.current = new AbortController();
    void retryTurn({
      api,
      request: turn.request,
      dispatch,
      signal: controller.current.signal,
      newClientTurnId: newId,
      newBubbleId: newId,
    });
  }, [api, newId]);

  const clearFailure = useCallback(() => dispatch({ type: 'clearFailure' }), []);

  return { state, send, retry, clearFailure };
}
