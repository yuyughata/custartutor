import {
  CURRENT_TUTOR_CONSENT_VERSION,
  TutorApiError,
  TutorStreamEvent,
  TutorTurnResult,
  createSseParser,
  type SafetyAction,
  type ShowActivity,
  type TutorApi,
  type TutorChatRequest,
  type TutorConsentState,
  type TutorErrorBody,
  type TutorErrorCode,
  type TutorSessionSummary,
  type TutorTranscriptMessage,
} from '@custar/tutor-core/client';

/**
 * The live `TutorApi`: consent, sessions and transcripts through RPCs, and chat turns through the `tutor-chat`
 * edge function, whose reply streams as SSE.
 *
 * NOT VERIFIED AGAINST A SERVER: nothing here has run against Supabase or a real network. The tests use a fake
 * client and a fake fetch. Message text is only ever put into the request body; it is never logged.
 */

// ---- ports -----------------------------------------------------------------------------------------

/** The slice of the supabase-js client this adapter uses. */
export interface TutorSupabase {
  auth: {
    getSession(): Promise<{ data: { session: { access_token: string } | null } }>;
  };
  rpc(
    name: string,
    args: Record<string, unknown>,
  ): PromiseLike<{
    data: unknown;
    error: { message?: string; code?: string } | null;
    status?: number;
  }>;
}

/** The slice of a fetch Response this adapter uses (`expo/fetch` and the browser's both fit). */
export interface TutorFetchResponse {
  ok: boolean;
  status: number;
  body: ReadableStream<Uint8Array> | null;
  headers?: { get(name: string): string | null };
  json(): Promise<unknown>;
  text(): Promise<string>;
}

export type TutorFetch = (
  url: string,
  init: {
    method: 'POST';
    headers: Record<string, string>;
    body: string;
    signal?: AbortSignal | undefined;
  },
) => Promise<TutorFetchResponse>;

export interface SupabaseTutorApiOptions {
  supabase: TutorSupabase;
  /** The project URL, for example `https://<ref>.supabase.co`. */
  url: string;
  /** The publishable key (the only key the app ever has). */
  publishableKey: string;
  /** `expo/fetch` on native (it streams), the global fetch on the web. */
  fetch: TutorFetch;
}

// ---- errors ----------------------------------------------------------------------------------------

interface RpcError {
  message?: string;
  code?: string;
}

/** Maps a PostgREST / supabase-js error to a `TutorApiError`. The server's message is never shown to a child. */
export function mapRpcError(error: RpcError, status?: number): TutorApiError {
  const message = error.message ?? '';
  if (message.includes('elevation_required')) return new TutorApiError('elevation_required');
  if (status === 401 || error.code === 'PGRST301' || message.includes('not_authenticated')) {
    return new TutorApiError('unauthenticated');
  }
  if (status === 403 || error.code === '42501' || message.includes('forbidden')) {
    return new TutorApiError('forbidden');
  }
  // supabase-js reports a failed fetch (no connection) as a status-less or status-0 error.
  if (
    status === undefined ||
    status === 0 ||
    /network|failed to fetch|timeout|offline/i.test(message)
  ) {
    return new TutorApiError('offline', undefined, true);
  }
  return new TutorApiError('internal', undefined, status >= 500 || status === 429);
}

const ERROR_CODES: readonly TutorErrorCode[] = [
  'unauthenticated',
  'forbidden',
  'consent_required',
  'tutor_disabled',
  'kill_switch',
  'daily_limit',
  'invalid_request',
  'unit_not_found',
  'busy',
  'upstream',
  'internal',
];

function isErrorCode(value: unknown): value is TutorErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}

/** A non-2xx reply of `tutor-chat`: the typed JSON body when there is one, else a guess from the status. */
async function errorFromResponse(response: TutorFetchResponse): Promise<TutorApiError> {
  try {
    const body = (await response.json()) as Partial<TutorErrorBody> | null;
    const error = body?.error;
    if (error && isErrorCode(error.code)) {
      return new TutorApiError(error.code, undefined, error.retryable === true);
    }
  } catch {
    // not JSON: fall through to the status
  }
  if (response.status === 401) return new TutorApiError('unauthenticated');
  if (response.status === 403) return new TutorApiError('forbidden');
  if (response.status === 429) return new TutorApiError('daily_limit');
  return new TutorApiError('upstream', undefined, response.status >= 500);
}

function abortError(): Error {
  const error = new Error('Aborted');
  error.name = 'AbortError';
  return error;
}

// ---- shapes of the RPC results ---------------------------------------------------------------------

const bad = () => new TutorApiError('internal', 'unexpected reply', false);

function record(value: unknown): Record<string, unknown> {
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'object' || first === null) throw bad();
  return first as Record<string, unknown>;
}

function parseConsent(data: unknown): TutorConsentState {
  const row = record(data);
  const { granted, version, required_version: required } = row;
  if (typeof granted !== 'boolean' || typeof required !== 'string') throw bad();
  if (version !== null && version !== undefined && typeof version !== 'string') throw bad();
  return {
    granted,
    version: typeof version === 'string' ? version : null,
    required_version: required,
  };
}

function parseSessions(data: unknown): TutorSessionSummary[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw bad();
  return data.map((item): TutorSessionSummary => {
    const row = record(item);
    if (
      typeof row.id !== 'string' ||
      typeof row.unit_id !== 'string' ||
      typeof row.started_at !== 'string' ||
      typeof row.turns !== 'number'
    ) {
      throw bad();
    }
    return {
      id: row.id,
      unit_id: row.unit_id,
      started_at: row.started_at,
      turns: row.turns,
      has_withheld: row.has_withheld === true,
    };
  });
}

function parseTranscript(data: unknown): TutorTranscriptMessage[] {
  if (data === null || data === undefined) return [];
  if (!Array.isArray(data)) throw bad();
  return data.map((item): TutorTranscriptMessage => {
    const row = record(item);
    if (
      typeof row.id !== 'string' ||
      (row.role !== 'child' && row.role !== 'tutor') ||
      typeof row.created_at !== 'string'
    ) {
      throw bad();
    }
    return {
      id: row.id,
      role: row.role,
      text: typeof row.text === 'string' ? row.text : '',
      created_at: row.created_at,
      withheld: row.withheld === true,
    };
  });
}

// ---- the stream ------------------------------------------------------------------------------------

/** What the events of one turn add up to. */
interface TurnAccumulator {
  sessionId: string | null;
  messageId: string | null;
  text: string;
  replaced: boolean;
  safety: SafetyAction;
  activity: ShowActivity | null;
  done: boolean;
}

function accumulate(acc: TurnAccumulator, event: TutorStreamEvent): void {
  switch (event.type) {
    case 'meta':
      acc.sessionId = event.session_id;
      acc.messageId = event.message_id;
      break;
    case 'delta':
      acc.text += event.text;
      break;
    case 'replace':
      acc.text = event.text;
      acc.replaced = true;
      break;
    case 'safety':
      acc.safety = event.action;
      break;
    case 'tool':
      acc.activity = event.input;
      break;
    case 'done':
      acc.done = true;
      acc.messageId = event.message_id;
      break;
    case 'error':
      break;
  }
}

function resultFromAccumulator(acc: TurnAccumulator): TutorTurnResult | null {
  if (!acc.sessionId || !acc.messageId) return null;
  const status =
    acc.safety === 'safe_reply'
      ? 'safe_reply'
      : acc.safety === 'blocked' || acc.safety === 'redirect'
        ? 'blocked'
        : acc.replaced
          ? 'replaced'
          : 'complete';
  return {
    session_id: acc.sessionId,
    message_id: acc.messageId,
    status,
    reply: acc.text.length > 0 ? acc.text : null,
    safety_action: acc.safety,
    show_activity: acc.activity,
  };
}

/** The one place that talks to the stream codec of tutor-core. */
function newParser(): { push(chunk: string): unknown[]; end(): unknown[] } {
  return createSseParser() as unknown as { push(chunk: string): unknown[]; end(): unknown[] };
}

function toEvents(raw: unknown[]): TutorStreamEvent[] {
  const events: TutorStreamEvent[] = [];
  for (const item of raw) {
    const parsed = TutorStreamEvent.safeParse(item);
    if (parsed.success) events.push(parsed.data); // unknown event types are ignored on purpose
  }
  return events;
}

// ---- the adapter -----------------------------------------------------------------------------------

export function createSupabaseTutorApi(options: SupabaseTutorApiOptions): TutorApi {
  const { supabase, publishableKey, fetch } = options;
  const endpoint = `${options.url.replace(/\/+$/, '')}/functions/v1/tutor-chat`;

  async function rpc(name: string, args: Record<string, unknown>): Promise<unknown> {
    let result: Awaited<ReturnType<TutorSupabase['rpc']>>;
    try {
      result = await supabase.rpc(name, args);
    } catch {
      throw new TutorApiError('offline', undefined, true);
    }
    if (result.error) throw mapRpcError(result.error, result.status);
    return result.data;
  }

  async function accessToken(): Promise<string> {
    let token: string | undefined;
    try {
      const { data } = await supabase.auth.getSession();
      token = data.session?.access_token;
    } catch {
      throw new TutorApiError('offline', undefined, true);
    }
    if (!token) throw new TutorApiError('unauthenticated');
    return token;
  }

  async function post(
    body: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<TutorFetchResponse> {
    if (signal?.aborted) throw abortError();
    const token = await accessToken();
    try {
      return await fetch(endpoint, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: publishableKey,
          'Content-Type': 'application/json',
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw abortError();
      }
      throw new TutorApiError('offline', undefined, true);
    }
  }

  async function fetchTurn(childId: string, clientTurnId: string): Promise<TutorTurnResult | null> {
    const response = await post({
      action: 'fetch_turn',
      child_id: childId,
      client_turn_id: clientTurnId,
    });
    if (!response.ok) throw await errorFromResponse(response);
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw bad();
    }
    if (data === null || data === undefined) return null;
    // Accept the result itself, or wrapped as { turn: ... } / { result: ... }, or { turn: null } for "not found".
    const wrapped = data as { turn?: unknown; result?: unknown };
    const candidate =
      'turn' in wrapped ? wrapped.turn : 'result' in wrapped ? wrapped.result : data;
    if (candidate === null || candidate === undefined) return null;
    const parsed = TutorTurnResult.safeParse(candidate);
    if (!parsed.success) throw bad();
    return parsed.data;
  }

  async function sendTurn(
    request: TutorChatRequest,
    onEvent: (event: TutorStreamEvent) => void,
    signal?: AbortSignal,
  ): Promise<TutorTurnResult> {
    const response = await post({ ...request, action: 'turn' }, signal);
    if (!response.ok) throw await errorFromResponse(response);

    // A repeat of a finished turn may come back as the stored result instead of a stream.
    if (response.headers?.get('content-type')?.includes('application/json')) {
      let data: unknown;
      try {
        data = await response.json();
      } catch {
        throw bad();
      }
      const parsed = TutorTurnResult.safeParse(data);
      if (!parsed.success) throw bad();
      if (parsed.data.reply) onEvent({ type: 'delta', text: parsed.data.reply });
      return parsed.data;
    }

    const acc: TurnAccumulator = {
      sessionId: null,
      messageId: null,
      text: '',
      replaced: false,
      safety: 'allow',
      activity: null,
      done: false,
    };
    const parser = newParser();
    let streamError: TutorApiError | null = null;

    const handle = (events: TutorStreamEvent[]): void => {
      for (const event of events) {
        if (streamError) return;
        accumulate(acc, event);
        try {
          onEvent(event);
        } catch {
          // a failing listener must not break the stream
        }
        if (event.type === 'error')
          streamError = new TutorApiError(event.code, undefined, event.retryable);
      }
    };

    try {
      if (!response.body) {
        handle(toEvents(parser.push(await response.text())));
      } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        try {
          for (;;) {
            if (signal?.aborted) throw abortError();
            const { done, value } = await reader.read();
            if (done) break;
            handle(toEvents(parser.push(decoder.decode(value, { stream: true }))));
            if (streamError) break;
          }
        } finally {
          if (streamError || signal?.aborted) void reader.cancel().catch(() => undefined);
        }
      }
      if (!streamError) handle(toEvents(parser.end()));
    } catch (error) {
      if (signal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
        throw abortError();
      }
      // The connection dropped mid-stream: the server may have finished the turn; look before giving up.
      const stored = await fetchTurn(request.child_id, request.client_turn_id).catch(() => null);
      if (stored) return stored;
      throw new TutorApiError('upstream', undefined, true);
    }

    if (streamError) throw streamError;
    const fromEvents = acc.done ? resultFromAccumulator(acc) : null;
    if (fromEvents) return fromEvents;

    // The stream ended without `done`: the stored result is the truth.
    const stored = await fetchTurn(request.child_id, request.client_turn_id).catch(() => null);
    if (stored) return stored;
    throw new TutorApiError('upstream', undefined, true);
  }

  return {
    async consent(childId) {
      return parseConsent(await rpc('get_tutor_consent', { p_child_id: childId }));
    },
    async setConsent(childId, action) {
      await rpc('set_tutor_consent', {
        p_child_id: childId,
        p_action: action,
        p_version: CURRENT_TUTOR_CONSENT_VERSION,
      });
    },
    sendTurn,
    fetchTurn,
    async listSessions(childId, limit = 20) {
      return parseSessions(
        await rpc('list_tutor_sessions', { p_child_id: childId, p_limit: limit }),
      );
    },
    async getTranscript(sessionId) {
      return parseTranscript(await rpc('get_tutor_transcript', { p_session_id: sessionId }));
    },
  };
}
