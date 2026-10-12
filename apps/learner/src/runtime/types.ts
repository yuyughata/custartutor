import type {
  DownloadManager,
  Network,
  PinGate,
  Ports,
  SyncApi,
  SyncEngine,
  TrustedClock,
} from '@custar/learner-core';
import type { TutorApi } from '@custar/tutor-core/client';
import type { HouseholdApi } from '../platform/householdApi';

/** Who is signed in. The real implementation wraps Supabase auth; demo mode keeps it in memory. */
export interface AuthPort {
  currentEmail(): Promise<string | null>;
  /** Subscribe to sign-in and sign-out. Returns an unsubscribe function. */
  onChange(listener: (email: string | null) => void): () => void;
}

/** Everything the screens need, built once at start-up. */
export interface Runtime {
  mode: 'demo' | 'live';
  ports: Ports;
  trusted: TrustedClock;
  api: SyncApi;
  households: HouseholdApi;
  auth: AuthPort;
  sync: SyncEngine;
  downloads: DownloadManager;
  pin: PinGate;
  network: Network;
  /** The AI tutor: consent, transcripts and chat turns. Live: the `tutor-chat` edge function. Demo: a labelled stand-in. */
  tutor: TutorApi;
  appVersion: string;
  /** Shown on the sign-in and PIN screens in demo mode so a tester can get in. */
  demoHint?: { code: string; pin: string };
  /** Demo mode only: lets a tester switch the pretend internet connection (to try the offline tutor). */
  demoControls?: { isOnline(): boolean; setOnline(online: boolean): void };
}
