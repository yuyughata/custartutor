// Supabase clients for the edge functions (Deno only; not unit tested).
//
//   userClient(req)  acts AS THE CALLER: it forwards the request's Authorization header, so every RPC and
//                    every table read runs under the caller's own permissions and RLS. All authorisation
//                    decisions go through it.
//   serviceClient()  the service role. It bypasses RLS and is used ONLY for the private `packs` bucket
//                    (reading a manifest, signing URLs, uploading pack files) and, in `ai-job`, for the
//                    four service-role-only `ai_job_*` lease/state/usage RPCs. Never for anything the
//                    caller's own permissions already allow, and never before the user client has
//                    authorised the request.

import { createClient } from 'npm:@supabase/supabase-js@2.117.3';
import type { SupabaseClient } from 'npm:@supabase/supabase-js@2.117.3';
import { HttpError } from './http.ts';

function required(name: string): string {
  const value = Deno.env.get(name);
  if (!value) {
    console.error(`missing environment variable ${name}`);
    throw new HttpError(500, 'internal_error');
  }
  return value;
}

/** The legacy variable when present, otherwise the `default` key of the new JSON key set. */
function key(legacyName: string, setName: string): string {
  const legacy = Deno.env.get(legacyName);
  if (legacy) return legacy;
  const set = Deno.env.get(setName);
  if (set) {
    try {
      const parsed = JSON.parse(set) as Record<string, string>;
      const value = parsed.default ?? Object.values(parsed)[0];
      if (value) return value;
    } catch {
      // fall through to the error below
    }
  }
  console.error(`missing ${legacyName} / ${setName}`);
  throw new HttpError(500, 'internal_error');
}

const AUTH_OPTIONS = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };

export function userClient(req: Request): SupabaseClient {
  const authorization = req.headers.get('Authorization');
  if (!authorization) throw new HttpError(401, 'not_authenticated');
  return createClient(
    required('SUPABASE_URL'),
    key('SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEYS'),
    {
      auth: AUTH_OPTIONS,
      global: { headers: { Authorization: authorization } },
    },
  );
}

export function serviceClient(): SupabaseClient {
  return createClient(
    required('SUPABASE_URL'),
    key('SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEYS'),
    { auth: AUTH_OPTIONS },
  );
}
