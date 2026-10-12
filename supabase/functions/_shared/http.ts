// HTTP plumbing shared by the edge functions: CORS, JSON responses, one error type, and the mapping of
// database (PostgREST) errors to HTTP statuses. Pure (Request/Response only), so it is unit tested in Node.

export const corsHeaders: Record<string, string> = {
  // The API is authenticated by a bearer token, never by cookies, so any origin may call it.
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Max-Age': '86400',
};

/** An error with an HTTP status and a stable machine-readable code (never an internal message). */
export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message?: string) {
    super(message ?? code);
    this.name = 'HttpError';
    this.status = status;
    this.code = code;
  }
}

export function json(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json', ...headers },
  });
}

/** `{ error: { code, message } }` with the right status. Unknown errors are logged and become a bare 500. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return json(error.status, { error: { code: error.code, message: error.message } });
  }
  console.error('unhandled error', error);
  return json(500, { error: { code: 'internal_error', message: 'internal_error' } });
}

export interface RpcError {
  code?: string;
  message?: string;
}

const STABLE_CODE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Maps a database error to an HTTP error. The RPCs raise stable snake_case messages (`not_authenticated`,
 * `pack_not_found`, ...) with SQLSTATE 42501 (not allowed), P0002 (not found) or 22023 (bad request); those
 * pass through. Anything else (a Postgres message, a network failure) becomes a bare 500: internals are
 * logged, never returned.
 */
export function rpcErrorToHttp(error: RpcError): HttpError {
  const message = error.message ?? '';
  const code = STABLE_CODE.test(message) ? message : undefined;
  switch (error.code) {
    case '42501':
      return code === 'not_authenticated'
        ? new HttpError(401, 'not_authenticated')
        : new HttpError(403, code ?? 'forbidden');
    case 'P0002':
      return new HttpError(404, code ?? 'not_found');
    case '22023':
      return code === 'pack_info_already_set'
        ? new HttpError(409, code)
        : new HttpError(400, code ?? 'invalid_request');
    case 'PGRST301':
    case 'PGRST303':
      return new HttpError(401, 'invalid_jwt');
    default:
      console.error('database error', error);
      return new HttpError(500, 'internal_error');
  }
}

const MAX_BODY_BYTES = 16 * 1024;

/** Reads a small JSON object body; anything else is a 400. */
export async function readJsonObject(req: Request): Promise<Record<string, unknown>> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'body_too_large');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, 'invalid_json');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new HttpError(400, 'invalid_json');
  }
  return value as Record<string, unknown>;
}

/**
 * Wraps a handler: answers CORS preflights, accepts POST only, requires an `Authorization: Bearer ...`
 * header (the platform has already verified the JWT, `verify_jwt = true`; the database re-checks it) and
 * turns every failure into a JSON error. The handler never sees an unauthenticated request.
 */
export async function handle(req: Request, handler: () => Promise<Response>): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
  try {
    if (req.method !== 'POST') throw new HttpError(405, 'method_not_allowed');
    const auth = req.headers.get('Authorization') ?? '';
    if (!/^Bearer\s+\S+$/i.test(auth)) throw new HttpError(401, 'not_authenticated');
    return await handler();
  } catch (error) {
    return errorResponse(error);
  }
}
