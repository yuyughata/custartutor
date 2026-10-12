// Errors of the `ai-job` edge function: the protocol's error codes (AiJobErrorCode in
// packages/authoring-core/src/contract.ts), their HTTP statuses, and the mapping of database errors to them.
// Pure; shared by the handler and the input resolver.
//
// This file does not import the contract: edge functions can only bundle files inside supabase/functions, so the
// few contract names the function needs are repeated here and checked against the contract by ai-job-handler.test.ts.

export const AI_JOB_ERROR_CODES = [
  'unauthenticated',
  'forbidden',
  'mfa_required',
  'kill_switch',
  'budget_exceeded',
  'invalid_request',
  'not_found',
  'conflict',
  'internal',
] as const;
export type AiJobErrorCode = (typeof AI_JOB_ERROR_CODES)[number];

export const STATUS_OF_CODE: Record<AiJobErrorCode, number> = {
  unauthenticated: 401,
  forbidden: 403,
  mfa_required: 403,
  kill_switch: 503,
  budget_exceeded: 429,
  invalid_request: 400,
  not_found: 404,
  conflict: 409,
  internal: 500,
};

/** An error that becomes an `AiJobErrorBody` response. The message is written for people and is always safe. */
export class AiJobHttpError extends Error {
  readonly code: AiJobErrorCode;
  readonly status: number;

  constructor(code: AiJobErrorCode, message: string, status: number = STATUS_OF_CODE[code]) {
    super(message);
    this.name = 'AiJobHttpError';
    this.code = code;
    this.status = status;
  }
}

export interface DbError {
  code?: string;
  message?: string;
}

const STABLE_MESSAGE = /^[a-z][a-z0-9_]{1,63}$/;

/** Stable messages raised by the RPCs, as protocol errors with a sentence for the admin. */
const KNOWN: Record<string, { code: AiJobErrorCode; message: string }> = {
  not_authenticated: {
    code: 'unauthenticated',
    message: 'Your session has expired. Sign in again.',
  },
  admin_role_required: {
    code: 'forbidden',
    message:
      'Your account is not allowed to do this. Ask a super admin for the content editor role.',
  },
  kill_switch: { code: 'kill_switch', message: 'AI drafting is switched off (ai.kill_switch).' },
  too_many_jobs: {
    code: 'budget_exceeded',
    message: 'You already have 5 jobs in progress. Wait for one to finish or cancel one first.',
  },
  job_not_found: { code: 'not_found', message: 'That job does not exist.' },
  unit_not_found: { code: 'not_found', message: 'That unit does not exist.' },
  scheme_not_found: { code: 'not_found', message: 'That scheme does not exist.' },
  subject_not_found: { code: 'not_found', message: 'That subject does not exist.' },
  unit_version_not_found: { code: 'not_found', message: 'That version does not exist.' },
  idempotency_key_reused: {
    code: 'conflict',
    message: 'That request key was already used for a different kind of job.',
  },
  stale_base: {
    code: 'conflict',
    message: 'A newer version of this unit exists. Reload the page and try again.',
  },
  unit_not_editable: {
    code: 'conflict',
    message: 'This unit is archived and takes no new version.',
  },
};

/** Turns an error returned by Supabase (PostgREST / RPC) into a protocol error. Nothing internal leaks. */
export function mapDbError(
  error: DbError,
  log: (event: string, detail: Record<string, unknown>) => void,
): AiJobHttpError {
  const message = error.message ?? '';
  if (error.code === 'PGRST301' || error.code === 'PGRST303') {
    return new AiJobHttpError('unauthenticated', 'Your session has expired. Sign in again.');
  }
  const known = KNOWN[message];
  if (known) return new AiJobHttpError(known.code, known.message);
  if (STABLE_MESSAGE.test(message)) {
    if (error.code === 'P0002')
      return new AiJobHttpError('not_found', 'Something you asked for does not exist.');
    if (error.code === '22023')
      return new AiJobHttpError('invalid_request', `The request was refused (${message}).`);
    if (error.code === '42501')
      return new AiJobHttpError('forbidden', 'Your account is not allowed to do this.');
  }
  log('database_error', { code: error.code ?? null, message: scrub(message) });
  return new AiJobHttpError('internal', 'The server could not complete the request. Try again.');
}

/** Removes anything that looks like an API key and bounds the length: for logs only. */
export function scrub(text: string, max = 300): string {
  const cleaned = text.replace(/sk-ant-[A-Za-z0-9_-]+/g, '[redacted]').replace(/\s+/g, ' ');
  return cleaned.length > max ? `${cleaned.slice(0, max)}...` : cleaned;
}
