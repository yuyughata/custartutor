import { describe, expect, it } from 'vitest';
import type { TutorStreamEvent } from '@custar/tutor-core/client';
import {
  chatReducer,
  initialChatState,
  isBusy,
  type ChatAction,
  type ChatState,
} from './turnState';
import { MESSAGE, SESSION, request, turnResult } from './testkit';

const send = (state = initialChatState, text = 'Where does a fish live?'): ChatState =>
  chatReducer(state, {
    type: 'send',
    request: request({ input: { mode: 'text', text } }),
    childBubbleId: 'c1',
    tutorBubbleId: 't1',
  });

const event = (state: ChatState, e: TutorStreamEvent): ChatState =>
  chatReducer(state, { type: 'event', event: e });

const tutorText = (state: ChatState): string | undefined =>
  state.bubbles.find((bubble) => bubble.role === 'tutor')?.text;

describe('chatReducer', () => {
  it('adds the child bubble and an empty streaming tutor bubble on send', () => {
    const state = send();
    expect(state.bubbles.map((b) => [b.role, b.text])).toEqual([
      ['child', 'Where does a fish live?'],
      ['tutor', ''],
    ]);
    expect(state.phase).toBe('waiting');
    expect(isBusy(state)).toBe(true);
    expect(state.turn?.tutorBubbleId).toBe('t1');
  });

  it('streams deltas into the tutor bubble and remembers the session id from meta', () => {
    let state = send();
    state = event(state, { type: 'meta', session_id: SESSION, message_id: MESSAGE });
    state = event(state, { type: 'delta', text: 'A fish ' });
    state = event(state, { type: 'delta', text: 'lives in water.' });
    expect(tutorText(state)).toBe('A fish lives in water.');
    expect(state.phase).toBe('streaming');
    expect(state.sessionId).toBe(SESSION);
  });

  it('replace swaps the text that was shown', () => {
    let state = send();
    state = event(state, { type: 'delta', text: 'Something unsuitable' });
    state = event(state, {
      type: 'replace',
      text: 'Let us go back to our lesson.',
      reason: 'safety',
    });
    expect(tutorText(state)).toBe('Let us go back to our lesson.');
    expect(state.bubbles[1]?.replaced).toBe(true);
  });

  it('records the safety action without any alarming state', () => {
    let state = send();
    state = event(state, { type: 'safety', action: 'safe_reply' });
    state = event(state, { type: 'delta', text: 'I am glad you told me.' });
    expect(state.bubbles[1]?.safety).toBe('safe_reply');
    expect(state.error).toBeNull();
    expect(state.phase).toBe('streaming');
  });

  it('records a show_activity suggestion as advisory data on the bubble', () => {
    let state = send();
    state = event(state, {
      type: 'tool',
      name: 'show_activity',
      input: { question_id: 'q_practice_1' },
    });
    expect(state.bubbles[1]?.activity).toEqual({ questionId: 'q_practice_1' });
  });

  it('done stops the typing state; the result then finishes the turn with the stored text', () => {
    let state = send();
    state = event(state, { type: 'delta', text: 'A fish' });
    state = event(state, { type: 'done', message_id: MESSAGE });
    expect(state.bubbles[1]?.streaming).toBe(false);
    state = chatReducer(state, {
      type: 'result',
      result: turnResult({ reply: 'A fish lives in water.' }),
    });
    expect(tutorText(state)).toBe('A fish lives in water.');
    expect(state.phase).toBe('idle');
    expect(state.turn).toBeNull();
    expect(isBusy(state)).toBe(false);
  });

  it('shows the fixed reply from a blocked or safe-reply result even when nothing streamed', () => {
    const state = chatReducer(send(), {
      type: 'result',
      result: turnResult({
        status: 'safe_reply',
        safety_action: 'safe_reply',
        reply: 'Please tell a grown-up you trust.',
      }),
    });
    expect(tutorText(state)).toBe('Please tell a grown-up you trust.');
    expect(state.bubbles[1]?.safety).toBe('safe_reply');
    expect(state.phase).toBe('idle');
  });

  it('turns a failed stored result into a calm retry', () => {
    const state = chatReducer(send(), {
      type: 'result',
      result: turnResult({ status: 'failed', reply: null }),
    });
    expect(state.phase).toBe('failed');
    expect(state.error?.canRetry).toBe(true);
    expect(state.bubbles).toHaveLength(1); // the empty tutor bubble is gone
  });

  it('an error event removes the half reply and keeps the turn for retry', () => {
    let state = send();
    state = event(state, { type: 'delta', text: 'A fi' });
    state = event(state, { type: 'error', code: 'upstream', retryable: true });
    expect(state.phase).toBe('failed');
    expect(state.error?.kind).toBe('retry');
    expect(state.bubbles.map((b) => b.role)).toEqual(['child']);
    expect(state.turn?.clientTurnId).toBe(request().client_turn_id);
    // events after a failure are ignored
    state = event(state, { type: 'delta', text: 'late' });
    expect(state.bubbles).toHaveLength(1);
  });

  it('a rejected send maps to the typed copy', () => {
    const cases: [string, string][] = [
      ['consent_required', 'consent'],
      ['daily_limit', 'limit'],
      ['tutor_disabled', 'unavailable'],
      ['kill_switch', 'unavailable'],
      ['offline', 'offline'],
      ['unauthenticated', 'offline'],
    ];
    for (const [code, kind] of cases) {
      const state = chatReducer(send(), {
        type: 'failed',
        failure: { code: code as never, retryable: false },
      });
      expect(state.error?.kind, code).toBe(kind);
      expect(state.failure?.code).toBe(code);
    }
  });

  it('retry adds a fresh tutor bubble and can swap in a new request', () => {
    let state = chatReducer(send(), {
      type: 'failed',
      failure: { code: 'upstream', retryable: true },
    });
    const next = request({ client_turn_id: '00000000-0000-4000-8000-00000000d002' });
    state = chatReducer(state, { type: 'retry', tutorBubbleId: 't2', request: next });
    expect(state.phase).toBe('waiting');
    expect(state.error).toBeNull();
    expect(state.turn?.clientTurnId).toBe(next.client_turn_id);
    expect(state.bubbles.map((b) => b.id)).toEqual(['c1', 't2']);
  });

  it('ignores actions with no turn in flight', () => {
    const actions: ChatAction[] = [
      { type: 'event', event: { type: 'delta', text: 'x' } },
      { type: 'result', result: turnResult() },
      { type: 'failed', failure: { code: 'internal', retryable: true } },
    ];
    for (const action of actions) {
      expect(chatReducer(initialChatState, action)).toEqual(initialChatState);
    }
  });

  it('keeps the whole conversation across turns and sends the session id later', () => {
    let state = send();
    state = event(state, { type: 'meta', session_id: SESSION, message_id: MESSAGE });
    state = chatReducer(state, { type: 'result', result: turnResult() });
    state = send(state, 'And a bird?');
    expect(state.bubbles).toHaveLength(4);
    expect(state.sessionId).toBe(SESSION);
  });
});
