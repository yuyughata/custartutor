import type { PackDownload, PullResponse, PushResult, WireEvent } from './wire';

/**
 * The server port. The app implements it with supabase-js (each method is one RPC from `wire.ts`);
 * tests and the demo mode use `FakeSyncApi` from `@custar/learner-core/fakes`.
 *
 * Implementations MUST throw `SyncApiError` for every failure (map transport errors to `offline`, HTTP/PostgREST
 * errors by the table on `SyncApiErrorCode`) and MUST NOT throw for a per-row problem: those travel inside
 * `PushResult`. They should return the raw JSON; the engine validates it against the Zod schemas in `wire.ts`.
 */
export interface SyncApi {
  /** RPC `ingest_progress_events`. At most `MAX_PUSH_BATCH` events; one result per event. */
  pushEvents(events: WireEvent[]): Promise<PushResult[]>;
  /** RPC `sync_pull`. */
  pull(sinceSeq: number, limit: number): Promise<PullResponse>;
  /** RPC `get_pack_download`. */
  getPackDownload(unitId: string, versionNo: number): Promise<PackDownload>;
  /**
   * RPC `elevate_grownup` (ADR 0002). Resolves with the elevation expiry. The RPC returns NULL for a wrong PIN or
   * a lockout (it deliberately does not raise); the adapter turns NULL into `SyncApiError('invalid_pin')`.
   */
  elevateGrownup(deviceId: string, pin: string): Promise<{ expires_at: string }>;
  /** RPC `set_grownup_pin`. The first PIN needs no elevation; changing one does (`elevation_required`). */
  setGrownupPin(pin: string): Promise<void>;
}

/**
 * Failure categories the engine and UI branch on.
 *
 *  - `offline`          no connection, timeout, DNS failure. Retryable.
 *  - `server`           5xx, PostgREST/Postgres error, rate limit (429). Retryable later.
 *  - `unauthenticated`  401 / expired or missing session. Sync stops until the session is refreshed. Not retryable as is.
 *  - `forbidden`        403, RLS denial, `42501`.
 *  - `bad_response`     the server answered, but with JSON that does not match `wire.ts`. Not retryable as is.
 *  - `invalid_pin`      wrong PIN or locked out (the server does not say which).
 *  - `weak_pin`         `weak_pin` / `invalid_pin_format` from `set_grownup_pin`.
 *  - `elevation_required` changing an existing PIN needs a live elevation first.
 */
export type SyncApiErrorCode =
  | 'offline'
  | 'server'
  | 'unauthenticated'
  | 'forbidden'
  | 'bad_response'
  | 'invalid_pin'
  | 'weak_pin'
  | 'elevation_required';

export class SyncApiError extends Error {
  readonly code: SyncApiErrorCode;
  /** HTTP status when there was one. */
  readonly status?: number;

  constructor(
    code: SyncApiErrorCode,
    message?: string,
    options?: { status?: number; cause?: unknown },
  ) {
    super(message ?? code, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'SyncApiError';
    this.code = code;
    if (options?.status !== undefined) this.status = options.status;
  }

  /** True when trying the same call again later can succeed without any user action. */
  get retryable(): boolean {
    return this.code === 'offline' || this.code === 'server';
  }
}

/** Anything thrown that is not a `SyncApiError` is treated as a transport failure. */
export function toSyncApiError(error: unknown): SyncApiError {
  if (error instanceof SyncApiError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new SyncApiError('offline', message, { cause: error });
}
