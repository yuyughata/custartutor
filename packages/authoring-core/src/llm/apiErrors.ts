// Maps whatever the Anthropic client throws onto the port's `LlmError`. Duck-typed on purpose: the same code
// has to work with `npm:@anthropic-ai/sdk` in Deno and the Node SDK, and this package never imports either.
// The SDK's `APIError` carries `status`, `headers` (a web `Headers`), `error` (the JSON body) and `requestID`;
// connection failures and timeouts carry no `status`.
import { LlmError } from '../contract';

const MAX_MESSAGE_CHARS = 300;

/**
 * 408, 429 and any 5xx (the API uses 500, 502, 503 and 529 "overloaded") are worth retrying; any other 4xx is
 * a defect in the request or the key and will fail the same way again.
 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function toLlmTransportError(
  error: unknown,
  options: { signal?: AbortSignal | undefined; now: () => number },
): LlmError {
  if (error instanceof LlmError) return error;

  if (isAbort(error, options.signal)) {
    return new LlmError('aborted', 'The model call was aborted', { retryable: true, cause: error });
  }

  const status = readStatus(error);
  if (status === undefined) {
    // No HTTP response: DNS, reset, TLS, or the client's own timeout.
    return new LlmError('transport', `No response from the model API: ${describe(error)}`, {
      retryable: true,
      cause: error,
    });
  }

  const retryable = isRetryableStatus(status);
  const retryAfterMs = retryable ? parseRetryAfterMs(readHeaders(error), options.now) : undefined;
  const { type, message } = readServerError(error);
  const requestId = readString(error, 'requestID');
  const text =
    `The model API answered HTTP ${status}${type ? ` (${type})` : ''}` +
    `${message ? `: ${truncate(message)}` : ''}${requestId ? ` [request ${requestId}]` : ''}`;
  return new LlmError('transport', text, {
    retryable,
    status,
    cause: error,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

/**
 * The `retry-after-ms` header (non-standard, sent by the API), else `retry-after` as seconds or an HTTP date.
 * `undefined` when absent, unparseable, or not in the future.
 */
export function parseRetryAfterMs(headers: unknown, now: () => number): number | undefined {
  const millis = Number(readHeader(headers, 'retry-after-ms'));
  if (Number.isFinite(millis) && millis > 0) return Math.round(millis);

  const value = readHeader(headers, 'retry-after')?.trim();
  if (value === undefined || value === '') return undefined;
  if (/^\d+(\.\d+)?$/.test(value)) {
    const ms = Math.round(Number(value) * 1000);
    return ms > 0 ? ms : undefined;
  }
  const at = Date.parse(value);
  if (Number.isNaN(at)) return undefined;
  const wait = at - now();
  return wait > 0 ? wait : undefined;
}

/** The SDK refuses non-streaming requests it expects to outlast its timeout; see anthropic.ts. */
export function isStreamingRequiredError(error: unknown): boolean {
  return (
    readStatus(error) === undefined &&
    error instanceof Error &&
    /streaming is required/i.test(error.message)
  );
}

function isAbort(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted === true) return true;
  if (typeof error !== 'object' || error === null) return false;
  const named = error as { name?: unknown; code?: unknown; constructor?: { name?: unknown } };
  return (
    named.name === 'AbortError' ||
    named.code === 'ABORT_ERR' ||
    // The SDK's own abort error keeps the name "Error".
    named.constructor?.name === 'APIUserAbortError'
  );
}

function readStatus(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
    ? status
    : undefined;
}

function readHeaders(error: unknown): unknown {
  return typeof error === 'object' && error !== null
    ? (error as { headers?: unknown }).headers
    : undefined;
}

function readHeader(headers: unknown, name: string): string | undefined {
  if (typeof headers !== 'object' || headers === null) return undefined;
  const get = (headers as { get?: unknown }).get;
  if (typeof get === 'function') {
    const value: unknown = get.call(headers, name);
    return typeof value === 'string' ? value : undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name && (typeof value === 'string' || typeof value === 'number')) {
      return String(value);
    }
  }
  return undefined;
}

/** `{ type: 'error', error: { type, message } }` is the API's error body, kept on the SDK error as `.error`. */
function readServerError(error: unknown): { type?: string; message?: string } {
  const body =
    typeof error === 'object' && error !== null ? (error as { error?: unknown }).error : undefined;
  const inner =
    typeof body === 'object' && body !== null ? (body as { error?: unknown }).error : undefined;
  const source = typeof inner === 'object' && inner !== null ? inner : undefined;
  const type = readString(source, 'type');
  const message = readString(source, 'message');
  return {
    ...(type === undefined ? {} : { type }),
    ...(message === undefined ? {} : { message }),
  };
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const found = (value as Record<string, unknown>)[key];
  return typeof found === 'string' && found !== '' ? found : undefined;
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const name = error.name !== 'Error' ? `${error.name}: ` : '';
    return truncate(`${name}${error.message}`);
  }
  return 'unknown error';
}

function truncate(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_MESSAGE_CHARS ? `${flat.slice(0, MAX_MESSAGE_CHARS)}...` : flat;
}
