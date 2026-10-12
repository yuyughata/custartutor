// One error type for everything the admin API can fail with, plus the mapping from PostgREST / RPC errors, edge
// function error bodies and network failures. `message` is written for the person using the app (plain words);
// `code` is the server's stable machine code, kept for support and for tests.
import { z } from 'zod';

export type AdminErrorKind =
  | 'unauthenticated'
  | 'session_expired'
  | 'mfa_required'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'kill_switch'
  | 'budget_exceeded'
  | 'network'
  | 'server'
  | 'bad_response'
  | 'unknown';

export class AdminApiError extends Error {
  readonly kind: AdminErrorKind;
  readonly code: string;
  readonly status: number | undefined;

  constructor(
    kind: AdminErrorKind,
    code: string,
    message: string,
    status?: number,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AdminApiError';
    this.kind = kind;
    this.code = code;
    this.status = status;
  }

  /** The same request may succeed later without a change. */
  get retryable(): boolean {
    return this.kind === 'network' || this.kind === 'server';
  }
}

export function isAdminApiError(error: unknown): error is AdminApiError {
  return error instanceof AdminApiError;
}

/** Plain words for the stable messages the RPCs, triggers and edge functions raise. */
const KNOWN: Record<string, { kind: AdminErrorKind; message: string }> = {
  not_authenticated: {
    kind: 'unauthenticated',
    message: 'Your session has ended. Please sign in again.',
  },
  invalid_jwt: {
    kind: 'session_expired',
    message: 'Your session has expired. Please sign in again.',
  },
  admin_role_required: {
    kind: 'forbidden',
    message: 'Your role is not allowed to do this. Ask a super admin if you need access.',
  },
  forbidden: {
    kind: 'forbidden',
    message: 'Your role is not allowed to do this. Ask a super admin if you need access.',
  },
  mfa_required: {
    kind: 'mfa_required',
    message: 'Authenticator code required. Enter the code from your authenticator app to continue.',
  },
  scheme_not_draft: {
    kind: 'conflict',
    message: 'This scheme is already approved, so it can no longer be replaced.',
  },
  scheme_not_found: { kind: 'not_found', message: 'That scheme no longer exists.' },
  scheme_not_approved: {
    kind: 'conflict',
    message: 'The scheme must be approved before chapters can be planned.',
  },
  scheme_needs_teaching_week: {
    kind: 'invalid',
    message: 'A scheme needs at least one teaching week before it can be approved.',
  },
  invalid_weeks: {
    kind: 'invalid',
    message: 'The server rejected the weeks table. Check each row.',
  },
  invalid_scheme: { kind: 'invalid', message: 'The server rejected the scheme. Check each row.' },
  invalid_plan: {
    kind: 'invalid',
    message: 'The server rejected the chapter plan. Check each chapter.',
  },
  unit_has_versions: {
    kind: 'conflict',
    message:
      'A unit that already has a draft version cannot be changed or removed here. Edit that unit in its workspace instead (Edit by hand makes a new version).',
  },
  chapter_unit_count_invalid: {
    kind: 'invalid',
    message: 'Every chapter needs 3 to 5 units.',
  },
  invalid_unit_layout: {
    kind: 'invalid',
    message: 'The server could not read that layout. Reload the page and try again.',
  },
  invalid_layout_unit: {
    kind: 'invalid',
    message: 'The server rejected a unit in the layout. Check its title, objective, kind, stage and periods.',
  },
  duplicate_unit_in_layout: {
    kind: 'invalid',
    message: 'A unit appears twice in the layout. Reload the page and try again.',
  },
  unit_not_in_scheme: {
    kind: 'not_found',
    message: 'A unit in the layout is no longer part of this scheme. Reload the page.',
  },
  chapter_not_in_scheme: {
    kind: 'not_found',
    message: 'A chapter in the layout is no longer part of this scheme. Reload the page.',
  },
  chapter_order_changed: {
    kind: 'invalid',
    message: 'Chapters keep their order; a new chapter goes after the existing ones.',
  },
  layout_out_of_date: {
    kind: 'conflict',
    message:
      'Someone changed the chapters or units since you opened this page. Reload to see their changes, then make your edit again. Nothing was applied.',
  },
  layout_renumbers_versioned_units: {
    kind: 'conflict',
    message: 'This layout renumbers units that already have drafts. Confirm to continue.',
  },
  published_unit_cannot_move: {
    kind: 'conflict',
    message: 'A unit that has been published stays in its chapter.',
  },
  unit_not_editable: {
    kind: 'conflict',
    message: 'This unit was removed from its chapter, so it cannot get new versions.',
  },
  invalid_unit_content: {
    kind: 'invalid',
    message: 'The server did not accept that content. Fix the problems shown in the editor first.',
  },
  unit_content_too_large: {
    kind: 'invalid',
    message: 'This unit is too large to save (over 5 MB).',
  },
  invalid_lint_report: {
    kind: 'invalid',
    message: 'The server did not accept the lint report that goes with the version.',
  },
  stale_base: {
    kind: 'conflict',
    message: 'A newer version of this unit exists. Reload the page and try again.',
  },
  illegal_status_move: {
    kind: 'conflict',
    message: 'That status change is not allowed from the version’s current status.',
  },
  reviewer_required: {
    kind: 'forbidden',
    message: 'Only a reviewer or a super admin can approve a version.',
  },
  unit_version_not_found: { kind: 'not_found', message: 'That version no longer exists.' },
  unit_version_not_approved: {
    kind: 'conflict',
    message: 'Only an approved version can be published.',
  },
  unit_version_superseded: {
    kind: 'conflict',
    message: 'That version has been replaced by a newer one.',
  },
  unit_version_older_than_current: {
    kind: 'conflict',
    message: 'A newer version of this unit is already published.',
  },
  unit_version_content_empty: { kind: 'invalid', message: 'This version has no content.' },
  unit_not_publishable: { kind: 'conflict', message: 'This unit cannot be published yet.' },
  approved_version_is_frozen: {
    kind: 'conflict',
    message: 'An approved version cannot be changed.',
  },
  published_unit_not_found: { kind: 'not_found', message: 'That published unit no longer exists.' },
  not_current: {
    kind: 'conflict',
    message:
      'That published snapshot has been replaced by a newer one, so no pack is built for it.',
  },
  content_not_packable: {
    kind: 'invalid',
    message: 'The unit content could not be turned into a lesson pack. See the lint panel.',
  },
  upload_failed: { kind: 'server', message: 'The pack files could not be stored. Try again.' },
  pack_info_already_set: {
    kind: 'conflict',
    message: 'A different pack is already recorded for this snapshot.',
  },
  kill_switch: {
    kind: 'kill_switch',
    message: 'AI drafting is switched off. A super admin can switch it on under Usage & settings.',
  },
  budget_exceeded: {
    kind: 'budget_exceeded',
    message: 'A spending cap was reached. A super admin can raise it under Usage & settings.',
  },
  unauthenticated: {
    kind: 'unauthenticated',
    message: 'Your session has ended. Please sign in again.',
  },
  invalid_request: { kind: 'invalid', message: 'The server could not accept that request.' },
  not_found: { kind: 'not_found', message: 'That item no longer exists.' },
  conflict: {
    kind: 'conflict',
    message: 'That conflicts with a newer change. Reload and try again.',
  },
  internal: {
    kind: 'server',
    message: 'Something went wrong on the server. Try again in a moment.',
  },
  internal_error: {
    kind: 'server',
    message: 'Something went wrong on the server. Try again in a moment.',
  },
};

const STABLE_CODE = /^[a-z][a-z0-9_]{1,63}$/;

export interface PostgrestLike {
  message?: string;
  code?: string;
  details?: string | null;
  hint?: string | null;
  status?: number;
}

/** Maps an error from a PostgREST query, an RPC or Storage into an AdminApiError. */
export function fromPostgrest(
  error: PostgrestLike,
  fallbackMessage = 'The request failed.',
): AdminApiError {
  const message = error.message ?? '';
  const stable = STABLE_CODE.test(message) ? message : undefined;
  const known = stable ? KNOWN[stable] : undefined;
  if (known)
    return new AdminApiError(known.kind, stable as string, known.message, error.status, error);

  switch (error.code) {
    case 'PGRST301':
    case 'PGRST303':
      return new AdminApiError(
        'session_expired',
        'invalid_jwt',
        'Your session has expired. Please sign in again.',
        401,
        error,
      );
    case '42501':
      return new AdminApiError(
        'forbidden',
        stable ?? 'forbidden',
        'The server refused this. Your role may not allow it, or the authenticator code is needed again.',
        403,
        error,
      );
    case 'P0002':
    case 'PGRST116':
      return new AdminApiError(
        'not_found',
        stable ?? 'not_found',
        'That item no longer exists.',
        404,
        error,
      );
    case '23505':
    case '23503':
    case '23P01':
      return new AdminApiError(
        'conflict',
        stable ?? 'conflict',
        'That conflicts with something that already exists. Reload and try again.',
        409,
        error,
      );
    case '22023':
    case '22P02':
    case '23514':
    case '23502':
      return new AdminApiError(
        'invalid',
        stable ?? 'invalid_request',
        stable
          ? `The server rejected that (${stable.replace(/_/g, ' ')}).`
          : 'The server rejected that input.',
        400,
        error,
      );
    default:
      break;
  }
  if (/row-level security|permission denied/i.test(message)) {
    return new AdminApiError(
      'forbidden',
      'forbidden',
      'The server refused this. Your role may not allow it, or the authenticator code is needed again.',
      403,
      error,
    );
  }
  if (/jwt expired|invalid jwt|not authenticated/i.test(message)) {
    return new AdminApiError(
      'session_expired',
      'invalid_jwt',
      'Your session has expired. Please sign in again.',
      401,
      error,
    );
  }
  if (/failed to fetch|networkerror|network request failed|load failed/i.test(message)) {
    return new AdminApiError('network', 'network', NETWORK_MESSAGE, undefined, error);
  }
  return new AdminApiError(
    'unknown',
    stable ?? 'unknown',
    stable ? `${fallbackMessage} (${stable.replace(/_/g, ' ')})` : fallbackMessage,
    error.status,
    error,
  );
}

export const NETWORK_MESSAGE =
  'Could not reach the server. Check your internet connection and try again.';

/** A fetch that threw (offline, DNS, CORS) or was aborted. */
export function fromNetwork(cause: unknown): AdminApiError {
  return new AdminApiError('network', 'network', NETWORK_MESSAGE, undefined, cause);
}

export const AiJobErrorBodySchema = z.object({
  error: z.object({ code: z.string(), message: z.string().optional() }),
});

function kindForStatus(status: number): AdminErrorKind {
  if (status === 401) return 'unauthenticated';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not_found';
  if (status === 409) return 'conflict';
  if (status === 400 || status === 422) return 'invalid';
  if (status >= 500) return 'server';
  return 'unknown';
}

/** Parses an edge function error body (`{error:{code,message}}`) into an AdminApiError. */
export function fromEdgeFunction(status: number, body: unknown): AdminApiError {
  const parsed = AiJobErrorBodySchema.safeParse(body);
  if (!parsed.success) {
    return new AdminApiError(
      kindForStatus(status),
      `http_${status}`,
      status >= 500
        ? 'The server had a problem. Try again in a moment.'
        : `The server refused the request (HTTP ${status}).`,
      status,
      body,
    );
  }
  const code = parsed.data.error.code;
  const known = KNOWN[code];
  if (known) return new AdminApiError(known.kind, code, known.message, status, body);
  const serverMessage = parsed.data.error.message;
  return new AdminApiError(
    kindForStatus(status),
    code,
    serverMessage && serverMessage !== code
      ? serverMessage
      : `The server refused the request (${code.replace(/_/g, ' ')}).`,
    status,
    body,
  );
}

/** A response that did not match the schema the app expects. */
export function badResponse(what: string, cause?: unknown): AdminApiError {
  return new AdminApiError(
    'bad_response',
    'bad_response',
    `The server sent something unexpected for ${what}. If this keeps happening, tell the developers.`,
    undefined,
    cause,
  );
}

/** Whatever was thrown, as an AdminApiError. */
export function toAdminError(error: unknown): AdminApiError {
  if (isAdminApiError(error)) return error;
  // The job client (runJob, the in-memory job API) throws errors that carry a protocol `code`.
  const protocolCode = (error as { code?: unknown } | null)?.code;
  if (
    error instanceof Error &&
    typeof protocolCode === 'string' &&
    KNOWN[protocolCode] !== undefined
  ) {
    const known = KNOWN[protocolCode];
    const status = (error as { status?: unknown }).status;
    return new AdminApiError(
      known.kind,
      protocolCode,
      known.message,
      typeof status === 'number' ? status : undefined,
      error,
    );
  }
  if (error instanceof Error && /failed to fetch|network|load failed/i.test(error.message)) {
    return fromNetwork(error);
  }
  if (error instanceof Error && error.name === 'AbortError') {
    return new AdminApiError('unknown', 'aborted', 'The request was cancelled.', undefined, error);
  }
  return new AdminApiError(
    'unknown',
    'unknown',
    error instanceof Error && error.message ? error.message : 'Something went wrong.',
    undefined,
    error,
  );
}

/**
 * The units with versions that a layout would renumber, from the DETAIL of a `layout_renumbers_versioned_units`
 * refusal (the server sends them as JSON), or null for any other error. The planner computes the same list before it
 * calls, so this is only the fallback when the page's idea of the layout was out of step with the server's.
 */
export function renumberDetail(
  error: unknown,
): { id: string; title: string; from: number; to: number }[] | null {
  if (!isAdminApiError(error) || error.code !== 'layout_renumbers_versioned_units') return null;
  const cause = error.cause as { details?: unknown } | undefined;
  const raw = cause?.details;
  if (Array.isArray(raw)) return raw as { id: string; title: string; from: number; to: number }[];
  if (typeof raw !== 'string') return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as { id: string; title: string; from: number; to: number }[]) : [];
  } catch {
    return [];
  }
}
