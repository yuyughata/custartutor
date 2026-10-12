// A scripted test double for the model port. Platform-neutral: no Node built-ins.
//
// It is strict on purpose. A call nobody scripted throws a programmer error naming the label (it never makes up
// content), a scripted value is validated against the request's schema (a bad script fails loudly instead of
// reaching the engine as a "model" reply), and every request goes through the same checks as the real adapter
// (`assertValidRequest`, and the conversion to the structured-output JSON Schema), so a request the API would
// reject also fails here.
import { DEFAULT_MODELS, LlmError } from '../contract';
import type { LlmClient, LlmModels, LlmRequest, LlmResult, LlmUsage } from '../contract';
import { assertValidRequest } from '../llm/request';
import { toStructuredJsonSchema } from '../llm/structuredSchema';

/** An exact `label`, a pattern tested against the label, or a predicate over the whole request. */
export type FakeLlmMatcher = string | RegExp | ((request: LlmRequest<unknown>) => boolean);

/**
 * What a handler does with a call: a value (validated against the request's schema), an `Error` (thrown, so
 * pass an `LlmError` to simulate a model failure), or a function that computes either, or throws.
 */
export type FakeLlmResponse =
  | string
  | number
  | boolean
  | null
  | object
  | ((request: LlmRequest<unknown>, call: FakeLlmCall) => unknown);

export interface FakeLlmHandlerOptions {
  /** Use the handler this many times, then fall through to later handlers and the queue. Default: forever. */
  times?: number;
  /** Token counts reported for calls this handler answers (merged over the fake's defaults). */
  usage?: Partial<LlmUsage>;
  stopReason?: string;
}

export interface FakeLlmOptions {
  models?: LlmModels;
  /** Default usage reported for every successful call. */
  usage?: Partial<LlmUsage>;
  /** Run the structured-output schema conversion on every request, as the real adapter does. Default true. */
  checkSchemas?: boolean;
}

/** `rejected`: the request itself was invalid (the real adapter would never have sent it). */
export type FakeLlmOutcome = 'value' | 'error' | 'unscripted' | 'invalid_script' | 'rejected';

/** One recorded request, with what the fake did with it. */
export interface FakeLlmCall {
  readonly index: number;
  readonly label: string;
  readonly task: LlmRequest<unknown>['task'];
  readonly system: LlmRequest<unknown>['system'];
  readonly messages: LlmRequest<unknown>['messages'];
  readonly schemaName: string;
  readonly effort: LlmRequest<unknown>['effort'];
  readonly maxTokens: number;
  readonly signal: AbortSignal | undefined;
  /** The whole request, as passed. */
  readonly request: LlmRequest<unknown>;
  /** The model id for the task. */
  readonly model: string;
  /** The JSON Schema the real adapter would send (undefined when `checkSchemas` is off). */
  jsonSchema: Record<string, unknown> | undefined;
  outcome: FakeLlmOutcome | undefined;
  /** The parsed value returned, or the error thrown. */
  value: unknown;
  error: unknown;
  usage: LlmUsage | undefined;
}

/** A mistake in the test script (nothing scripted, or a scripted value that does not fit the schema). */
export class FakeLlmScriptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FakeLlmScriptError';
  }
}

const DEFAULT_USAGE: LlmUsage = {
  input_tokens: 100,
  output_tokens: 50,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

interface Handler {
  match: FakeLlmMatcher;
  respond: FakeLlmResponse;
  remaining: number;
  options: FakeLlmHandlerOptions;
}

export class FakeLlm implements LlmClient {
  private readonly recorded: FakeLlmCall[] = [];
  private handlers: Handler[] = [];
  private queue: Array<{ respond: FakeLlmResponse }> = [];
  private defaultUsage: LlmUsage;
  private readonly models: LlmModels;
  private readonly checkSchemas: boolean;
  private readonly initialUsage: LlmUsage;

  constructor(options: FakeLlmOptions = {}) {
    this.models = options.models ?? DEFAULT_MODELS;
    this.checkSchemas = options.checkSchemas ?? true;
    this.initialUsage = { ...DEFAULT_USAGE, ...options.usage };
    this.defaultUsage = this.initialUsage;
  }

  /** Every request received, in order, including the ones that failed. */
  get calls(): readonly FakeLlmCall[] {
    return this.recorded;
  }

  /**
   * Answers calls the matcher accepts. Handlers for an exact label are tried before pattern and predicate
   * handlers; within each group the first registered one with uses left wins.
   */
  on(match: FakeLlmMatcher, respond: FakeLlmResponse, options: FakeLlmHandlerOptions = {}): this {
    this.handlers.push({ match, respond, remaining: options.times ?? Infinity, options });
    return this;
  }

  /** Sugar: the n-th matching call gets the n-th response, each used once. */
  onSequence(
    match: FakeLlmMatcher,
    responses: FakeLlmResponse[],
    options: FakeLlmHandlerOptions = {},
  ): this {
    for (const response of responses) this.on(match, response, { ...options, times: 1 });
    return this;
  }

  /** Responses for calls no handler claims, consumed first in, first out. */
  enqueue(...responses: FakeLlmResponse[]): this {
    for (const respond of responses) this.queue.push({ respond });
    return this;
  }

  /** Changes the default usage reported for later calls. */
  setUsage(usage: Partial<LlmUsage>): this {
    this.defaultUsage = { ...this.defaultUsage, ...usage };
    return this;
  }

  /** The recorded calls a matcher accepts. */
  callsFor(match: FakeLlmMatcher): FakeLlmCall[] {
    return this.recorded.filter((call) => matches(match, call.request));
  }

  /** Forgets handlers, the queue, recorded calls and usage changes. */
  reset(): void {
    this.recorded.length = 0;
    this.handlers = [];
    this.queue = [];
    this.defaultUsage = this.initialUsage;
  }

  async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
    const call = this.record(request);
    try {
      return await this.answer(request, call);
    } catch (error) {
      call.error = error;
      call.outcome ??= 'error';
      throw error;
    }
  }

  private async answer<T>(request: LlmRequest<T>, call: FakeLlmCall): Promise<LlmResult<T>> {
    try {
      assertValidRequest(request);
      if (this.checkSchemas) {
        call.jsonSchema = toStructuredJsonSchema(request.schema, request.schemaName);
      }
    } catch (error) {
      call.outcome = 'rejected';
      throw error;
    }
    if (request.signal?.aborted) throw aborted();

    const handler = this.pickHandler(request);
    const queued = handler ? undefined : this.queue.shift();
    if (!handler && !queued) {
      call.outcome = 'unscripted';
      throw new FakeLlmScriptError(
        `FakeLlm has nothing scripted for "${request.label}" (task ${request.task}, schema ${request.schemaName}). ` +
          `Handlers: [${this.describeHandlers()}]; queue empty. Register one with on(label, value).`,
      );
    }
    const respond = handler ? handler.respond : (queued?.respond ?? undefined);

    const raw = await withAbort(
      Promise.resolve().then(() =>
        typeof respond === 'function'
          ? (respond as (r: LlmRequest<unknown>, c: FakeLlmCall) => unknown)(request, call)
          : respond,
      ),
      request.signal,
    );
    if (raw instanceof Error) throw raw;

    const parsed = request.schema.safeParse(raw);
    if (!parsed.success) {
      call.outcome = 'invalid_script';
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
        .join('; ');
      throw new FakeLlmScriptError(
        `The scripted response for "${request.label}" does not match schema ${request.schemaName}: ${issues}`,
      );
    }

    const usage = { ...this.defaultUsage, ...handler?.options.usage };
    call.outcome = 'value';
    call.value = parsed.data;
    call.usage = usage;
    return {
      value: parsed.data,
      usage,
      model: call.model,
      stopReason: handler?.options.stopReason ?? 'end_turn',
    };
  }

  private record(request: LlmRequest<unknown>): FakeLlmCall {
    const call: FakeLlmCall = {
      index: this.recorded.length,
      label: request.label,
      task: request.task,
      system: request.system,
      messages: request.messages,
      schemaName: request.schemaName,
      effort: request.effort,
      maxTokens: request.maxTokens,
      signal: request.signal,
      request,
      model: this.models[request.task],
      jsonSchema: undefined,
      outcome: undefined,
      value: undefined,
      error: undefined,
      usage: undefined,
    };
    this.recorded.push(call);
    return call;
  }

  private pickHandler(request: LlmRequest<unknown>): Handler | undefined {
    const live = this.handlers.filter((h) => h.remaining > 0 && matches(h.match, request));
    const chosen = live.find((h) => typeof h.match === 'string') ?? live[0];
    if (chosen) chosen.remaining -= 1;
    return chosen;
  }

  private describeHandlers(): string {
    return this.handlers
      .filter((h) => h.remaining > 0)
      .map((h) =>
        typeof h.match === 'string'
          ? h.match
          : h.match instanceof RegExp
            ? String(h.match)
            : '<predicate>',
      )
      .join(', ');
  }
}

function matches(match: FakeLlmMatcher, request: LlmRequest<unknown>): boolean {
  if (typeof match === 'string') return request.label === match;
  if (match instanceof RegExp) {
    match.lastIndex = 0;
    return match.test(request.label);
  }
  return match(request);
}

function aborted(): LlmError {
  return new LlmError('aborted', 'The model call was aborted', { retryable: true });
}

/** Rejects with the port's `aborted` error when the signal fires before the response is ready. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(aborted());
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}
