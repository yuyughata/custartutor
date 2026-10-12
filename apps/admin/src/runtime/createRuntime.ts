import { createSupabaseAdminApi } from '../api/supabaseAdminApi';
import { isAdminRole, type AdminRole } from '../lib/roles';
import { createSupabase, readSupabaseConfig, type SupabaseConfig } from '../platform/supabase';
import type { AdminRuntime } from './types';

const LIVE_POLL_MS = 1500;
const DEMO_POLL_MS = 250;

function createLiveRuntime(config: SupabaseConfig): AdminRuntime {
  const supabase = createSupabase(config);
  const api = createSupabaseAdminApi(supabase, {
    url: config.url,
    publishableKey: config.publishableKey,
  });
  return { mode: 'live', api, pollMs: LIVE_POLL_MS, host: new URL(config.url).host };
}

/** Demo only: `?demoRole=reviewer` in the address signs in as that role, to show what each role sees. */
function demoRoleFromUrl(): AdminRole | undefined {
  if (typeof window === 'undefined') return undefined;
  const value = new URLSearchParams(window.location.search).get('demoRole');
  return isAdminRole(value) ? value : undefined;
}

/** The demo backend (fixtures, stand-in model) is loaded on demand so a live build does not carry it. */
async function createDemoRuntime(): Promise<AdminRuntime> {
  const [{ createDemoAdminApi }, { DEMO_EMAIL_CODE, DEMO_TOTP_CODE }] = await Promise.all([
    import('../demo/demoAdminApi'),
    import('../demo/demoAuth'),
  ]);
  const initialRole = demoRoleFromUrl();
  return {
    mode: 'demo',
    api: createDemoAdminApi(initialRole ? { initialRole } : {}),
    pollMs: DEMO_POLL_MS,
    demoHint: { emailCode: DEMO_EMAIL_CODE, totpCode: DEMO_TOTP_CODE },
  };
}

/** Real Supabase when EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY are set, otherwise the in-memory demo. */
export async function createRuntime(): Promise<AdminRuntime> {
  const config = readSupabaseConfig();
  return config ? createLiveRuntime(config) : createDemoRuntime();
}
