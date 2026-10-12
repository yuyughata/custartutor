// Tests of the `tutor-chat` handler with a fake database and a FAKE RUN standing in for the pipeline (the real pipeline is
// exercised in tutor-chat-integration.test.ts). Every gate and its code and status, the order of the gates, no model call
// before they pass, idempotent replay, fetch_turn, busy, the daily budget, consent, the kill switch, the unit fallback,
// what is persisted (redacted text only), usage logging, the shape and order of the stream, a client that goes away,
// CORS, and that nothing secret or private reaches a response, a log or the database.
import { describe, expect, it, vi } from 'vitest';
import * as contract from '../../../packages/tutor-core/src/contract';
import {
  MESSAGE_OF_CODE,
  RETRYABLE,
  STATUS_OF_CODE,
  TUTOR_ERROR_CODES,
} from './tutor-chat-errors.ts';
import { NOT_SAVED_TEXT, corsHeadersFor, decodeJwtClaims, isAllowedOrigin } from './tutor-chat-handler.ts';
import {
  ALLOW,
  GA,
  GB,
  IDS,
  PL,
  SECRET_ANSWER,
  TU,
  USAGE_MODERATION,
  USAGE_TUTOR,
  base64url,
  core,
  delta,
  fakeRun,
  makeEnv,
  makeJwt,
  okOutcome,
  readSse,
  runTurnToEnd,
} from './tutor-chat-test-kit.ts';
import type { Env } from './tutor-chat-test-kit.ts';
import type { TutorTurnOutcome } from './tutor-chat-types.ts';

const RAW = 'RAWMARKER my number is 08031234567 and mail ada@example.com';

async function errorOf(response: Response): Promise<{ status: number; code: string; retryable: boolean; message: string }> {
  const body = (await response.json()) as { error: { code: string; message: string; retryable: boolean } };
  return { status: response.status, ...body.error };
}

/** The service-role RPCs that move money or state; none of them may run before the gates have passed. */
const SPENDING = ['tutor_reserve_turn', 'tutor_open_session', 'tutor_save_turn', 'tutor_log_usage'];

function expectNothingSpent(env: Env): void {
  expect(env.inputs).toHaveLength(0);
  for (const name of SPENDING) expect(env.serviceCalls()).not.toContain(name);
}

describe('the contract and the handler agree', () => {
  it('has the contract error codes, each with a status, a sentence and a retry flag', () => {
    expect([...TUTOR_ERROR_CODES]).toEqual([...contract.TUTOR_ERROR_CODES]);
    for (const code of TUTOR_ERROR_CODES) {
      expect(STATUS_OF_CODE[code]).toBeGreaterThanOrEqual(400);
      expect(MESSAGE_OF_CODE[code].length).toBeGreaterThan(5);
      expect(typeof RETRYABLE[code]).toBe('boolean');
    }
  });

  it('knows the consent version and the prompt version of the contract', () => {
    const env = makeEnv();
    expect(env.deps.core.CURRENT_TUTOR_CONSENT_VERSION).toBe(contract.CURRENT_TUTOR_CONSENT_VERSION);
  });
});

describe('transport: CORS, method, JWT, body', () => {
  it('answers a preflight from an allowed origin with the allow-list origin, never *', async () => {
    const env = makeEnv();
    const response = await env.send(null, { method: 'OPTIONS', origin: 'https://app.example.com' });
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain('POST');
    expect(response.headers.get('Access-Control-Allow-Headers')).toContain('authorization');
    expect(response.headers.get('Vary')).toBe('Origin');
  });

  it('refuses a preflight and a request from an origin that is not allowed', async () => {
    const env = makeEnv();
    const preflight = await env.send(null, { method: 'OPTIONS', origin: 'https://evil.example.com' });
    expect(preflight.status).toBe(403);
    expect(preflight.headers.get('Access-Control-Allow-Origin')).toBeNull();
    const post = await env.send(env.turnBody(), { origin: 'https://evil.example.com' });
    expect(post.status).toBe(403);
    expect(post.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expectNothingSpent(env);
  });

  it('allows localhost for development and answers a native app (no Origin header) without CORS headers', async () => {
    const env = makeEnv();
    const local = await env.send(null, { method: 'OPTIONS', origin: 'http://localhost:8081' });
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:8081');
    const native = await env.send(env.turnBody());
    expect(native.status).toBe(200);
    expect(native.headers.get('Access-Control-Allow-Origin')).toBeNull();
    await readSse(native);
    await env.flush();
    const strict = makeEnv();
    strict.deps.allowLocalhost = false;
    const refused = await strict.send(null, { method: 'OPTIONS', origin: 'http://localhost:8081' });
    expect(refused.status).toBe(403);
  });

  it('reflects the origin on a streamed answer and exposes the grounding headers', async () => {
    const env = makeEnv();
    const response = await env.send(env.turnBody(), { origin: 'https://app.example.com' });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe('https://app.example.com');
    expect(response.headers.get('Access-Control-Expose-Headers')).toContain('X-Tutor-Grounding-Version');
    await readSse(response);
    await env.flush();
  });

  it('accepts POST only', async () => {
    const env = makeEnv();
    const response = await env.send(null, { method: 'GET' });
    expect(await errorOf(response)).toMatchObject({ status: 405, code: 'invalid_request' });
  });

  it('401s a missing, malformed, expired or wrong-role token before anything else', async () => {
    const env = makeEnv();
    expect(await errorOf(await env.send(env.turnBody(), { token: null }))).toMatchObject({ status: 401, code: 'unauthenticated', retryable: false });
    expect(await errorOf(await env.send(env.turnBody(), { token: 'not-a-jwt' }))).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await errorOf(await env.send(env.turnBody(), { exp: Math.floor(env.clock.t / 1000) - 10 }))).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await errorOf(await env.send(env.turnBody(), { role: 'anon' }))).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(await errorOf(await env.send(env.turnBody(), { token: makeJwt({ role: 'authenticated' }) }))).toMatchObject({ status: 401, code: 'unauthenticated' });
    expect(env.userDbs).toHaveLength(0);
    expectNothingSpent(env);
  });

  it('400s a body that is not JSON, is too large, or does not fit the contract, naming fields and never values', async () => {
    const env = makeEnv();
    expect(await errorOf(await env.send(null, { rawBody: '{nope' }))).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(await errorOf(await env.send(null, { rawBody: 'x'.repeat(20_000) }))).toMatchObject({ status: 413, code: 'invalid_request' });
    const tooLong = await errorOf(await env.send(env.turnBody({ input: { mode: 'text', text: `${RAW} ${'a'.repeat(600)}` } })));
    expect(tooLong).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(tooLong.message).toContain('input.text');
    expect(JSON.stringify(tooLong)).not.toContain('RAWMARKER');
    expect(await errorOf(await env.send(env.turnBody({ child_id: 'not-a-uuid' })))).toMatchObject({ status: 400 });
    expect(await errorOf(await env.send(env.turnBody({ action: 'dance' })))).toMatchObject({ status: 400 });
    expect(await errorOf(await env.send(env.turnBody({ input: { mode: 'text', text: '' } })))).toMatchObject({ status: 400 });
    expect(await errorOf(await env.send(env.turnBody({ version_no: 0 })))).toMatchObject({ status: 400 });
    expectNothingSpent(env);
  });
});

describe('the gates, in order, and no model call before they pass', () => {
  it('403s a child that is not the caller\'s, a child that does not exist and a deleted child with the very same answer', async () => {
    const env = makeEnv();
    const other = await errorOf(await env.send(env.turnBody({ child_id: IDS.chidi })));
    const missing = await errorOf(await env.send(env.turnBody({ child_id: 'e9d00000-0000-4000-8000-0000000000aa' })));
    const gone = await errorOf(await env.send(env.turnBody({ child_id: IDS.gone })));
    expect(other).toMatchObject({ status: 403, code: 'forbidden', retryable: false });
    expect(missing).toEqual(other);
    expect(gone).toEqual(other);
    expectNothingSpent(env);
    expect(env.serviceCalls()).toEqual([]);
  });

  it('403s a granted tutor (guardians only) and a user with no household, as forbidden', async () => {
    const env = makeEnv();
    expect(await errorOf(await env.send(env.turnBody(), { sub: TU }))).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await errorOf(await env.send(env.turnBody(), { sub: PL }))).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await errorOf(await env.send(env.turnBody(), { sub: GB }))).toMatchObject({ status: 403, code: 'forbidden' });
    expectNothingSpent(env);
  });

  it('503s tutor_disabled when the switch is off, and when the database says there is no confirmed owner', async () => {
    const off = makeEnv({ tutorSettings: { enabled: false } });
    expect(await errorOf(await off.send(off.turnBody()))).toMatchObject({ status: 503, code: 'tutor_disabled', retryable: false });
    expectNothingSpent(off);
    const noOwner = makeEnv({ tutorSettings: { owner: null } });
    expect(await errorOf(await noOwner.send(noOwner.turnBody()))).toMatchObject({ status: 503, code: 'tutor_disabled' });
    const unconfirmed = makeEnv({ tutorSettings: { owner: { name: 'N', contact: 'c', confirmed_at: '' } } });
    expect(await errorOf(await unconfirmed.send(unconfirmed.turnBody()))).toMatchObject({ status: 503, code: 'tutor_disabled' });
    expectNothingSpent(unconfirmed);
  });

  it('503s kill_switch when ai.kill_switch is on', async () => {
    const env = makeEnv({ settings: { kill_switch: true } });
    expect(await errorOf(await env.send(env.turnBody()))).toMatchObject({ status: 503, code: 'kill_switch', retryable: false });
    expectNothingSpent(env);
  });

  it('checks tutor.enabled before the kill switch, and the kill switch before consent', async () => {
    const both = makeEnv({ tutorSettings: { enabled: false }, settings: { kill_switch: true }, consented: [] });
    expect((await errorOf(await both.send(both.turnBody()))).code).toBe('tutor_disabled');
    const killAndNoConsent = makeEnv({ settings: { kill_switch: true }, consented: [] });
    expect((await errorOf(await killAndNoConsent.send(killAndNoConsent.turnBody()))).code).toBe('kill_switch');
  });

  it('403s consent_required without a consent, after a withdrawal, and for another version of the text', async () => {
    const none = makeEnv({ consented: [] });
    expect(await errorOf(await none.send(none.turnBody()))).toMatchObject({ status: 403, code: 'consent_required', retryable: false });
    expectNothingSpent(none);

    const withdrawn = makeEnv();
    withdrawn.backend.withdrawConsent(IDS.ada);
    expect((await errorOf(await withdrawn.send(withdrawn.turnBody()))).code).toBe('consent_required');
    expectNothingSpent(withdrawn);

    const old = makeEnv({ consented: [] });
    old.backend.grantConsent(IDS.ada, 'tutor-v0');
    expect((await errorOf(await old.send(old.turnBody()))).code).toBe('consent_required');
    expectNothingSpent(old);

    const other = makeEnv({ consented: [IDS.bola] });
    expect((await errorOf(await other.send(other.turnBody()))).code).toBe('consent_required');
    expect((await other.send(other.turnBody({ child_id: IDS.bola }))).status).toBe(200);
    await other.flush();
  });

  it('a consent given again after a withdrawal works (the latest row wins)', async () => {
    const env = makeEnv();
    env.backend.withdrawConsent(IDS.ada);
    env.backend.grantConsent(IDS.ada);
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.at(-1)?.type).toBe('done');
  });

  it('404s a unit that is not published, before any state changes', async () => {
    const env = makeEnv();
    expect(await errorOf(await env.send(env.turnBody({ unit_id: IDS.unpublished })))).toMatchObject({ status: 404, code: 'unit_not_found', retryable: false });
    expectNothingSpent(env);
    expect(env.prepared).toHaveLength(0);
  });

  it('500s, without spending anything, when the unit content cannot be prepared or the key is missing', async () => {
    const broken = makeEnv({
      prepareUnit: () => {
        throw new Error('content did not parse: secret-detail');
      },
    });
    const brokenError = await errorOf(await broken.send(broken.turnBody()));
    expect(brokenError).toMatchObject({ status: 500, code: 'internal', retryable: true });
    expect(JSON.stringify(brokenError)).not.toContain('secret-detail');
    expectNothingSpent(broken);

    const noKey = makeEnv({ hasKey: false });
    expect(await errorOf(await noKey.send(noKey.turnBody()))).toMatchObject({ status: 500, code: 'internal' });
    expectNothingSpent(noKey);
    expect(noKey.logs.map((l) => l.event)).toContain('anthropic_key_missing');
  });

  it('429s daily_limit after the limit, without a model call, and a refused turn is not counted', async () => {
    const env = makeEnv({ tutorSettings: { daily_turns_per_child: 2 } });
    await runTurnToEnd(env, { client_turn_id: IDS.turn(1) });
    await runTurnToEnd(env, { client_turn_id: IDS.turn(2) });
    expect(env.inputs).toHaveLength(2);
    const third = await errorOf(await env.send(env.turnBody({ client_turn_id: IDS.turn(3) })));
    expect(third).toMatchObject({ status: 429, code: 'daily_limit', retryable: false });
    expect(env.inputs).toHaveLength(2);
    const day = [...env.backend.days.values()];
    expect(day.map((d) => d.turns)).toEqual([2]);
    // another child has a budget of their own
    expect((await env.send(env.turnBody({ child_id: IDS.bola, client_turn_id: IDS.turn(4) }))).status).toBe(200);
    await env.flush();
  });

  it('409s busy when a turn of the session is still running, and the second turn costs a count only once', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = makeEnv({
      runTurn: () => fakeRun({ events: [delta('slow')], outcome: okOutcome('slow'), gate }),
    });
    const first = await env.send(env.turnBody({ client_turn_id: IDS.turn(1) }));
    expect(first.status).toBe(200);
    const firstReader = first.body!.getReader();
    const firstChunk = await firstReader.read();
    const sessionId = (JSON.parse(new TextDecoder().decode(firstChunk.value).replace('data: ', '').trim()) as { session_id: string }).session_id;

    // a second, different turn of the same session
    const second = await errorOf(await env.send(env.turnBody({ client_turn_id: IDS.turn(2), session_id: sessionId })));
    expect(second).toMatchObject({ status: 409, code: 'busy', retryable: true });
    // the same turn submitted twice while it runs: busy too, and one session only
    const duplicate = await errorOf(await env.send(env.turnBody({ client_turn_id: IDS.turn(1) })));
    expect(duplicate).toMatchObject({ status: 409, code: 'busy' });
    expect(env.backend.sessions).toHaveLength(1);
    expect(env.inputs).toHaveLength(1);

    release();
    let done = false;
    while (!done) done = (await firstReader.read()).done;
    await env.flush();
    // free again
    const third = await env.send(env.turnBody({ client_turn_id: IDS.turn(3), session_id: sessionId }));
    expect(third.status).toBe(200);
    await readSse(third);
    await env.flush();
  });

  it('400s a session id that is not the child\'s, without leaking whether it exists', async () => {
    const env = makeEnv();
    const first = await runTurnToEnd(env);
    const sessionId = (first.sse.events[0] as { session_id: string }).session_id;
    const wrongChild = await errorOf(await env.send(env.turnBody({ child_id: IDS.bola, client_turn_id: IDS.turn(9), session_id: sessionId })));
    const unknown = await errorOf(await env.send(env.turnBody({ client_turn_id: IDS.turn(10), session_id: 'e9e00000-0000-4000-8000-0000000000ee' })));
    expect(wrongChild).toMatchObject({ status: 400, code: 'invalid_request' });
    expect(unknown).toEqual(wrongChild);
    const otherUnit = await errorOf(await env.send(env.turnBody({ client_turn_id: IDS.turn(11), session_id: sessionId, unit_id: IDS.unit2, version_no: 1 })));
    expect(otherUnit.code).toBe('invalid_request');
  });

  it('runs the gates in the documented order (a table of requests that fail several at once)', async () => {
    const cases: Array<[string, () => Promise<string>]> = [];
    const mk = (label: string, env: Env, body: Record<string, unknown>, options = {}): void => {
      cases.push([label, async () => (await errorOf(await env.send(body, options))).code]);
    };
    const all = makeEnv({ tutorSettings: { enabled: false, daily_turns_per_child: 1 }, settings: { kill_switch: true }, consented: [] });
    mk('not the guardian beats everything', all, all.turnBody({ unit_id: IDS.unpublished }), { sub: GB });
    mk('disabled beats kill switch', all, all.turnBody({ unit_id: IDS.unpublished }));
    const kill = makeEnv({ settings: { kill_switch: true }, consented: [] });
    mk('kill switch beats consent', kill, kill.turnBody({ unit_id: IDS.unpublished }));
    const consent = makeEnv({ consented: [] });
    mk('consent beats the unit', consent, consent.turnBody({ unit_id: IDS.unpublished }));
    const unit = makeEnv({ hasKey: false });
    mk('the unit beats the key', unit, unit.turnBody({ unit_id: IDS.unpublished }));
    const results = await Promise.all(cases.map(async ([label, run]) => [label, await run()] as const));
    expect(Object.fromEntries(results)).toEqual({
      'not the guardian beats everything': 'forbidden',
      'disabled beats kill switch': 'tutor_disabled',
      'kill switch beats consent': 'kill_switch',
      'consent beats the unit': 'consent_required',
      'the unit beats the key': 'unit_not_found',
    });
  });
});

describe('a turn that passes: the stream, the input, the storage', () => {
  it('streams meta first, the deltas in order and done last, as SSE frames', async () => {
    const env = makeEnv();
    const { response, sse } = await runTurnToEnd(env);
    expect(response.headers.get('Content-Type')).toBe('text/event-stream; charset=utf-8');
    expect(response.headers.get('Cache-Control')).toContain('no-cache');
    expect(response.headers.get('X-Tutor-Grounding-Version')).toBe('2');
    expect(response.headers.get('X-Tutor-Grounding-Fallback')).toBeNull();
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'done']);
    for (const frame of sse.frames) expect(frame.startsWith('data: ')).toBe(true);
    expect(sse.raw.endsWith('\n\n')).toBe(true);
    const meta = sse.events[0] as { session_id: string; message_id: string };
    expect(meta.session_id).toBe(env.backend.sessions[0]?.id);
    const done = sse.events.at(-1) as { message_id: string };
    expect(done.message_id).toBe(meta.message_id);
    // every event is valid under the contract
    for (const event of sse.events) expect(contract.TutorStreamEvent.safeParse(event).success).toBe(true);
  });

  it('sends done only after the turn is stored', async () => {
    let release!: () => void;
    const gateOutcome = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = makeEnv({
      runTurn: () => fakeRun({ events: [delta('Hello')], outcome: okOutcome('Hello'), gateOutcome }),
    });
    const response = await env.send(env.turnBody());
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"delta"')) text += decoder.decode((await reader.read()).value);
    // the reply has been streamed, but the turn is not stored yet and there is no done
    expect(env.backend.messages).toHaveLength(0);
    expect(text).not.toContain('"done"');
    release();
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      text += decoder.decode(chunk.value);
    }
    expect(text).toContain('"done"');
    expect(env.backend.messages).toHaveLength(2);
    await env.flush();
  });

  it('builds the pipeline input from the database: the alias only, the stage, the reading mode, the cast, the names to remove', async () => {
    const env = makeEnv();
    await runTurnToEnd(env, { section_id: 'sec_1', question_id: 'q_1', helper_present: true });
    expect(env.inputs).toHaveLength(1);
    const input = env.inputs[0]!;
    expect(input.child).toEqual({ alias: 'Ada', level_code: 'P1', stage: 'absorb', reading_mode: 'reader' });
    expect(Object.keys(input.child).sort()).toEqual(['alias', 'level_code', 'reading_mode', 'stage']);
    expect(input.position).toEqual({ section_id: 'sec_1', question_id: 'q_1' });
    expect(input.helper_present).toBe(true);
    expect(input.message).toEqual({ mode: 'text', text: 'hello tutor' });
    expect(input.history).toEqual([]);
    expect(input.cast.map((member) => member.slug)).toEqual(['zari', 'zuri']);
    expect(input.known_names?.sort()).toEqual(['Mr Bello', 'Mrs Okafor']);
    expect(input.ids?.session_id).toBe(env.backend.sessions[0]?.id);
    expect(input.ids?.message_id).toMatch(/^b1000000-/);
    expect(input.mastery_guard).toEqual([[SECRET_ANSWER]]);
    expect(env.logs.map((l) => l.event)).toContain('cast_member_skipped');
    // nothing else about the child, the household or the unit's answers is in the input
    const serialised = JSON.stringify(input);
    for (const forbidden of ['lion', 'avatar', 'daily_limit', 'household', IDS.householdA, 'Chidi', GA, TU]) {
      expect(serialised).not.toContain(forbidden);
    }
    expect(env.contexts[0]!.models).toEqual({ authoring: 'claude-opus-5-5', tutor: 'claude-sonnet-5-5', moderation: 'claude-haiku-5-5' });
    expect(env.contexts[0]!.settings.enabled).toBe(true);
    expect(env.contexts[0]!.signal.aborted).toBe(false);
  });

  it('passes a voice message as voice and a pre-reader as a pre-reader of the right stage', async () => {
    const env = makeEnv();
    await runTurnToEnd(env, { child_id: IDS.bola, input: { mode: 'voice', text: 'what is a leaf', confidence: 0.8 } });
    expect(env.inputs[0]!.child).toEqual({ alias: 'Bola', level_code: 'P2', stage: 'connect', reading_mode: 'pre_reader' });
    expect(env.inputs[0]!.message).toEqual({ mode: 'voice', text: 'what is a leaf' });
    expect(env.backend.messages.find((m) => m.role === 'child')?.input_mode).toBe('voice');
  });

  it('gives the pipeline the history of the session (completed turns), newest last', async () => {
    const env = makeEnv({
      runTurn: (input) =>
        fakeRun({
          events: [delta('ok')],
          outcome: okOutcome(`reply to ${input.message.text}`, { child_text_redacted: input.message.text }),
        }),
    });
    const first = await runTurnToEnd(env, { input: { mode: 'text', text: 'first question' } });
    const sessionId = (first.sse.events[0] as { session_id: string }).session_id;
    await runTurnToEnd(env, { client_turn_id: IDS.turn(2), session_id: sessionId, input: { mode: 'text', text: 'second question' } });
    expect(env.inputs[1]!.history).toEqual([
      { role: 'child', text: 'first question' },
      { role: 'tutor', text: 'reply to first question' },
    ]);
  });

  it('uses the requested version when the caller can read it, else the current one, and says so in a header', async () => {
    const env = makeEnv();
    const current = await runTurnToEnd(env, { version_no: 2 });
    expect(current.response.headers.get('X-Tutor-Grounding-Version')).toBe('2');
    expect(current.response.headers.get('X-Tutor-Grounding-Fallback')).toBeNull();
    const old = await runTurnToEnd(env, { client_turn_id: IDS.turn(2), version_no: 1 });
    expect(old.response.headers.get('X-Tutor-Grounding-Version')).toBe('2');
    expect(old.response.headers.get('X-Tutor-Grounding-Fallback')).toBe('1');
    expect(env.prepared.map((p) => p.versionNo)).toEqual([2, 2]);
    expect(env.prepared[0]!.subjectName).toBe('Basic Science');
    // a version that does not exist anywhere falls back too
    const future = await runTurnToEnd(env, { client_turn_id: IDS.turn(3), version_no: 9 });
    expect(future.response.headers.get('X-Tutor-Grounding-Fallback')).toBe('1');
    expect(env.backend.sessions[0]!.version_no).toBe(2);
    expect(env.logs.some((l) => JSON.stringify(l).includes('fallback'))).toBe(false);
  });

  it('stores the turn: two messages with the redacted child text, the reply, the safety decision and the model', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [delta('Hi!')],
          outcome: okOutcome('Hi!', {
            child_text_redacted: 'my number is [phone] and mail [email]',
            redaction_count: 2,
            evidence: [{ kind: 'understood', note: 'counts to 10' }],
            show_activity: { question_id: 'q_practice_1' },
          }),
        }),
    });
    await runTurnToEnd(env, { input: { mode: 'text', text: RAW } });
    const saves = env.service.calledWith('tutor_save_turn');
    expect(saves).toHaveLength(1);
    expect(saves[0]).toMatchObject({
      p_child_id: IDS.ada,
      p_client_turn_id: IDS.turn(1),
      p_input_mode: 'text',
      p_child_text: 'my number is [phone] and mail [email]',
      p_redaction_count: 2,
      p_reply_text: 'Hi!',
      p_status: 'complete',
      p_model: 'claude-sonnet-5-5-20261001',
      p_prompt_version: core.TUTOR_PROMPT_VERSION,
      p_refund_turn: false,
      p_show_activity: { question_id: 'q_practice_1' },
      p_evidence: [{ kind: 'understood', note: 'counts to 10' }],
    });
    expect(env.backend.messages.map((m) => [m.role, m.text])).toEqual([
      ['child', 'my number is [phone] and mail [email]'],
      ['tutor', 'Hi!'],
    ]);
  });

  it('NEVER lets the raw text reach an RPC argument, a log line, an event or an error', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [delta('I cannot keep numbers.')],
          outcome: okOutcome('I cannot keep numbers.', { child_text_redacted: 'RAWMARKER my number is [phone] and mail [email]' }),
        }),
    });
    // (the fake pipeline keeps the marker word RAWMARKER on purpose; the phone and the e-mail are what must not appear)
    const { sse } = await runTurnToEnd(env, { input: { mode: 'text', text: RAW } });
    const everything = JSON.stringify({
      service: env.service.calls,
      users: env.userDbs.flatMap((db) => db.calls),
      logs: env.logs,
      events: sse.events,
      raw: sse.raw,
    });
    expect(everything).not.toContain('08031234567');
    expect(everything).not.toContain('ada@example.com');
    // the raw message itself reaches the pipeline once, in memory
    expect(env.inputs[0]!.message.text).toBe(RAW);
    expect(JSON.stringify(env.service.calls)).not.toContain(RAW);

    const failing = makeEnv({ runTurn: () => fakeRun({ events: [], outcome: new Error(`boom ${RAW}`) }) });
    const failed = await runTurnToEnd(failing, { input: { mode: 'text', text: RAW } });
    const failedEverything = JSON.stringify({ service: failing.service.calls, logs: failing.logs, raw: failed.sse.raw });
    expect(failedEverything).not.toContain('08031234567');
    expect(failedEverything).not.toContain('ada@example.com');
    expect(failedEverything).not.toContain('RAWMARKER');
  });

  it('stores a placeholder, never the raw text, when the pipeline gives no outcome', async () => {
    const env = makeEnv({ runTurn: () => fakeRun({ events: [], outcome: new Error('the pipeline crashed') }) });
    const { sse } = await runTurnToEnd(env, { input: { mode: 'text', text: RAW } });
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'error']);
    expect(sse.events[1]).toEqual({ type: 'error', code: 'internal', retryable: true });
    const saved = env.service.calledWith('tutor_save_turn')[0]!;
    expect(saved['p_child_text']).toBe(NOT_SAVED_TEXT);
    expect(saved['p_status']).toBe('failed');
    expect(saved['p_reply_text']).toBeNull();
    expect(JSON.stringify(env.service.calls)).not.toContain('RAWMARKER');
  });

  it('survives a run that throws before it starts', async () => {
    const env = makeEnv({
      runTurn: () => {
        throw new Error('could not build the models sk-ant-api03-SECRETKEY');
      },
    });
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'error']);
    expect(JSON.stringify(env.logs)).not.toContain('SECRETKEY');
    expect(env.backend.messages.find((m) => m.role === 'tutor')?.status).toBe('failed');
  });
});

describe('safety on the wire and in the database', () => {
  const SAFE_REPLY = 'I am really glad you told me.';
  const SAFE_DECISION = {
    action: 'safe_reply' as const,
    reply_key: 'self_harm',
    categories: [{ category: 'self_harm', severity: 'high' }],
    open_case: true,
    case_severity: 'high' as const,
    withhold_from_guardian: true,
    from_patterns: true,
  };

  function safeRun(): Env {
    return makeEnv({
      runTurn: () =>
        fakeRun({
          events: [
            // a careless pipeline: the safety event carries the categories. They must not reach the client.
            { type: 'safety', action: 'safe_reply', categories: [{ category: 'self_harm', severity: 'high' }], summary: 'SECRETSUMMARY' },
            delta(SAFE_REPLY),
            { type: 'done', message_id: '00000000-0000-0000-0000-000000000000' },
          ],
          outcome: okOutcome(SAFE_REPLY, {
            child_text_redacted: 'I want to hurt myself',
            status: 'safe_reply',
            safety: SAFE_DECISION,
            usage: [],
          }),
        }),
    });
  }

  it('sends the safety event with the action only, and no category, summary or severity', async () => {
    const env = safeRun();
    const { sse } = await runTurnToEnd(env);
    const safety = sse.events.find((e) => e.type === 'safety');
    expect(safety).toEqual({ type: 'safety', action: 'safe_reply' });
    expect(sse.raw).not.toContain('self_harm');
    expect(sse.raw).not.toContain('SECRETSUMMARY');
    expect(sse.raw).not.toContain('categories');
    // the done event the pipeline sent (with a nil id) is replaced by ours, once, at the end
    expect(sse.events.filter((e) => e.type === 'done')).toHaveLength(1);
    expect(sse.events.at(-1)).toMatchObject({ type: 'done', message_id: env.inputs[0]!.ids!.message_id });
  });

  it('stores a safe-reply turn and opens exactly one case, with the decision for the reviewer', async () => {
    const env = safeRun();
    await runTurnToEnd(env);
    const saved = env.service.calledWith('tutor_save_turn')[0]!;
    expect(saved).toMatchObject({ p_status: 'safe_reply', p_reply_text: SAFE_REPLY, p_safety: SAFE_DECISION });
    expect(env.backend.cases).toHaveLength(1);
    expect(env.backend.cases[0]).toMatchObject({ category: 'self_harm', severity: 'high', status: 'open' });
    expect(env.backend.cases[0]!.excerpt.map((e) => e.text)).toEqual(['I want to hurt myself', SAFE_REPLY]);
    // the explicit call is made and is a no-op
    expect(env.service.calledWith('tutor_open_case')).toEqual([
      { p_message_id: env.inputs[0]!.ids!.message_id, p_category: 'self_harm', p_severity: 'high' },
    ]);
    expect(env.backend.messages.every((m) => m.flagged && m.withheld)).toBe(true);
    expect(env.backend.sessions[0]!.flagged).toBe(true);
  });

  it('opens no case for an ordinary turn, and one for a blocked turn with its severity', async () => {
    const plain = makeEnv();
    await runTurnToEnd(plain);
    expect(plain.backend.cases).toHaveLength(0);
    expect(plain.service.calledWith('tutor_open_case')).toHaveLength(0);

    const blocked = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [{ type: 'safety', action: 'blocked' }, delta('That is not something I can talk about.')],
          outcome: okOutcome('That is not something I can talk about.', {
            status: 'blocked',
            safety: { ...ALLOW, action: 'blocked', reply_key: 'blocked', categories: [{ category: 'violence', severity: 'high' }], open_case: true, case_severity: 'low' },
          }),
        }),
    });
    await runTurnToEnd(blocked);
    expect(blocked.backend.cases[0]).toMatchObject({ category: 'violence', severity: 'low' });
  });

  it('drops events that do not fit the contract and keeps going', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [{ type: 'mystery', secret: 'x' }, delta('fine'), { type: 'tool', name: 'delete_everything', input: {} }],
          outcome: okOutcome('fine'),
        }),
    });
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
    expect(env.logs.filter((l) => l.event === 'event_dropped')).toHaveLength(2);
  });

  it('forwards a tool event for show_activity and a replace event', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [
            delta('Try this one.'),
            { type: 'tool', name: 'show_activity', input: { question_id: 'q_1', extra: 'dropped' } },
            { type: 'replace', text: 'I am here to help you with your lesson.', reason: 'safety' },
          ],
          outcome: okOutcome('I am here to help you with your lesson.', { status: 'replaced', show_activity: { question_id: 'q_1' } }),
        }),
    });
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'tool', 'replace', 'done']);
    expect(sse.events[2]).toEqual({ type: 'tool', name: 'show_activity', input: { question_id: 'q_1' } });
    expect(env.backend.messages.find((m) => m.role === 'tutor')).toMatchObject({ status: 'replaced', text: 'I am here to help you with your lesson.' });
  });
});

describe('usage, failures and the budget', () => {
  it('logs every model call of a turn (tokens only), once, with the session', async () => {
    const env = makeEnv({ settings: { prices: { 'claude-sonnet-5-5': { input_per_mtok: 3, output_per_mtok: 15, cache_read_per_mtok: 0.3, cache_write_per_mtok: 3.75 } } } });
    await runTurnToEnd(env);
    const logged = env.service.calledWith('tutor_log_usage');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toEqual({ p_session_id: env.backend.sessions[0]!.id, p_usage: [USAGE_MODERATION, USAGE_TUTOR] });
    expect(env.backend.usage.map((u) => [u.task, u.model, u.est_cost_usd === null])).toEqual([
      ['moderation', 'claude-haiku-5-5', true],
      ['tutor', 'claude-sonnet-5-5-20261001', false],
    ]);
    for (const record of logged[0]!['p_usage'] as Array<Record<string, unknown>>) {
      expect(Object.keys(record).sort()).toEqual(['cache_creation_tokens', 'cache_read_tokens', 'duration_ms', 'input_tokens', 'label', 'model', 'output_tokens', 'stop_reason', 'task']);
    }
  });

  it('stores a failed turn, logs the billed calls of a failed turn and ends the stream with an error event', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [delta('Hel'), { type: 'error', code: 'upstream', retryable: true }],
          outcome: okOutcome('', { status: 'failed', reply_text: null, error_code: 'upstream', usage: [USAGE_MODERATION, { ...USAGE_TUTOR, stop_reason: 'refusal', output_tokens: 3 }] }),
        }),
    });
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'error']);
    expect(sse.events.at(-1)).toEqual({ type: 'error', code: 'upstream', retryable: true });
    expect(env.backend.usage).toHaveLength(2);
    const saved = env.service.calledWith('tutor_save_turn')[0]!;
    expect(saved).toMatchObject({ p_status: 'failed', p_reply_text: null, p_refund_turn: false });
    expect(env.backend.messages.find((m) => m.role === 'tutor')).toMatchObject({ status: 'failed', text: null });
  });

  it('gives the count back for a turn that failed before any call was billed', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [{ type: 'error', code: 'upstream', retryable: true }],
          outcome: okOutcome('', { status: 'failed', reply_text: null, error_code: 'upstream', usage: [] }),
        }),
    });
    await runTurnToEnd(env);
    expect(env.service.calledWith('tutor_save_turn')[0]!['p_refund_turn']).toBe(true);
    expect(env.service.calledWith('tutor_log_usage')).toHaveLength(0);
    expect([...env.backend.days.values()].map((d) => d.turns)).toEqual([0]);
  });

  it('adds an error event when the pipeline failed without sending one', async () => {
    const env = makeEnv({
      runTurn: () => fakeRun({ events: [delta('part')], outcome: okOutcome('', { status: 'failed', reply_text: null, error_code: 'upstream', usage: [USAGE_MODERATION] }) }),
    });
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.at(-1)).toEqual({ type: 'error', code: 'upstream', retryable: true });
    expect(sse.events.map((e) => e.type)).not.toContain('done');
  });

  it('treats an event stream that breaks as a failure and still stores the outcome', async () => {
    const env = makeEnv({
      runTurn: () => fakeRun({ events: [delta('He')], throwAfterEvents: true, outcome: okOutcome('Hello') }),
    });
    const { sse } = await runTurnToEnd(env);
    expect(env.logs.map((l) => l.event)).toContain('events_failed');
    expect(sse.events.at(-1)?.type).toBe('done');
    expect(env.backend.messages).toHaveLength(2);
  });

  it('retries a failed save once, then reports an internal error, and still logs the usage', async () => {
    const flaky = makeEnv();
    flaky.backend.failures.set('tutor_save_turn', [{ code: '08006', message: 'connection lost' }]);
    const ok = await runTurnToEnd(flaky);
    expect(ok.sse.events.at(-1)?.type).toBe('done');
    expect(flaky.service.calledWith('tutor_save_turn')).toHaveLength(2);

    const broken = makeEnv();
    broken.backend.failures.set('tutor_save_turn', [{ code: '08006', message: 'connection lost' }, { code: '08006', message: 'connection lost' }]);
    const { sse } = await runTurnToEnd(broken);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'delta', 'error']);
    expect(sse.events.at(-1)).toEqual({ type: 'error', code: 'internal', retryable: true });
    expect(broken.backend.usage).toHaveLength(2);
    expect(broken.backend.messages).toHaveLength(0);
  });

  it('survives a failing usage log and a failing case call', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [delta('x')],
          outcome: okOutcome('x', { status: 'safe_reply', safety: { ...ALLOW, action: 'safe_reply', reply_key: 'distress', categories: [{ category: 'distress', severity: 'high' }], open_case: true, withhold_from_guardian: true } }),
        }),
    });
    env.backend.failures.set('tutor_log_usage', [{ code: 'XX000', message: 'disk full' }]);
    env.backend.failures.set('tutor_open_case', [{ code: 'XX000', message: 'disk full' }]);
    const { sse } = await runTurnToEnd(env);
    expect(sse.events.at(-1)?.type).toBe('done');
    // the case exists anyway: the save opened it in the same transaction
    expect(env.backend.cases).toHaveLength(1);
    expect(env.logs.map((l) => l.event)).toEqual(expect.arrayContaining(['log_usage_failed', 'open_case_failed']));
  });

  it('keeps a turn whose client went away: it is stored and fetch_turn finds it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = makeEnv({ runTurn: () => fakeRun({ events: [delta('Hello')], outcome: okOutcome('Hello there'), gate }) });
    const response = await env.send(env.turnBody());
    const reader = response.body!.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"meta"');
    await reader.cancel();
    release();
    await env.flush();
    expect(env.backend.messages.map((m) => m.text)).toEqual(['hello tutor', 'Hello there']);
    expect(env.backend.usage).toHaveLength(2);
    const fetched = await env.send({ action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(1) });
    expect(((await fetched.json()) as { result: { reply: string } }).result.reply).toBe('Hello there');
  });

  it('keeps the connection alive with comments while the model is slow', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const env = makeEnv({ keepAliveMs: 5, runTurn: () => fakeRun({ events: [delta('Hi')], outcome: okOutcome('Hi'), gate }) });
    const response = await env.send(env.turnBody());
    setTimeout(release, 60);
    const sse = await readSse(response);
    await env.flush();
    expect(sse.keepAlives).toBeGreaterThan(2);
    expect(sse.events.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
  });

  it('aborts the pipeline when the turn runs out of time', async () => {
    const env = makeEnv({
      turnTimeoutMs: 20,
      runTurn: (_input, context) => {
        const outcome = new Promise<TutorTurnOutcome>((resolve) => {
          context.signal.addEventListener('abort', () => resolve(okOutcome('', { status: 'failed', reply_text: null, error_code: 'upstream', usage: [] })));
        });
        return { events: (async function* () {})(), outcome };
      },
    });
    const { sse } = await runTurnToEnd(env);
    expect(env.contexts[0]!.signal.aborted).toBe(true);
    expect(sse.events.at(-1)).toEqual({ type: 'error', code: 'upstream', retryable: true });
  });
});

describe('idempotency: a stored turn is replayed for free', () => {
  it('replays the stored reply as a stream, with no model call, no new count and no new rows', async () => {
    const env = makeEnv();
    const first = await runTurnToEnd(env);
    const calls = env.service.calls.length;
    const counted = [...env.backend.days.values()].map((d) => d.turns);

    const again = await env.send(env.turnBody());
    expect(again.status).toBe(200);
    const replay = await readSse(again);
    await env.flush();
    expect(env.inputs).toHaveLength(1);
    expect(env.backend.messages).toHaveLength(2);
    expect([...env.backend.days.values()].map((d) => d.turns)).toEqual(counted);
    const names = env.service.calls.slice(calls).map((c) => c.name);
    expect(names).toEqual(['tutor_get_settings', 'tutor_get_ai_settings', 'tutor_get_turn']);
    expect(replay.events.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
    expect((replay.events[0] as { message_id: string }).message_id).toBe((first.sse.events[0] as { message_id: string }).message_id);
    expect(replay.events[1]).toEqual({ type: 'delta', text: 'Hello Ada! What shall we count?' });
  });

  it('a retry at the daily limit still gets the stored turn, a new turn does not', async () => {
    const env = makeEnv({ tutorSettings: { daily_turns_per_child: 1 } });
    await runTurnToEnd(env);
    const retry = await env.send(env.turnBody());
    expect(retry.status).toBe(200);
    await readSse(retry);
    expect((await env.send(env.turnBody({ client_turn_id: IDS.turn(2) }))).status).toBe(429);
  });

  it('replays a safe reply with its safety event, and a failed turn as an error event', async () => {
    const env = makeEnv({
      runTurn: () =>
        fakeRun({
          events: [{ type: 'safety', action: 'safe_reply' }, delta('I am glad you told me.')],
          outcome: okOutcome('I am glad you told me.', { status: 'safe_reply', safety: { ...ALLOW, action: 'safe_reply', reply_key: 'distress', categories: [{ category: 'distress', severity: 'high' }], open_case: true, withhold_from_guardian: true } }),
        }),
    });
    await runTurnToEnd(env);
    const replay = await readSse(await env.send(env.turnBody()));
    expect(replay.events.map((e) => e.type)).toEqual(['meta', 'safety', 'delta', 'done']);
    expect(replay.events[1]).toEqual({ type: 'safety', action: 'safe_reply' });
    expect(replay.raw).not.toContain('distress');

    const failing = makeEnv({ runTurn: () => fakeRun({ events: [], outcome: new Error('x') }) });
    await runTurnToEnd(failing);
    const failedReplay = await readSse(await failing.send(failing.turnBody()));
    expect(failedReplay.events.map((e) => e.type)).toEqual(['meta', 'error']);
    expect(failing.inputs).toHaveLength(1);
  });

  it('answers a turn whose first submit finished between the lookup and the session claim', async () => {
    const env = makeEnv();
    await runTurnToEnd(env);
    // the lookup finds nothing (as if it ran just before the save), the claim then sees the stored turn
    env.backend.failures.set('tutor_get_turn', []);
    const original = env.backend.serviceRpcs()['tutor_get_turn']!;
    let first = true;
    env.service.rpcs['tutor_get_turn'] = (args) => {
      if (first) {
        first = false;
        return { data: null, error: null };
      }
      return original(args);
    };
    const replay = await readSse(await env.send(env.turnBody()));
    expect(replay.events.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
    expect(env.inputs).toHaveLength(1);
  });
});

describe('fetch_turn', () => {
  it('returns the stored result, or { result: null } when there is none', async () => {
    const env = makeEnv();
    await runTurnToEnd(env);
    const found = await env.send({ action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(1) });
    expect(found.status).toBe(200);
    expect(await found.json()).toEqual({
      result: {
        session_id: env.backend.sessions[0]!.id,
        message_id: env.inputs[0]!.ids!.message_id,
        status: 'complete',
        reply: 'Hello Ada! What shall we count?',
        safety_action: 'allow',
        show_activity: null,
      },
    });
    const parsed = contract.TutorTurnResult.safeParse(((await (await env.send({ action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(1) })).json()) as { result: unknown }).result);
    expect(parsed.success).toBe(true);
    const missing = await env.send({ action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(77) });
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ result: null });
  });

  it('is guarded like a turn: JWT, body, the child (guardian only) with the same answer for a stranger\'s child', async () => {
    const env = makeEnv();
    await runTurnToEnd(env);
    const body = { action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(1) };
    expect((await env.send(body, { token: null })).status).toBe(401);
    expect(await errorOf(await env.send(body, { sub: GB }))).toMatchObject({ status: 403, code: 'forbidden' });
    expect(await errorOf(await env.send(body, { sub: TU }))).toMatchObject({ status: 403, code: 'forbidden' });
    const stranger = await errorOf(await env.send({ ...body, child_id: IDS.chidi }));
    const missing = await errorOf(await env.send({ ...body, child_id: 'e9d00000-0000-4000-8000-0000000000aa' }));
    expect(stranger).toEqual(missing);
    // a turn id of Ada's looked up under Bola finds nothing
    expect(await (await env.send({ ...body, child_id: IDS.bola })).json()).toEqual({ result: null });
    expect((await env.send({ action: 'fetch_turn', child_id: IDS.ada })).status).toBe(400);
  });

  it('still answers while the tutor is switched off (it only returns what was stored), but never to a stranger', async () => {
    const env = makeEnv({ tutorSettings: { enabled: false } });
    env.backend.messages.length = 0;
    const result = await env.send({ action: 'fetch_turn', child_id: IDS.ada, client_turn_id: IDS.turn(1) });
    expect(await result.json()).toEqual({ result: null });
    expect(env.serviceCalls()).toEqual(['tutor_get_turn']);
  });
});

describe('nothing secret or private leaves the function', () => {
  it('returns only the contract error body, with fixed sentences, for every failure', async () => {
    const secrets = 'sk-ant-api03-TOPSECRET stack trace at Object.<anonymous> /srv/app.js:10';
    const env = makeEnv();
    env.backend.failures.set('tutor_get_settings', [{ code: 'XX000', message: `relation "app_settings" ${secrets}` }]);
    const response = await env.send(env.turnBody());
    const error = await errorOf(response);
    expect(error).toEqual({ status: 500, code: 'internal', retryable: true, message: MESSAGE_OF_CODE.internal });
    expect(JSON.stringify(error)).not.toContain('TOPSECRET');
    expect(JSON.stringify(env.logs)).not.toContain('TOPSECRET');
    for (const code of TUTOR_ERROR_CODES) {
      expect(MESSAGE_OF_CODE[code]).not.toMatch(/sk-ant|stack|prompt|classif|categor/i);
    }
  });

  it('logs only ids, codes and counts, never text (every log call of a busy run is checked)', async () => {
    const env = makeEnv({
      runTurn: () => fakeRun({ events: [delta('Hello')], outcome: new Error(`boom ${RAW} sk-ant-api03-TOPSECRET`) }),
    });
    env.backend.failures.set('tutor_log_usage', [{ code: 'XX000', message: `bad value ${RAW}` }]);
    await runTurnToEnd(env, { input: { mode: 'text', text: RAW } });
    await env.send(env.turnBody({ input: { mode: 'text', text: `${RAW} ${'x'.repeat(600)}` } }));
    const logged = JSON.stringify(env.logs);
    for (const forbidden of ['RAWMARKER', '08031234567', 'ada@example.com', 'TOPSECRET', 'hello tutor']) {
      expect(logged).not.toContain(forbidden);
    }
    for (const entry of env.logs) {
      for (const value of Object.values(entry.detail)) {
        expect(typeof value === 'string' ? value.length : 0).toBeLessThanOrEqual(200);
      }
    }
  });

  it('does not touch the real console while it runs', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    try {
      const env = makeEnv({ runTurn: () => fakeRun({ events: [], outcome: new Error('x') }) });
      await runTurnToEnd(env, { input: { mode: 'text', text: RAW } });
      await env.send(env.turnBody({ unit_id: IDS.unpublished, client_turn_id: IDS.turn(5) }));
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});

describe('helpers', () => {
  it('decodes the claims of a JWT payload and nothing else', () => {
    const token = makeJwt({ sub: GA, role: 'authenticated', aal: 'aal1', exp: 123, extra: 'x' });
    expect(decodeJwtClaims(token)).toEqual({ sub: GA, role: 'authenticated', aal: 'aal1', exp: 123 });
    expect(decodeJwtClaims('x.y.z')).toBeNull();
    expect(decodeJwtClaims(`a.${base64url('[1]')}.c`)).toBeNull();
    expect(decodeJwtClaims('')).toBeNull();
  });

  it('matches origins exactly, localhost with any port, and nothing like a lookalike', () => {
    expect(isAllowedOrigin('https://app.example.com', ['https://app.example.com'])).toBe(true);
    expect(isAllowedOrigin('https://app.example.com.evil.com', ['https://app.example.com'])).toBe(false);
    expect(isAllowedOrigin('http://localhost:19006', [])).toBe(true);
    expect(isAllowedOrigin('http://localhost.evil.com', [])).toBe(false);
    expect(isAllowedOrigin('http://localhost:8081', [], false)).toBe(false);
    expect(corsHeadersFor(null, { allowedOrigins: [] })).toEqual({});
    expect(corsHeadersFor('null', { allowedOrigins: [] })).toBeNull();
  });
});
