// Test support for the `ai-job` handler: an environment (fake database, job backend, clock, dependencies), JWTs,
// request helpers and a small curriculum. Not shipped.

import * as contract from '../../../packages/authoring-core/src/contract';
import { decodeJwtClaims, handleAiJob } from './ai-job-handler.ts';
import type { AiJobDeps, AuthoringCore, JobEngine } from './ai-job-types.ts';
import { FakeDb, FakeJobBackend } from './ai-job-fake-db.ts';
import type { BackendSettings, Row } from './ai-job-fake-db.ts';

export const SA = 'f9000000-0000-4000-8000-000000000001';
export const ED = 'f9000000-0000-4000-8000-000000000002';
export const RV = 'f9000000-0000-4000-8000-000000000003';
export const SUP = 'f9000000-0000-4000-8000-000000000004';
export const ED2 = 'f9000000-0000-4000-8000-000000000007';

export const IDS = {
  subject: 'b1000000-0000-4000-8000-000000000001',
  scheme: 'b2000000-0000-4000-8000-000000000001',
  scheme2: 'b2000000-0000-4000-8000-000000000002',
  chapter1: 'b3000000-0000-4000-8000-000000000001',
  chapter2: 'b3000000-0000-4000-8000-000000000002',
  theme: 'b4000000-0000-4000-8000-000000000001',
  unit: (n: number) => `b5000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  version: (n: number) => `b6000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
};

/** The authoring-core module as the handler sees it. The real contract must satisfy the structural type. */
export const core: AuthoringCore = contract;

export function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function makeJwt(claims: Record<string, unknown>): string {
  return `${base64url('{"alg":"HS256","typ":"JWT"}')}.${base64url(JSON.stringify(claims))}.signature`;
}

export interface Clock {
  t: number;
  now(): Date;
  advance(ms: number): void;
}

export function makeClock(start = Date.UTC(2026, 9, 12, 8, 0, 0)): Clock {
  const clock: Clock = {
    t: start,
    now: () => new Date(clock.t),
    advance: (ms) => {
      clock.t += ms;
    },
  };
  return clock;
}

/** One subject, one approved P1 term-1 scheme of 8 weeks, two chapters of 4 units, a theme, the cast. */
export function seedCurriculum(): Record<string, Row[]> {
  const weeks = Array.from({ length: 8 }, (_, index) => ({
    scheme_id: IDS.scheme,
    week_no: index + 1,
    kind: 'teaching',
    topic: `Topic ${index + 1}`,
    subtopics: [`Sub ${index + 1}a`, `Sub ${index + 1}b`],
  }));
  const units = Array.from({ length: 8 }, (_, index) => ({
    id: IDS.unit(index + 1),
    chapter_id: index < 4 ? IDS.chapter1 : IDS.chapter2,
    unit_no: index + 1,
    week_no: index + 1,
    kind: 'lesson',
    title: `Unit ${index + 1}`,
    objective: `Objective ${index + 1}`,
    stage: 'absorb',
    periods: 2,
    status: 'draft',
    deleted_at: null,
  }));
  return {
    admin_users: [
      { user_id: SA, role: 'super_admin' },
      { user_id: ED, role: 'content_editor' },
      { user_id: ED2, role: 'content_editor' },
      { user_id: RV, role: 'reviewer' },
      { user_id: SUP, role: 'support' },
    ],
    subjects: [{ id: IDS.subject, slug: 'basic-science', name: 'Basic Science' }],
    schemes: [
      { id: IDS.scheme, subject_id: IDS.subject, level_code: 'P1', term: 1, status: 'approved' },
      { id: IDS.scheme2, subject_id: IDS.subject, level_code: 'P1', term: 2, status: 'approved' },
    ],
    scheme_weeks: weeks,
    characters: [
      {
        slug: 'zari',
        name: 'Zari',
        active: true,
        traits: { age_years: 7, gender: 'female', pronouns: 'she/her', personality: [] },
        voice: {},
      },
      { slug: 'zuri', name: 'Zuri', active: true, traits: {}, voice: {} },
      { slug: 'retired', name: 'Retired', active: false, traits: { age_years: 99 }, voice: {} },
    ],
    themes: [{ id: IDS.theme, title: 'Market Day' }],
    theme_units: [1, 2, 3, 4].map((n) => ({
      theme_id: IDS.theme,
      unit_id: IDS.unit(n),
      lens: 'Counting',
    })),
    chapters: [
      {
        id: IDS.chapter1,
        scheme_id: IDS.scheme,
        number: 1,
        title: 'Our World',
        theme_id: IDS.theme,
      },
      { id: IDS.chapter2, scheme_id: IDS.scheme, number: 2, title: 'Our Homes', theme_id: null },
    ],
    units,
    unit_versions: [],
  };
}

export interface EnvOptions {
  engine: JobEngine;
  tables?: Record<string, Row[]>;
  settings?: Partial<BackendSettings>;
  hasKey?: boolean;
  allowedOrigins?: string[];
  /** What `createLlm` returns. */
  llm?: object;
  stepTimeoutMs?: number;
}

export interface Env {
  tables: Record<string, Row[]>;
  backend: FakeJobBackend;
  clock: Clock;
  deps: AiJobDeps;
  /** The caller's database clients created so far (one per request). */
  userDbs: FakeDb[];
  service: FakeDb;
  /** Everything handed to waitUntil. */
  pending: Promise<unknown>[];
  /** Settings the model client was built with, one per step that ran. */
  llmBuilds: unknown[];
  logs: Array<{ event: string; detail: Record<string, unknown> }>;
  uploads: Map<string, { bytes: Uint8Array; type: string }>;
  flush(): Promise<void>;
  send(body: unknown, options?: SendOptions): Promise<Response>;
  /** Creates a job and returns its row. */
  createJob(kind: string, params: Record<string, unknown>, options?: SendOptions): Promise<Row>;
}

export interface SendOptions {
  sub?: string;
  aal?: string;
  role?: string;
  origin?: string;
  method?: string;
  token?: string | null;
  exp?: number;
  rawBody?: string;
}

export function makeEnv(options: EnvOptions): Env {
  const clock = makeClock();
  const tables = options.tables ?? seedCurriculum();
  const backend = new FakeJobBackend({
    now: clock.now,
    tables,
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const service = new FakeDb({}, backend.serviceRpcs());
  const uploads = new Map<string, { bytes: Uint8Array; type: string }>();
  service.objects = uploads;
  const userDbs: FakeDb[] = [];
  const pending: Promise<unknown>[] = [];
  const llmBuilds: unknown[] = [];
  const logs: Env['logs'] = [];

  const deps: AiJobDeps = {
    core,
    engine: options.engine,
    hasAnthropicKey: () => options.hasKey ?? true,
    createLlm: (settings) => {
      llmBuilds.push(settings);
      return (
        options.llm ?? {
          generate: () => Promise.reject(new Error('the fake engine never calls the model')),
        }
      );
    },
    userDb: (req) => {
      const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
      const claims = decodeJwtClaims(token);
      const sub = claims?.sub ?? '';
      const role = (tables['admin_users'] ?? []).find((row) => row['user_id'] === sub)?.['role'];
      const db = new FakeDb(tables, backend.userRpcs(sub, role === 'super_admin'));
      db.objects = uploads;
      userDbs.push(db);
      return db;
    },
    serviceDb: () => service,
    claimsOf: decodeJwtClaims,
    waitUntil: (promise) => {
      pending.push(promise);
    },
    now: clock.now,
    uuid: () => 'req-0000',
    allowedOrigins: options.allowedOrigins ?? ['https://admin.example.com'],
    ...(options.stepTimeoutMs !== undefined ? { stepTimeoutMs: options.stepTimeoutMs } : {}),
    log: (event, detail) => {
      logs.push({ event, detail });
    },
  };

  const env: Env = {
    tables,
    backend,
    clock,
    deps,
    userDbs,
    service,
    pending,
    llmBuilds,
    logs,
    uploads,
    async flush() {
      while (pending.length > 0) await pending.shift();
    },
    send(body, sendOptions = {}) {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (sendOptions.token !== null) {
        headers['Authorization'] = `Bearer ${
          sendOptions.token ??
          makeJwt({
            sub: sendOptions.sub ?? ED,
            role: sendOptions.role ?? 'authenticated',
            aal: sendOptions.aal ?? 'aal2',
            exp: sendOptions.exp ?? Math.floor(clock.t / 1000) + 3600,
          })
        }`;
      }
      if (sendOptions.origin) headers['Origin'] = sendOptions.origin;
      const method = sendOptions.method ?? 'POST';
      const init: RequestInit = { method, headers };
      if (method !== 'GET' && method !== 'OPTIONS') {
        init.body = sendOptions.rawBody ?? JSON.stringify(body);
      }
      return handleAiJob(new Request('https://x.supabase.co/functions/v1/ai-job', init), deps);
    },
    async createJob(kind, params, sendOptions) {
      const response = await env.send({ action: 'create', kind, params }, sendOptions);
      const body = (await response.json()) as { job?: Row; error?: unknown };
      if (response.status !== 201 || !body.job)
        throw new Error(`create failed: ${JSON.stringify(body)}`);
      return body.job;
    },
  };
  return env;
}
