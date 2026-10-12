// A hand-written stand-in for the parts of supabase-js the live adapter uses. It records every call (table,
// columns, filters, RPC name and arguments, auth and storage calls) and answers from handlers the test sets.
// It is for tests only; nothing in the app imports it.
import type { SupabaseClient } from '@supabase/supabase-js';

export interface QueryFilter {
  op: 'eq' | 'in' | 'is';
  column: string;
  value: unknown;
}

export interface QuerySpec {
  table: string;
  select: string | null;
  selectOptions: Record<string, unknown> | null;
  filters: QueryFilter[];
  order: { column: string; ascending: boolean }[];
  limit: number | null;
  mode: 'many' | 'single' | 'maybeSingle';
  update: unknown;
}

export interface Reply {
  data?: unknown;
  error?: { message: string; code?: string; details?: string | null; hint?: string | null } | null;
  count?: number | null;
}

export type RpcCall = { name: string; args: Record<string, unknown> };

class FakeQuery implements PromiseLike<unknown> {
  readonly spec: QuerySpec;

  constructor(
    table: string,
    private readonly handler: (spec: QuerySpec) => Reply,
    private readonly log: (spec: QuerySpec) => void,
  ) {
    this.spec = {
      table,
      select: null,
      selectOptions: null,
      filters: [],
      order: [],
      limit: null,
      mode: 'many',
      update: undefined,
    };
  }

  select(columns?: string, options?: Record<string, unknown>): this {
    this.spec.select = columns ?? '*';
    this.spec.selectOptions = options ?? null;
    return this;
  }
  update(values: unknown): this {
    this.spec.update = values;
    return this;
  }
  eq(column: string, value: unknown): this {
    this.spec.filters.push({ op: 'eq', column, value });
    return this;
  }
  in(column: string, value: unknown[]): this {
    this.spec.filters.push({ op: 'in', column, value });
    return this;
  }
  is(column: string, value: unknown): this {
    this.spec.filters.push({ op: 'is', column, value });
    return this;
  }
  order(column: string, options?: { ascending?: boolean }): this {
    this.spec.order.push({ column, ascending: options?.ascending ?? true });
    return this;
  }
  limit(count: number): this {
    this.spec.limit = count;
    return this;
  }
  single(): this {
    this.spec.mode = 'single';
    return this;
  }
  maybeSingle(): this {
    this.spec.mode = 'maybeSingle';
    return this;
  }

  then<R1 = unknown, R2 = never>(
    onfulfilled?: ((value: unknown) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return Promise.resolve(this.run()).then(onfulfilled, onrejected);
  }

  private run(): unknown {
    this.log(structuredClone(this.spec));
    const reply = this.handler(this.spec);
    if (reply.error) return { data: null, error: reply.error, count: null };
    let data = reply.data ?? null;
    if (this.spec.mode !== 'many') {
      const rows = Array.isArray(data) ? data : data === null ? [] : [data];
      if (this.spec.mode === 'single' && rows.length !== 1) {
        return {
          data: null,
          error: {
            message: 'JSON object requested, multiple (or no) rows returned',
            code: 'PGRST116',
          },
          count: null,
        };
      }
      data = rows[0] ?? null;
    }
    return { data, error: null, count: reply.count ?? null };
  }
}

export interface FakeSession {
  access_token: string;
  user: { id: string; email?: string };
}

export interface FakeAuthSetup {
  session: FakeSession | null;
  aal: { currentLevel: 'aal1' | 'aal2' | null; nextLevel: 'aal1' | 'aal2' | null };
  factors: { id: string; factor_type: string; status: 'verified' | 'unverified' }[];
  errors: Partial<Record<string, { message: string; status?: number; code?: string }>>;
}

export class FakeSupabase {
  readonly rpcCalls: RpcCall[] = [];
  readonly queries: QuerySpec[] = [];
  readonly authCalls: { method: string; args: unknown }[] = [];
  readonly uploads: { bucket: string; path: string; body: unknown; options: unknown }[] = [];
  readonly unenrolled: string[] = [];

  private readonly rpcHandlers = new Map<string, (args: Record<string, unknown>) => Reply>();
  private readonly tableHandlers = new Map<string, (spec: QuerySpec) => Reply>();
  private authListener: ((event: string) => void) | null = null;
  uploadError: { message: string } | null = null;

  readonly authState: FakeAuthSetup = {
    session: { access_token: 'access-token-1', user: { id: 'user-1', email: 'admin@example.com' } },
    aal: { currentLevel: 'aal2', nextLevel: 'aal2' },
    factors: [],
    errors: {},
  };

  onRpc(name: string, handler: Reply | ((args: Record<string, unknown>) => Reply)): this {
    this.rpcHandlers.set(name, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  onTable(table: string, handler: Reply | ((spec: QuerySpec) => Reply)): this {
    this.tableHandlers.set(table, typeof handler === 'function' ? handler : () => handler);
    return this;
  }

  emitAuth(event: string): void {
    this.authListener?.(event);
  }

  from(table: string): FakeQuery {
    return new FakeQuery(
      table,
      (spec) => {
        const handler = this.tableHandlers.get(table);
        if (!handler) throw new Error(`FakeSupabase: no handler for table "${table}"`);
        return handler(spec);
      },
      (spec) => this.queries.push(spec),
    );
  }

  async rpc(name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    this.rpcCalls.push({ name, args: structuredClone(args) });
    const handler = this.rpcHandlers.get(name);
    if (!handler) throw new Error(`FakeSupabase: no handler for rpc "${name}"`);
    const reply = handler(args);
    return reply.error
      ? { data: null, error: reply.error }
      : { data: reply.data ?? null, error: null };
  }

  readonly storage = {
    from: (bucket: string) => ({
      upload: async (path: string, body: unknown, options: unknown) => {
        this.uploads.push({ bucket, path, body, options });
        return this.uploadError
          ? { data: null, error: this.uploadError }
          : { data: { path }, error: null };
      },
    }),
  };

  private authError(method: string): { message: string; status?: number; code?: string } | null {
    return this.authState.errors[method] ?? null;
  }

  readonly auth = {
    getSession: async () => ({ data: { session: this.authState.session }, error: null }),
    onAuthStateChange: (listener: (event: string) => void) => {
      this.authListener = listener;
      return { data: { subscription: { unsubscribe: () => undefined } } };
    },
    signInWithOtp: async (args: unknown) => {
      this.authCalls.push({ method: 'signInWithOtp', args });
      return { data: {}, error: this.authError('signInWithOtp') };
    },
    verifyOtp: async (args: unknown) => {
      this.authCalls.push({ method: 'verifyOtp', args });
      return { data: {}, error: this.authError('verifyOtp') };
    },
    signOut: async () => {
      this.authCalls.push({ method: 'signOut', args: null });
      this.authState.session = null;
      return { error: null };
    },
    mfa: {
      getAuthenticatorAssuranceLevel: async () => ({ data: this.authState.aal, error: null }),
      listFactors: async () => ({
        data: {
          all: this.authState.factors,
          totp: this.authState.factors.filter(
            (factor) => factor.factor_type === 'totp' && factor.status === 'verified',
          ),
          phone: [],
        },
        error: null,
      }),
      unenroll: async (args: { factorId: string }) => {
        this.unenrolled.push(args.factorId);
        return { data: {}, error: null };
      },
      enroll: async (args: unknown) => {
        this.authCalls.push({ method: 'mfa.enroll', args });
        return {
          data: {
            id: 'factor-new',
            totp: {
              qr_code: 'data:image/svg+xml;utf-8,<svg/>',
              secret: 'JBSWY3DPEHPK3PXP',
              uri: 'otpauth://totp/x',
            },
          },
          error: this.authError('mfa.enroll'),
        };
      },
      challengeAndVerify: async (args: unknown) => {
        this.authCalls.push({ method: 'mfa.challengeAndVerify', args });
        const error = this.authError('mfa.challengeAndVerify');
        if (!error) this.authState.aal = { currentLevel: 'aal2', nextLevel: 'aal2' };
        return { data: {}, error };
      },
    },
  };

  asClient(): SupabaseClient {
    return this as unknown as SupabaseClient;
  }
}

/** A fetch stand-in that records requests and answers from a queue of responses. */
export class FakeFetch {
  readonly requests: {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: unknown;
  }[] = [];
  private readonly queue: (Response | Error)[] = [];

  reply(status: number, body: unknown): this {
    this.queue.push(
      new Response(body === undefined ? '' : JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    return this;
  }

  fail(error: Error): this {
    this.queue.push(error);
    return this;
  }

  readonly fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    this.requests.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body,
    });
    const next = this.queue.shift();
    if (!next) throw new Error('FakeFetch: no response queued');
    if (next instanceof Error) throw next;
    return next;
  };
}
