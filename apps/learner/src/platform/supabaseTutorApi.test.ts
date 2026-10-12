import { describe, expect, it } from 'vitest';
import {
  CURRENT_TUTOR_CONSENT_VERSION,
  TutorApiError,
  type TutorStreamEvent,
  type TutorTurnResult,
} from '@custar/tutor-core/client';
import {
  createSupabaseTutorApi,
  mapRpcError,
  type TutorFetch,
  type TutorSupabase,
} from './supabaseTutorApi';

const CHILD = '00000000-0000-4000-8000-00000000c1a0';
const UNIT = '00000000-0000-4000-8000-0000000000a1';
const SESSION = '00000000-0000-4000-8000-0000000005e1';
const MESSAGE = '00000000-0000-4000-8000-0000000000e1';
const TURN = '00000000-0000-4000-8000-00000000d001';
const URL = 'https://abc.supabase.co';
const KEY = 'sb_publishable_test';

const request = {
  action: 'turn' as const,
  child_id: CHILD,
  client_turn_id: TURN,
  unit_id: UNIT,
  version_no: 1,
  input: { mode: 'text' as const, text: 'Where does a fish live?' },
  helper_present: false,
};

// ---- fakes ---------------------------------------------------------------------------------------

interface RpcCall {
  name: string;
  args: Record<string, unknown>;
}

function fakeSupabase(
  options: {
    token?: string | null;
    rpc?: (call: RpcCall) => {
      data?: unknown;
      error?: { message?: string; code?: string } | null;
      status?: number;
    };
  } = {},
) {
  const calls: RpcCall[] = [];
  const client: TutorSupabase = {
    auth: {
      getSession: () =>
        Promise.resolve({
          data: {
            session: options.token === null ? null : { access_token: options.token ?? 'jwt-token' },
          },
        }),
    },
    rpc: (name, args) => {
      calls.push({ name, args });
      const reply = options.rpc?.({ name, args }) ?? { data: null };
      return Promise.resolve({
        data: reply.data ?? null,
        error: reply.error ?? null,
        status: reply.status ?? 200,
      });
    },
  };
  return { client, calls };
}

const encoder = new TextEncoder();

/** A body made of the given raw chunks (strings are UTF-8 encoded; Uint8Arrays are sent as they are). */
function streamOf(
  chunks: (string | Uint8Array)[],
  after?: { error?: Error; hang?: boolean },
): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (index < chunks.length) {
        const chunk = chunks[index++]!;
        controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
        return undefined;
      }
      if (after?.error) {
        controller.error(after.error);
        return undefined;
      }
      if (after?.hang) return new Promise<void>(() => undefined);
      controller.close();
      return undefined;
    },
  });
}

const frame = (event: unknown) => `data: ${JSON.stringify(event)}\n\n`;

const meta = { type: 'meta', session_id: SESSION, message_id: MESSAGE } as const;
const done = { type: 'done', message_id: MESSAGE } as const;

interface FetchCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  signal: AbortSignal | undefined;
}

function fakeFetch(handler: (call: FetchCall, n: number) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch: TutorFetch = async (url, init) => {
    const call: FetchCall = {
      url,
      headers: init.headers,
      body: JSON.parse(init.body) as Record<string, unknown>,
      signal: init.signal,
    };
    calls.push(call);
    return handler(call, calls.length);
  };
  return { fetch, calls };
}

const sseResponse = (body: ReadableStream<Uint8Array>, status = 200) =>
  new Response(body, { status, headers: { 'content-type': 'text/event-stream' } });

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function api(fetchImpl: TutorFetch, supabase: TutorSupabase = fakeSupabase().client) {
  return createSupabaseTutorApi({
    supabase,
    url: `${URL}/`,
    publishableKey: KEY,
    fetch: fetchImpl,
  });
}

const storedResult: TutorTurnResult = {
  session_id: SESSION,
  message_id: MESSAGE,
  status: 'complete',
  reply: 'A fish lives in water.',
  safety_action: 'allow',
  show_activity: null,
};

async function rejection(promise: Promise<unknown>): Promise<TutorApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TutorApiError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

// ---- RPCs ----------------------------------------------------------------------------------------

describe('consent, sessions and transcripts (RPCs)', () => {
  it('reads consent with get_tutor_consent(p_child_id)', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: { granted: true, version: 'tutor-v1-draft', required_version: 'tutor-v1-draft' },
      }),
    });
    const consent = await api(fakeFetch(() => new Response()).fetch, supabase.client).consent(
      CHILD,
    );
    expect(consent).toEqual({
      granted: true,
      version: 'tutor-v1-draft',
      required_version: 'tutor-v1-draft',
    });
    expect(supabase.calls).toEqual([{ name: 'get_tutor_consent', args: { p_child_id: CHILD } }]);
  });

  it('accepts a single-row array and a null version', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({ data: [{ granted: false, version: null, required_version: 'v2' }] }),
    });
    expect(
      await api(fakeFetch(() => new Response()).fetch, supabase.client).consent(CHILD),
    ).toEqual({
      granted: false,
      version: null,
      required_version: 'v2',
    });
  });

  it('rejects a reply of the wrong shape instead of guessing', async () => {
    const supabase = fakeSupabase({ rpc: () => ({ data: { granted: 'yes' } }) });
    const error = await rejection(
      api(fakeFetch(() => new Response()).fetch, supabase.client).consent(CHILD),
    );
    expect(error.code).toBe('internal');
  });

  it('records consent with set_tutor_consent(p_child_id, p_action, p_version) for grant and withdraw', async () => {
    const supabase = fakeSupabase();
    const tutor = api(fakeFetch(() => new Response()).fetch, supabase.client);
    await tutor.setConsent(CHILD, 'grant');
    await tutor.setConsent(CHILD, 'withdraw');
    expect(supabase.calls).toEqual([
      {
        name: 'set_tutor_consent',
        args: { p_child_id: CHILD, p_action: 'grant', p_version: CURRENT_TUTOR_CONSENT_VERSION },
      },
      {
        name: 'set_tutor_consent',
        args: { p_child_id: CHILD, p_action: 'withdraw', p_version: CURRENT_TUTOR_CONSENT_VERSION },
      },
    ]);
  });

  it('lists sessions with list_tutor_sessions(p_child_id, p_limit)', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: [
          {
            id: 's1',
            unit_id: UNIT,
            started_at: '2026-10-12T08:00:00Z',
            turns: 3,
            has_withheld: true,
          },
        ],
      }),
    });
    const tutor = api(fakeFetch(() => new Response()).fetch, supabase.client);
    expect(await tutor.listSessions(CHILD)).toEqual([
      { id: 's1', unit_id: UNIT, started_at: '2026-10-12T08:00:00Z', turns: 3, has_withheld: true },
    ]);
    await tutor.listSessions(CHILD, 5);
    expect(supabase.calls.map((c) => c.args)).toEqual([
      { p_child_id: CHILD, p_limit: 20 },
      { p_child_id: CHILD, p_limit: 5 },
    ]);
    expect(supabase.calls[0]?.name).toBe('list_tutor_sessions');
  });

  it('reads a transcript with get_tutor_transcript(p_session_id) and keeps the withheld flag', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({
        data: [
          {
            id: 'm1',
            role: 'child',
            text: 'Hello',
            created_at: '2026-10-12T08:00:00Z',
            withheld: false,
          },
          {
            id: 'm2',
            role: 'tutor',
            text: 'placeholder',
            created_at: '2026-10-12T08:00:01Z',
            withheld: true,
          },
        ],
      }),
    });
    const messages = await api(
      fakeFetch(() => new Response()).fetch,
      supabase.client,
    ).getTranscript('s1');
    expect(supabase.calls).toEqual([
      { name: 'get_tutor_transcript', args: { p_session_id: 's1' } },
    ]);
    expect(messages.map((m) => [m.id, m.withheld])).toEqual([
      ['m1', false],
      ['m2', true],
    ]);
  });

  it('maps RPC errors: elevation_required, forbidden, unauthenticated, offline', async () => {
    expect(mapRpcError({ message: 'elevation_required', code: 'P0001' }, 400).code).toBe(
      'elevation_required',
    );
    expect(mapRpcError({ message: 'permission denied', code: '42501' }, 403).code).toBe(
      'forbidden',
    );
    expect(mapRpcError({ message: 'forbidden' }, 400).code).toBe('forbidden');
    expect(mapRpcError({ message: 'JWT expired', code: 'PGRST301' }, 401).code).toBe(
      'unauthenticated',
    );
    expect(mapRpcError({ message: 'not_authenticated' }, 400).code).toBe('unauthenticated');
    const offline = mapRpcError({ message: 'TypeError: Failed to fetch' });
    expect(offline.code).toBe('offline');
    expect(offline.retryable).toBe(true);
    expect(mapRpcError({ message: 'x' }, 0).code).toBe('offline');
    expect(mapRpcError({ message: 'boom' }, 500)).toMatchObject({
      code: 'internal',
      retryable: true,
    });
    expect(mapRpcError({ message: 'bad request' }, 400)).toMatchObject({
      code: 'internal',
      retryable: false,
    });
  });

  it('surfaces an RPC error through the API as a TutorApiError', async () => {
    const supabase = fakeSupabase({
      rpc: () => ({ error: { message: 'elevation_required', code: 'P0001' }, status: 400 }),
    });
    const tutor = api(fakeFetch(() => new Response()).fetch, supabase.client);
    expect((await rejection(tutor.getTranscript('s1'))).code).toBe('elevation_required');
    expect((await rejection(tutor.listSessions(CHILD))).code).toBe('elevation_required');
  });

  it('a throwing client is offline', async () => {
    const client: TutorSupabase = {
      auth: { getSession: () => Promise.resolve({ data: { session: { access_token: 't' } } }) },
      rpc: () => {
        throw new TypeError('network down');
      },
    };
    const error = await rejection(
      api(fakeFetch(() => new Response()).fetch, client).consent(CHILD),
    );
    expect(error).toMatchObject({ code: 'offline', retryable: true });
  });
});

// ---- the stream ----------------------------------------------------------------------------------

describe('sendTurn: request', () => {
  it('POSTs to /functions/v1/tutor-chat with the access token, the apikey and the request body', async () => {
    const f = fakeFetch(() => sseResponse(streamOf([frame(meta), frame(done)])));
    await api(f.fetch).sendTurn(request, () => undefined);
    expect(f.calls).toHaveLength(1);
    const call = f.calls[0]!;
    expect(call.url).toBe(`${URL}/functions/v1/tutor-chat`);
    expect(call.headers).toMatchObject({
      Authorization: 'Bearer jwt-token',
      apikey: KEY,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    });
    expect(call.body).toMatchObject({
      action: 'turn',
      child_id: CHILD,
      client_turn_id: TURN,
      unit_id: UNIT,
      version_no: 1,
      input: { mode: 'text', text: 'Where does a fish live?' },
    });
  });

  it('never sends the service role or any other key', async () => {
    const f = fakeFetch(() => sseResponse(streamOf([frame(meta), frame(done)])));
    await api(f.fetch).sendTurn(request, () => undefined);
    expect(JSON.stringify(f.calls[0]?.headers)).not.toMatch(/service|anthropic|sk-/i);
  });

  it('is unauthenticated without a session, and says so before any network call', async () => {
    const f = fakeFetch(() => new Response());
    const supabase = fakeSupabase({ token: null });
    const error = await rejection(api(f.fetch, supabase.client).sendTurn(request, () => undefined));
    expect(error.code).toBe('unauthenticated');
    expect(f.calls).toHaveLength(0);
  });

  it('is offline (retryable) when fetch itself fails', async () => {
    const fetch: TutorFetch = () => Promise.reject(new TypeError('Network request failed'));
    const error = await rejection(api(fetch).sendTurn(request, () => undefined));
    expect(error).toMatchObject({ code: 'offline', retryable: true });
  });
});

describe('sendTurn: events', () => {
  const events: TutorStreamEvent[] = [
    meta,
    { type: 'safety', action: 'allow' },
    { type: 'delta', text: 'A fish ' },
    { type: 'delta', text: 'lives in water.' },
    done,
  ];

  it('delivers every event in order and resolves with the reply built from them', async () => {
    const f = fakeFetch(() => sseResponse(streamOf(events.map(frame))));
    const seen: TutorStreamEvent[] = [];
    const result = await api(f.fetch).sendTurn(request, (event) => seen.push(event));
    expect(seen).toEqual(events);
    expect(result).toEqual({
      session_id: SESSION,
      message_id: MESSAGE,
      status: 'complete',
      reply: 'A fish lives in water.',
      safety_action: 'allow',
      show_activity: null,
    });
    expect(f.calls).toHaveLength(1); // no fetch_turn needed
  });

  it('copes with chunks split at awkward places: mid-line, mid-JSON, mid-UTF-8, CRLF', async () => {
    const full = events
      .map((event) =>
        event.type === 'delta' && event.text.startsWith('lives')
          ? { ...event, text: 'lives in water, ọ̀rọ̀ 🐟.' }
          : event,
      )
      .map(frame)
      .join('')
      .replace(/\n/g, '\r\n');
    const bytes = encoder.encode(full);
    // one byte at a time is the worst case: it also splits the multi-byte characters
    const chunks = Array.from(bytes, (byte) => Uint8Array.of(byte));
    const f = fakeFetch(() => sseResponse(streamOf(chunks)));
    const seen: TutorStreamEvent[] = [];
    const result = await api(f.fetch).sendTurn(request, (event) => seen.push(event));
    expect(seen).toHaveLength(events.length);
    expect(result.reply).toBe('A fish lives in water, ọ̀rọ̀ 🐟.');
  });

  it('splits at a few fixed offsets as well', async () => {
    const bytes = encoder.encode(events.map(frame).join(''));
    for (const cut of [1, 3, 5, 20, 47, 100, bytes.length - 2]) {
      const f = fakeFetch(() => sseResponse(streamOf([bytes.slice(0, cut), bytes.slice(cut)])));
      const seen: TutorStreamEvent[] = [];
      const result = await api(f.fetch).sendTurn(request, (event) => seen.push(event));
      expect(seen, `cut ${cut}`).toEqual(events);
      expect(result.reply).toBe('A fish lives in water.');
    }
  });

  it('ignores comment lines, blank keep-alives and event types it does not know', async () => {
    const body = [
      ': keep-alive\n\n',
      frame(meta),
      frame({ type: 'telepathy', mood: 'happy' }),
      '\n',
      frame({ type: 'delta', text: 'Hi' }),
      frame(done),
    ];
    const f = fakeFetch(() => sseResponse(streamOf(body)));
    const seen: TutorStreamEvent[] = [];
    const result = await api(f.fetch).sendTurn(request, (event) => seen.push(event));
    expect(seen.map((e) => e.type)).toEqual(['meta', 'delta', 'done']);
    expect(result.reply).toBe('Hi');
  });

  it('handles replace and a safety reply', async () => {
    const body = [
      meta,
      { type: 'safety', action: 'safe_reply' },
      { type: 'delta', text: 'Something' },
      { type: 'replace', text: 'Please tell a grown-up you trust.', reason: 'safety' },
      done,
    ].map(frame);
    const f = fakeFetch(() => sseResponse(streamOf(body)));
    const result = await api(f.fetch).sendTurn(request, () => undefined);
    expect(result).toMatchObject({
      status: 'safe_reply',
      safety_action: 'safe_reply',
      reply: 'Please tell a grown-up you trust.',
    });
  });

  it('carries a show_activity suggestion into the result', async () => {
    const body = [
      meta,
      { type: 'delta', text: 'Try this.' },
      { type: 'tool', name: 'show_activity', input: { question_id: 'wb_fill_cook' } },
      done,
    ].map(frame);
    const f = fakeFetch(() => sseResponse(streamOf(body)));
    const result = await api(f.fetch).sendTurn(request, () => undefined);
    expect(result.show_activity).toEqual({ question_id: 'wb_fill_cook' });
  });

  it('keeps going when the listener throws', async () => {
    const f = fakeFetch(() => sseResponse(streamOf(events.map(frame))));
    const result = await api(f.fetch).sendTurn(request, () => {
      throw new Error('listener bug');
    });
    expect(result.reply).toBe('A fish lives in water.');
  });

  it('works when the body is not streamable (reads the text)', async () => {
    const fetch: TutorFetch = () =>
      Promise.resolve({
        ok: true,
        status: 200,
        body: null,
        headers: { get: () => 'text/event-stream' },
        json: () => Promise.reject(new Error('no')),
        text: () => Promise.resolve(events.map(frame).join('')),
      });
    const result = await api(fetch).sendTurn(request, () => undefined);
    expect(result.reply).toBe('A fish lives in water.');
  });

  it('accepts a stored result as JSON for a turn that already finished', async () => {
    const f = fakeFetch(() => jsonResponse(storedResult));
    const seen: TutorStreamEvent[] = [];
    const result = await api(f.fetch).sendTurn(request, (event) => seen.push(event));
    expect(result).toEqual(storedResult);
    expect(seen).toEqual([{ type: 'delta', text: 'A fish lives in water.' }]);
  });
});

describe('sendTurn: errors before the stream', () => {
  const cases: [number, string, boolean][] = [
    [403, 'consent_required', false],
    [403, 'tutor_disabled', false],
    [503, 'kill_switch', false],
    [429, 'daily_limit', false],
    [409, 'busy', true],
    [404, 'unit_not_found', false],
    [502, 'upstream', true],
  ];
  for (const [status, code, retryable] of cases) {
    it(`maps the typed body ${code} (HTTP ${status})`, async () => {
      const f = fakeFetch(() => jsonResponse({ error: { code, message: 'x', retryable } }, status));
      const seen: TutorStreamEvent[] = [];
      const error = await rejection(api(f.fetch).sendTurn(request, (event) => seen.push(event)));
      expect(error).toMatchObject({ code, retryable });
      expect(seen).toEqual([]);
    });
  }

  it('falls back to the status when the body is not the typed error', async () => {
    const plain = (status: number) =>
      new Response('<html>nope</html>', { status, headers: { 'content-type': 'text/html' } });
    expect(
      (await rejection(api(fakeFetch(() => plain(401)).fetch).sendTurn(request, () => undefined)))
        .code,
    ).toBe('unauthenticated');
    expect(
      (await rejection(api(fakeFetch(() => plain(403)).fetch).sendTurn(request, () => undefined)))
        .code,
    ).toBe('forbidden');
    expect(
      await rejection(api(fakeFetch(() => plain(500)).fetch).sendTurn(request, () => undefined)),
    ).toMatchObject({
      code: 'upstream',
      retryable: true,
    });
  });
});

describe('sendTurn: errors inside the stream', () => {
  it('passes an error event to the listener, then rejects with its code', async () => {
    const body = [
      meta,
      { type: 'delta', text: 'A fi' },
      { type: 'error', code: 'upstream', retryable: true },
      done,
    ].map(frame);
    const f = fakeFetch(() => sseResponse(streamOf(body)));
    const seen: TutorStreamEvent[] = [];
    const error = await rejection(api(f.fetch).sendTurn(request, (event) => seen.push(event)));
    expect(error).toMatchObject({ code: 'upstream', retryable: true });
    expect(seen.map((e) => e.type)).toEqual(['meta', 'delta', 'error']); // nothing after the error
  });

  it('recovers a dropped stream from the stored turn (fetch_turn) instead of failing', async () => {
    const f = fakeFetch((call) =>
      call.body.action === 'fetch_turn'
        ? jsonResponse(storedResult)
        : sseResponse(
            streamOf([frame(meta), frame({ type: 'delta', text: 'A fi' })], {
              error: new TypeError('connection reset'),
            }),
          ),
    );
    const result = await api(f.fetch).sendTurn(request, () => undefined);
    expect(result).toEqual(storedResult);
    expect(f.calls.map((c) => c.body.action)).toEqual(['turn', 'fetch_turn']);
    expect(f.calls[1]?.body).toEqual({
      action: 'fetch_turn',
      child_id: CHILD,
      client_turn_id: TURN,
    });
  });

  it('fails calmly and retryably when the stream dropped and the server has nothing stored', async () => {
    const f = fakeFetch((call) =>
      call.body.action === 'fetch_turn'
        ? jsonResponse({ turn: null })
        : sseResponse(streamOf([frame(meta)], { error: new TypeError('connection reset') })),
    );
    const error = await rejection(api(f.fetch).sendTurn(request, () => undefined));
    expect(error).toMatchObject({ code: 'upstream', retryable: true });
  });

  it('uses the stored result when the stream ends cleanly but without a done event', async () => {
    const f = fakeFetch((call) =>
      call.body.action === 'fetch_turn'
        ? jsonResponse(storedResult)
        : sseResponse(streamOf([frame(meta), frame({ type: 'delta', text: 'A fish' })])),
    );
    const result = await api(f.fetch).sendTurn(request, () => undefined);
    expect(result).toEqual(storedResult);
  });

  it('fails retryably when it ends without done and nothing is stored', async () => {
    const f = fakeFetch((call) =>
      call.body.action === 'fetch_turn' ? jsonResponse(null) : sseResponse(streamOf([frame(meta)])),
    );
    const error = await rejection(api(f.fetch).sendTurn(request, () => undefined));
    expect(error).toMatchObject({ code: 'upstream', retryable: true });
  });
});

describe('sendTurn: abort', () => {
  it('rejects with an AbortError, stops reading and does not look for a stored turn', async () => {
    const controller = new AbortController();
    const f = fakeFetch(() =>
      sseResponse(streamOf([frame(meta), frame({ type: 'delta', text: 'A' })], { hang: true })),
    );
    const seen: TutorStreamEvent[] = [];
    const run = api(f.fetch).sendTurn(
      request,
      (event) => {
        seen.push(event);
        if (event.type === 'delta') controller.abort();
      },
      controller.signal,
    );
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    expect(f.calls).toHaveLength(1);
  });

  it('rejects at once if the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const f = fakeFetch(() => new Response());
    await expect(
      api(f.fetch).sendTurn(request, () => undefined, controller.signal),
    ).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(f.calls).toHaveLength(0);
  });

  it('passes the signal to fetch', async () => {
    const controller = new AbortController();
    const f = fakeFetch(() => sseResponse(streamOf([frame(meta), frame(done)])));
    await api(f.fetch).sendTurn(request, () => undefined, controller.signal);
    expect(f.calls[0]?.signal).toBe(controller.signal);
  });
});

describe('fetchTurn', () => {
  it('POSTs {action:"fetch_turn", child_id, client_turn_id} and returns the stored result', async () => {
    const f = fakeFetch(() => jsonResponse(storedResult));
    expect(await api(f.fetch).fetchTurn(CHILD, TURN)).toEqual(storedResult);
    expect(f.calls[0]?.body).toEqual({
      action: 'fetch_turn',
      child_id: CHILD,
      client_turn_id: TURN,
    });
    expect(f.calls[0]?.headers.Authorization).toBe('Bearer jwt-token');
  });

  it('returns null when the server has no such turn', async () => {
    for (const body of [null, { turn: null }, { result: null }]) {
      const f = fakeFetch(() => jsonResponse(body));
      expect(await api(f.fetch).fetchTurn(CHILD, TURN)).toBeNull();
    }
  });

  it('accepts the result wrapped as { turn }', async () => {
    const f = fakeFetch(() => jsonResponse({ turn: storedResult }));
    expect(await api(f.fetch).fetchTurn(CHILD, TURN)).toEqual(storedResult);
  });

  it('maps typed errors and rejects a malformed result', async () => {
    const typed = fakeFetch(() =>
      jsonResponse({ error: { code: 'forbidden', message: 'x', retryable: false } }, 403),
    );
    expect((await rejection(api(typed.fetch).fetchTurn(CHILD, TURN))).code).toBe('forbidden');
    const malformed = fakeFetch(() => jsonResponse({ reply: 5 }));
    expect((await rejection(api(malformed.fetch).fetchTurn(CHILD, TURN))).code).toBe('internal');
  });
});
