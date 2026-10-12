import { createClient, type SupabaseClient } from '@supabase/supabase-js';

export interface SupabaseConfig {
  url: string;
  /** The PUBLISHABLE key. The admin app never holds the service role key or any Anthropic key. */
  publishableKey: string;
}

/**
 * Reads the project URL and the publishable key from EXPO_PUBLIC_ variables (inlined at build time, so each
 * name must appear literally). Returns null when either is missing: that is demo mode.
 */
export function readSupabaseConfig(): SupabaseConfig | null {
  const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
  const publishableKey = process.env.EXPO_PUBLIC_SUPABASE_KEY;
  return url && publishableKey ? { url, publishableKey } : null;
}

/** supabase-js defaults on the web: the session is kept in localStorage and refreshed automatically. */
export function createSupabase(config: SupabaseConfig): SupabaseClient {
  return createClient(config.url, config.publishableKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
  });
}
