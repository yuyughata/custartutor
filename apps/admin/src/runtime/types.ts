import type { AdminApi } from '../api/types';

/** Everything the screens need, built once at start-up. */
export interface AdminRuntime {
  mode: 'demo' | 'live';
  api: AdminApi;
  /** How often a running job is polled, in milliseconds. */
  pollMs: number;
  /** Shown on the sign-in screen in demo mode so a tester can get in. */
  demoHint?: { emailCode: string; totpCode: string };
  /** The project host, for the live footer ("kjmjyxherydvefwtzmez.supabase.co"). */
  host?: string;
}
