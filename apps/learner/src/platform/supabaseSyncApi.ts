import type { SupabaseClient } from '@supabase/supabase-js';
import {
  RPC,
  SyncApiError,
  toSyncApiError,
  type PackDownload,
  type PullResponse,
  type PushResult,
  type SyncApi,
  type WireEvent,
} from '@custar/learner-core';

interface ErrorLike {
  message?: string;
  code?: string;
  status?: number;
  context?: { status?: number };
}

/** Maps a supabase-js / PostgREST / Postgres error to the categories the engine branches on. */
function mapError(error: ErrorLike, status?: number): SyncApiError {
  const message = error.message ?? 'request failed';
  const http = status ?? error.status ?? error.context?.status;
  if (message === 'weak_pin') return new SyncApiError('weak_pin', message);
  if (message === 'invalid_pin_format') return new SyncApiError('weak_pin', message);
  if (message === 'elevation_required') return new SyncApiError('elevation_required', message);
  if (http === 401 || error.code === 'PGRST301' || message === 'not_authenticated') {
    return new SyncApiError('unauthenticated', message, http === undefined ? {} : { status: http });
  }
  if (http === 403 || error.code === '42501') {
    return new SyncApiError('forbidden', message, http === undefined ? {} : { status: http });
  }
  if (http === 0 || http === undefined || /network|fetch|timeout|offline/i.test(message)) {
    // supabase-js reports a failed fetch (no connection) as a status-less error.
    if (http === undefined && error.code && error.code.length > 0) {
      return new SyncApiError('server', message);
    }
    return new SyncApiError('offline', message);
  }
  return new SyncApiError('server', message, { status: http });
}

/** The real server: every method is one RPC (or edge function) from `wire.ts`. */
export function createSupabaseSyncApi(supabase: SupabaseClient): SyncApi {
  async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
    try {
      const { data, error, status } = await supabase.rpc(name, args);
      if (error) throw mapError(error, status);
      return data as T;
    } catch (error) {
      throw toSyncApiError(error);
    }
  }

  return {
    pushEvents: (events: WireEvent[]) =>
      rpc<PushResult[]>(RPC.ingestProgressEvents, { p_events: events }),

    pull: (sinceSeq, limit) =>
      rpc<PullResponse>(RPC.syncPull, { p_since_seq: sinceSeq, p_limit: limit }),

    async getPackDownload(unitId, versionNo): Promise<PackDownload> {
      try {
        // SQL cannot sign storage URLs, so this wire call is an edge function with the same JSON.
        const { data, error, response } = await supabase.functions.invoke('get-pack-download', {
          body: { p_unit_id: unitId, p_version_no: versionNo },
        });
        if (error) throw mapError(error as ErrorLike, response?.status);
        return data as PackDownload;
      } catch (error) {
        throw toSyncApiError(error);
      }
    },

    async elevateGrownup(deviceId, pin) {
      // The RPC returns NULL (not an error) for a wrong PIN or a lockout.
      const expires = await rpc<string | null>(RPC.elevateGrownup, {
        p_device_id: deviceId,
        p_pin: pin,
      });
      if (!expires) throw new SyncApiError('invalid_pin');
      return { expires_at: expires };
    },

    async setGrownupPin(pin) {
      await rpc<null>(RPC.setGrownupPin, { p_pin: pin });
    },
  };
}
