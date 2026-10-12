// Errors of the `tutor-chat` edge function: the protocol's error codes (TUTOR_ERROR_CODES in
// packages/tutor-core/src/contract.ts), their HTTP statuses, the calm sentence a person sees for each, and the mapping
// of database errors to them. Pure; shared by the handler and the context reader.
//
// This file does not import the contract: edge functions can only bundle files inside supabase/functions, so the
// codes are repeated here and tutor-chat-handler.test.ts checks them against the contract.
//
// What may leave the function in an error: the code, a fixed sentence and `retryable`. Never a database message, a
// prompt, a model reply, the classifier's categories, a stack trace or a key.

export const TUTOR_ERROR_CODES = [
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
] as const;
export type TutorErrorCode = (typeof TUTOR_ERROR_CODES)[number];

export const STATUS_OF_CODE: Record<TutorErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  consent_required: 403,
  tutor_disabled: 503,
  kill_switch: 503,
  daily_limit: 429,
  invalid_request: 400,
  unit_not_found: 404,
  busy: 409,
  upstream: 502,
  internal: 500,
};

/** Whether trying the same request again later can work. The app shows a calm "try again" only for these. */
export const RETRYABLE: Record<TutorErrorCode, boolean> = {
  unauthenticated: false,
  forbidden: false,
  consent_required: false,
  tutor_disabled: false,
  kill_switch: false,
  daily_limit: false,
  invalid_request: false,
  unit_not_found: false,
  busy: true,
  upstream: true,
  internal: true,
};

/** Fixed sentences, written for a grown-up reading them on a child's device. */
export const MESSAGE_OF_CODE: Record<TutorErrorCode, string> = {
  unauthenticated: 'Please sign in again.',
  forbidden: 'This child is not available to you.',
  consent_required: 'A parent or guardian needs to switch the tutor on for this child first.',
  tutor_disabled: 'The tutor is not available right now.',
  kill_switch: 'The tutor is paused for now. Please try again later.',
  daily_limit: 'The tutor has helped enough for today. Come back tomorrow.',
  invalid_request: 'The request was not valid.',
  unit_not_found: 'That lesson is not available.',
  busy: 'The tutor is still answering. Please wait a moment.',
  upstream: 'The tutor could not answer just now. Please try again.',
  internal: 'Something went wrong. Please try again.',
};

/** An error that becomes a `TutorErrorBody` response. The message is written for people and is always safe. */
export class TutorHttpError extends Error {
  readonly code: TutorErrorCode;
  readonly status: number;
  readonly retryable: boolean;

  constructor(code: TutorErrorCode, message: string = MESSAGE_OF_CODE[code], status?: number) {
    super(message);
    this.name = 'TutorHttpError';
    this.code = code;
    this.status = status ?? STATUS_OF_CODE[code];
    this.retryable = RETRYABLE[code];
  }
}

export interface DbError {
  code?: string;
  message?: string;
}

const STABLE_MESSAGE = /^[a-z][a-z0-9_]{1,63}$/;

/**
 * Stable messages raised by the RPCs. A child that is not the caller's and one that does not exist are the same
 * answer (`forbidden`): the response never tells whether a child id exists for somebody else.
 */
const KNOWN: Record<string, TutorErrorCode> = {
  not_authenticated: 'unauthenticated',
  child_not_found: 'forbidden',
  not_a_guardian: 'forbidden',
  session_not_found: 'invalid_request',
  session_unit_mismatch: 'invalid_request',
  unit_not_found: 'unit_not_found',
};

export function mapDbError(
  error: DbError,
  log: (event: string, detail: Record<string, unknown>) => void,
): TutorHttpError {
  const message = error.message ?? '';
  if (error.code === 'PGRST301' || error.code === 'PGRST303') {
    return new TutorHttpError('unauthenticated');
  }
  const known = KNOWN[message];
  if (known) {
    return new TutorHttpError(
      known,
      known === 'invalid_request' ? 'That conversation was not found. Start a new one.' : undefined,
    );
  }
  // Only the SQLSTATE and a stable machine message are logged. A database message can quote a value (an invalid input
  // syntax error repeats it), and a value here can be a child's words, so anything else stays out of the logs.
  log('database_error', {
    code: error.code ?? null,
    message: STABLE_MESSAGE.test(message) ? message : null,
  });
  return new TutorHttpError('internal');
}

/** Removes anything that looks like an API key and bounds the length: for logs only. */
export function scrub(text: string, max = 200): string {
  const cleaned = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ');
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}
