import { describe, expect, it } from 'vitest';
import { MAX_CHILD_MESSAGE_CHARS, TutorApiError } from '@custar/tutor-core/client';
import { buildTurnRequest, retryTurn, runTurn, sendableText } from './turnRunner';
import { chatReducer, initialChatState, type ChatAction, type ChatState } from './turnState';
import { CHILD, MESSAGE, SESSION, UNIT, fakeTutorApi, request, turnResult } from './testkit';

function harness() {
  let state: ChatState = initialChatState;
  const seen: ChatAction[] = [];
  const dispatch = (action: ChatAction) => {
    seen.push(action);
    state = chatReducer(state, action);
  };
  const start = (req = request()) =>
    dispatch({ type: 'send', request: req, childBubbleId: 'c1', tutorBubbleId: 't1' });
  return { dispatch, start, seen, get: () => state };
}

describe('sendableText', () => {
  it('trims, refuses empty text and caps the length', () => {
    expect(sendableText('  hello  ')).toBe('hello');
    expect(sendableText('   ')).toBeNull();
    expect(sendableText('a'.repeat(MAX_CHILD_MESSAGE_CHARS + 50))).toHaveLength(
      MAX_CHILD_MESSAGE_CHARS,
    );
  });
});

describe('buildTurnRequest', () => {
  it('builds a text turn with the lesson position and no empty optional fields', () => {
    const req = buildTurnRequest(
      { childId: CHILD, unitId: UNIT, versionNo: 3, sectionId: 'places', questionId: 'q1' },
      'Hello',
      'turn-1',
    );
    expect(req).toEqual({
      action: 'turn',
      child_id: CHILD,
      client_turn_id: 'turn-1',
      unit_id: UNIT,
      version_no: 3,
      section_id: 'places',
      question_id: 'q1',
      input: { mode: 'text', text: 'Hello' },
      helper_present: false,
    });
    const later = buildTurnRequest(
      { childId: CHILD, unitId: UNIT, versionNo: 1, sessionId: SESSION, helperPresent: true },
      'Hi',
      't2',
    );
    expect(later.session_id).toBe(SESSION);
    expect(later.helper_present).toBe(true);
    expect('section_id' in later).toBe(false);
  });
});

describe('runTurn', () => {
  it('feeds events to the reducer, then the stored result', async () => {
    const h = harness();
    h.start();
    const api = fakeTutorApi({
      sendTurn: async (_req, onEvent) => {
        onEvent({ type: 'meta', session_id: SESSION, message_id: MESSAGE });
        onEvent({ type: 'delta', text: 'A fish ' });
        onEvent({ type: 'delta', text: 'lives in water.' });
        onEvent({ type: 'done', message_id: MESSAGE });
        return turnResult();
      },
    });
    await runTurn({ api, request: request(), dispatch: h.dispatch });
    expect(h.get().bubbles[1]?.text).toBe('A fish lives in water.');
    expect(h.get().phase).toBe('idle');
    expect(h.get().sessionId).toBe(SESSION);
  });

  it('turns a typed rejection into a failure the screen can show', async () => {
    const h = harness();
    h.start();
    const api = fakeTutorApi({
      sendTurn: () => Promise.reject(new TutorApiError('daily_limit')),
    });
    await runTurn({ api, request: request(), dispatch: h.dispatch });
    expect(h.get().failure).toEqual({ code: 'daily_limit', retryable: false });
    expect(h.get().error?.title).toBe('That is enough tutor chat for today');
  });

  it('treats an unknown error as a retryable internal failure and never shows its text', async () => {
    const h = harness();
    h.start();
    const api = fakeTutorApi({
      sendTurn: () => Promise.reject(new Error('TypeError: Network request failed at 10.0.0.1')),
    });
    await runTurn({ api, request: request(), dispatch: h.dispatch });
    expect(h.get().failure).toEqual({ code: 'internal', retryable: true });
    expect(JSON.stringify(h.get().error)).not.toMatch(/TypeError|10\.0\.0\.1/);
  });

  it('is quiet when the turn was aborted (the panel was closed)', async () => {
    const h = harness();
    h.start();
    const controller = new AbortController();
    const api = fakeTutorApi({
      sendTurn: (_req, _onEvent, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          );
        }),
    });
    const run = runTurn({
      api,
      request: request(),
      dispatch: h.dispatch,
      signal: controller.signal,
    });
    controller.abort();
    await run;
    expect(h.get().phase).toBe('waiting'); // nothing dispatched after the abort
    expect(h.seen.filter((a) => a.type === 'failed')).toHaveLength(0);
  });
});

describe('retryTurn', () => {
  const ids = () => {
    let turns = 0;
    let bubbles = 0;
    return {
      newClientTurnId: () => `new-turn-${++turns}`,
      newBubbleId: () => `retry-bubble-${++bubbles}`,
    };
  };

  async function failedState(api = fakeTutorApi()) {
    const h = harness();
    h.start();
    h.dispatch({ type: 'event', event: { type: 'delta', text: 'A fi' } });
    h.dispatch({ type: 'failed', failure: { code: 'upstream', retryable: true } });
    return { h, api };
  }

  it('asks fetchTurn first and does NOT resend when the server already has the turn', async () => {
    const api = fakeTutorApi({
      fetchTurn: () => Promise.resolve(turnResult({ reply: 'A fish lives in water.' })),
    });
    const { h } = await failedState(api);
    await retryTurn({ api, request: request(), dispatch: h.dispatch, ...ids() });
    expect(api.calls.fetchTurn).toEqual([[CHILD, request().client_turn_id]]);
    expect(api.calls.sendTurn).toHaveLength(0);
    expect(h.get().bubbles.map((b) => b.text)).toEqual([
      'Where does a fish live?',
      'A fish lives in water.',
    ]);
    expect(h.get().phase).toBe('idle');
  });

  it('resends with the SAME client turn id when fetchTurn returns null', async () => {
    const api = fakeTutorApi({ fetchTurn: () => Promise.resolve(null) });
    const { h } = await failedState(api);
    await retryTurn({ api, request: request(), dispatch: h.dispatch, ...ids() });
    expect(api.calls.fetchTurn).toHaveLength(1);
    expect(api.calls.sendTurn.map((r) => r.client_turn_id)).toEqual([request().client_turn_id]);
    expect(h.get().phase).toBe('idle');
  });

  it('uses a NEW turn id when the server stored the turn as failed', async () => {
    const api = fakeTutorApi({
      fetchTurn: () => Promise.resolve(turnResult({ status: 'failed', reply: null })),
    });
    const { h } = await failedState(api);
    await retryTurn({ api, request: request(), dispatch: h.dispatch, ...ids() });
    expect(api.calls.sendTurn).toHaveLength(1);
    expect(api.calls.sendTurn[0]?.client_turn_id).toBe('new-turn-1');
    expect(h.get().turn).toBeNull();
    expect(h.get().phase).toBe('idle');
  });

  it('shows busy while it checks, and reports a fetchTurn failure calmly without resending', async () => {
    const api = fakeTutorApi({
      fetchTurn: () => Promise.reject(new TutorApiError('offline', undefined, true)),
    });
    const { h } = await failedState(api);
    const run = retryTurn({ api, request: request(), dispatch: h.dispatch, ...ids() });
    expect(h.get().phase).toBe('waiting');
    await run;
    expect(api.calls.sendTurn).toHaveLength(0);
    expect(h.get().phase).toBe('failed');
    expect(h.get().failure?.code).toBe('offline');
    expect(h.get().error?.offerLite).toBe(true);
  });

  it('a second failure after the resend lands in the same calm state', async () => {
    const api = fakeTutorApi({
      fetchTurn: () => Promise.resolve(null),
      sendTurn: () => Promise.reject(new TutorApiError('upstream', undefined, true)),
    });
    const { h } = await failedState(api);
    await retryTurn({ api, request: request(), dispatch: h.dispatch, ...ids() });
    expect(h.get().phase).toBe('failed');
    expect(h.get().error?.canRetry).toBe(true);
  });
});
