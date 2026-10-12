import * as Application from 'expo-application';
import {
  DownloadManager,
  PinGate,
  SyncEngine,
  TrustedClock,
  getOrCreateDeviceId,
  migrate,
  type Ports,
  type SyncApi,
} from '@custar/learner-core';
import {
  DEMO_PIN,
  FakeDownloader,
  FakeNetwork,
  MemoryFileStore,
  MemorySecureKv,
  createDemoServer,
  type DemoServer,
} from '@custar/learner-core/fakes';
import { openExpoSqlite } from '../platform/sqliteDriver';
import { createExpoDownloader, createExpoFileStore } from '../platform/expoFiles';
import { createExpoHasher, expoRandom } from '../platform/expoHasher';
import { expoNetwork } from '../platform/expoNetwork';
import { expoSecureKv } from '../platform/expoSecureKv';
import { createSupabaseHouseholdApi, type HouseholdApi } from '../platform/householdApi';
import { createSupabase, readSupabaseConfig, type SupabaseConfig } from '../platform/supabase';
import { createSupabaseSyncApi } from '../platform/supabaseSyncApi';
import type { AuthPort, Runtime } from './types';

const APP_VERSION = Application.nativeApplicationVersion ?? '1.0.0';
export const DEMO_CODE = '123456';

function assemble(parts: {
  mode: Runtime['mode'];
  ports: Omit<Ports, 'clock'>;
  trusted: TrustedClock;
  api: SyncApi;
  households: HouseholdApi;
  auth: AuthPort;
  network: Runtime['network'];
  demoHint?: Runtime['demoHint'];
}): Runtime {
  const ports: Ports = { ...parts.ports, clock: parts.trusted };
  return {
    mode: parts.mode,
    ports,
    trusted: parts.trusted,
    api: parts.api,
    households: parts.households,
    auth: parts.auth,
    network: parts.network,
    appVersion: APP_VERSION,
    sync: new SyncEngine({ ports, api: parts.api, trustedClock: parts.trusted }),
    downloads: new DownloadManager({
      ports,
      api: parts.api,
      network: parts.network,
      appVersion: APP_VERSION,
    }),
    pin: new PinGate({
      secure: ports.secure,
      hasher: ports.hasher,
      clock: ports.clock,
      random: ports.random,
      api: parts.api,
      deviceId: () => getOrCreateDeviceId(ports.db, ports.random),
    }),
    ...(parts.demoHint ? { demoHint: parts.demoHint } : {}),
  };
}

async function createLiveRuntime(config: SupabaseConfig): Promise<Runtime> {
  const db = await openExpoSqlite();
  await migrate(db);
  const files = createExpoFileStore();
  const trusted = await TrustedClock.create(db, { now: () => Date.now() });
  const supabase = createSupabase(config);

  const auth: AuthPort = {
    async currentEmail() {
      const { data } = await supabase.auth.getSession();
      return data.session?.user.email ?? null;
    },
    onChange(listener) {
      const { data } = supabase.auth.onAuthStateChange((_event, session) =>
        listener(session?.user.email ?? null),
      );
      return () => data.subscription.unsubscribe();
    },
  };

  return assemble({
    mode: 'live',
    ports: {
      db,
      files,
      downloader: createExpoDownloader(),
      hasher: createExpoHasher(files),
      secure: expoSecureKv,
      random: expoRandom,
    },
    trusted,
    api: createSupabaseSyncApi(supabase),
    households: createSupabaseHouseholdApi(supabase),
    auth,
    network: expoNetwork,
  });
}

/** An in-memory household API backed by the fake server, with a fixed sign-in code. */
function createDemoHouseholds(
  demo: DemoServer,
  state: { email: string | null; listeners: Set<(email: string | null) => void> },
): HouseholdApi {
  const set = (email: string | null) => {
    state.email = email;
    state.listeners.forEach((listener) => listener(email));
  };
  let pendingEmail: string | null = null;
  return {
    async signInWithEmail(email) {
      pendingEmail = email;
    },
    async verifyEmailCode(email, code) {
      if (code.trim() !== DEMO_CODE || pendingEmail !== email) throw new Error('Wrong code.');
      set(email);
    },
    async signOut() {
      set(null);
    },
    async createHousehold() {
      return demo.ids.household;
    },
    async createChild(child) {
      demo.api.addChild({
        id: child.id,
        household_id: child.householdId,
        display_alias: child.alias,
        avatar: child.avatar,
        level_code: child.levelCode,
        reading_mode: child.readingMode,
        daily_limit_min: null,
      });
    },
    async pinStatus() {
      return { hasPin: true, lockedUntil: null };
    },
  };
}

async function createDemoRuntime(): Promise<Runtime> {
  const db = await openExpoSqlite(':memory:');
  await migrate(db);
  const files = new MemoryFileStore();
  const demo = await createDemoServer();
  const state = {
    email: null as string | null,
    listeners: new Set<(email: string | null) => void>(),
  };
  const trusted = await TrustedClock.create(db, { now: () => Date.now() });

  return assemble({
    mode: 'demo',
    ports: {
      db,
      files,
      downloader: new FakeDownloader(files, demo.api),
      hasher: createExpoHasher(files),
      secure: new MemorySecureKv(),
      random: expoRandom,
    },
    trusted,
    api: demo.api,
    households: createDemoHouseholds(demo, state),
    auth: {
      currentEmail: async () => state.email,
      onChange(listener) {
        state.listeners.add(listener);
        return () => state.listeners.delete(listener);
      },
    },
    network: new FakeNetwork(),
    demoHint: { code: DEMO_CODE, pin: DEMO_PIN },
  });
}

/** Real Supabase when EXPO_PUBLIC_SUPABASE_URL / _KEY are set, otherwise the in-memory demo. */
export async function createRuntime(): Promise<Runtime> {
  const config = readSupabaseConfig();
  return config ? createLiveRuntime(config) : createDemoRuntime();
}
