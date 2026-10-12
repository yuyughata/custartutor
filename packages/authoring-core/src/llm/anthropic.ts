// The Anthropic adapter of the model port.
//
// `AnthropicLike` is the part of the SDK client this file calls, written structurally, so the same code runs
// with `npm:@anthropic-ai/sdk` in Deno edge functions and with the Node SDK, and this package imports neither.
// `anthropic.sdk-compat.test.ts` proves at compile time that the SDK's `Anthropic` is assignable to it, and
// drives the real SDK against a stubbed `fetch` so the request body and the response handling are exercised
// end to end without a network.
//
// Every request parameter below is taken from the SDK's type definitions (src/resources/messages/messages.ts
// of @anthropic-ai/sdk); the comments name the interface each one comes from. Nothing here logs: the API key
// lives in the injected client and request bodies never reach an error message.
import { LlmError } from '../contract';
import type {
  Effort,
  LlmClient,
  LlmContentPart,
  LlmMessage,
  LlmModels,
  LlmRequest,
  LlmResult,
  LlmUsage,
} from '../contract';
import { isStreamingRequiredError, toLlmTransportError } from './apiErrors';
import { LlmCallError } from './errors';
import { assertValidRequest } from './request';
import { toStructuredJsonSchema } from './structuredSchema';

// --- the structural slice of the SDK ---------------------------------------------------------------

/** `TextBlockParam` (system prompt blocks and text parts). */
export interface AnthropicTextBlockParam {
  type: 'text';
  text: string;
  /** `CacheControlEphemeral`. The default 5 minute lifetime is enough: a unit's steps run back to back. */
  cache_control?: { type: 'ephemeral' };
}

/** `DocumentBlockParam` with a `Base64PDFSource`. */
export interface AnthropicDocumentBlockParam {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
  title?: string;
}

export interface AnthropicMessageParam {
  role: 'user' | 'assistant';
  content: string | Array<AnthropicTextBlockParam | AnthropicDocumentBlockParam>;
}

/** The subset of `MessageCreateParamsNonStreaming` / `MessageStreamParams` this adapter sends. */
export interface AnthropicMessageCreateParams {
  model: string;
  max_tokens: number;
  system?: AnthropicTextBlockParam[];
  messages: AnthropicMessageParam[];
  /** `ThinkingConfigAdaptive`: the only on-mode of these models. `budget_tokens` would be a 400. */
  thinking: { type: 'adaptive' };
  /** `OutputConfig`: `effort` and `format` live inside it, not at the top level. */
  output_config: {
    effort: Effort;
    /** `JSONOutputFormat` */
    format: { type: 'json_schema'; schema: Record<string, unknown> };
  };
}

/** The parts of `Message` this adapter reads. */
export interface AnthropicMessageLike {
  model?: string;
  /** `StopReason | null` */
  stop_reason: string | null;
  /** `RefusalStopDetails | null`, set with `stop_reason: 'refusal'`. */
  stop_details?: { category?: string | null } | null;
  content: ReadonlyArray<{ type: string; text?: string }>;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens?: number | null;
    cache_creation_input_tokens?: number | null;
  };
}

/** The per-request options of the SDK (`RequestOptions`). */
export interface AnthropicRequestOptions {
  signal?: AbortSignal;
  maxRetries?: number;
  timeout?: number;
}

export interface AnthropicLike {
  messages: {
    create(
      params: AnthropicMessageCreateParams,
      options?: AnthropicRequestOptions,
    ): PromiseLike<AnthropicMessageLike>;
    /** `MessageStream`: `finalMessage()` waits for the stream to end and returns the assembled `Message`. */
    stream(
      params: AnthropicMessageCreateParams,
      options?: AnthropicRequestOptions,
    ): { finalMessage(): PromiseLike<AnthropicMessageLike> };
  };
}

// --- the adapter -----------------------------------------------------------------------------------

/**
 * The SDK throws "Streaming is required" for a non-streaming request when
 * `60 * 60 * max_tokens / 128000` seconds exceeds its 10 minute limit (`calculateNonstreamingTimeout` in
 * src/client.ts): that is any `max_tokens` above 21 333. Above it we stream.
 */
export const NONSTREAMING_MAX_TOKENS = 21_333;

/**
 * The API allows at most 4 `cache_control` breakpoints per request (prompt caching docs). A breakpoint caches
 * the whole prefix before it, so when more are requested the EARLIEST are dropped and the last four kept:
 * the longest prefix stays cacheable.
 */
export const MAX_CACHE_BREAKPOINTS = 4;

export interface AnthropicLlmOptions {
  client: AnthropicLike;
  /** The model id per task (the `ai.models` setting). */
  models: LlmModels;
  /** Milliseconds since the epoch; only used to read an HTTP-date `retry-after`. Default `Date.now`. */
  now?: () => number;
  /** Requests with a larger `maxTokens` are streamed. Default `NONSTREAMING_MAX_TOKENS`; 0 streams always. */
  streamAboveMaxTokens?: number;
  /** Passed to the SDK per request. Omit to keep the client's own default (2 for the SDK). */
  maxRetries?: number;
  /** Per-request timeout in milliseconds, passed to the SDK. Omit to keep the client's default. */
  timeoutMs?: number;
}

export function createAnthropicLlm(options: AnthropicLlmOptions): LlmClient {
  const now = options.now ?? Date.now;
  const streamAbove = options.streamAboveMaxTokens ?? NONSTREAMING_MAX_TOKENS;

  return {
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      assertValidRequest(request);
      const model = options.models[request.task];
      const params = buildParams(request, model);

      if (request.signal?.aborted) {
        throw new LlmError('aborted', 'The model call was aborted before it started', {
          retryable: true,
        });
      }
      const requestOptions: AnthropicRequestOptions = {
        ...(request.signal ? { signal: request.signal } : {}),
        ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
      };

      const stream = () => options.client.messages.stream(params, requestOptions).finalMessage();
      let message: AnthropicMessageLike;
      try {
        if (request.maxTokens > streamAbove) {
          message = await stream();
        } else {
          try {
            message = await options.client.messages.create(params, requestOptions);
          } catch (error) {
            // The SDK's threshold is derived from its own formula; if it ever moves, fall back to streaming.
            if (!isStreamingRequiredError(error)) throw error;
            message = await stream();
          }
        }
      } catch (error) {
        throw toLlmTransportError(error, { signal: request.signal, now });
      }
      return readReply(message, request, model);
    },
  };
}

/** Exported for tests: the exact request body this adapter sends. */
export function buildParams(
  request: LlmRequest<unknown>,
  model: string,
): AnthropicMessageCreateParams {
  const system = toSystemBlocks(request.system);
  return {
    model,
    max_tokens: request.maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: request.messages.map(toMessageParam),
    // Adaptive thinking with an explicit effort. No `tool_choice`, no `temperature`/`top_p`/`top_k` (rejected
    // by these models), no assistant prefill (`assertValidRequest`).
    thinking: { type: 'adaptive' },
    output_config: {
      effort: request.effort,
      format: {
        type: 'json_schema',
        schema: toStructuredJsonSchema(request.schema, request.schemaName),
      },
    },
  };
}

function toSystemBlocks(blocks: LlmRequest<unknown>['system']): AnthropicTextBlockParam[] {
  const flagged = blocks.flatMap((block, index) => (block.cache === true ? [index] : []));
  const marked = new Set(flagged.slice(-MAX_CACHE_BREAKPOINTS));
  return blocks.map((block, index) => ({
    type: 'text',
    text: block.text,
    ...(marked.has(index) ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
}

function toMessageParam(message: LlmMessage): AnthropicMessageParam {
  return {
    role: message.role,
    content: typeof message.content === 'string' ? message.content : message.content.map(toBlock),
  };
}

function toBlock(part: LlmContentPart): AnthropicTextBlockParam | AnthropicDocumentBlockParam {
  if (part.type === 'text') return { type: 'text', text: part.text };
  const source = {
    type: 'base64' as const,
    media_type: 'application/pdf' as const,
    // The API wants unbroken base64.
    data: /\s/.test(part.base64) ? part.base64.replace(/\s+/g, '') : part.base64,
  };
  return part.title === undefined
    ? { type: 'document', source }
    : { type: 'document', source, title: part.title };
}

function readReply<T>(
  message: AnthropicMessageLike,
  request: LlmRequest<T>,
  requestedModel: string,
): LlmResult<T> {
  const usage = readUsage(message.usage);
  const model =
    message.model !== undefined && message.model !== '' ? message.model : requestedModel;
  const stopReason = message.stop_reason;
  const text = message.content
    .flatMap((block) =>
      block.type === 'text' && typeof block.text === 'string' ? [block.text] : [],
    )
    .join('');
  const call = { usage, model, stopReason };

  if (stopReason === 'refusal') {
    const category = message.stop_details?.category;
    throw new LlmCallError(
      'refusal',
      `The model declined this request${category ? ` (category: ${category})` : ''}`,
      call,
      { retryable: false, raw: text },
    );
  }
  if (stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded') {
    throw new LlmCallError(
      'truncated',
      stopReason === 'max_tokens'
        ? `The reply hit the max_tokens limit (${request.maxTokens}) before it was complete`
        : 'The reply ran out of context window before it was complete',
      call,
      { retryable: false, raw: text },
    );
  }

  const schemaError = (why: string): LlmCallError =>
    new LlmCallError(
      'schema',
      `The reply for "${request.schemaName}" ${why} (stop_reason: ${stopReason ?? 'none'})`,
      call,
      { retryable: false, raw: text },
    );
  if (text.trim() === '') throw schemaError('had no text');

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw schemaError('was not valid JSON');
  }
  // The API's structured outputs constrain decoding, but the schema it was given is a softened copy (see
  // structuredSchema.ts): the Zod schema is the authority, so it always runs.
  const parsed = request.schema.safeParse(json);
  if (!parsed.success)
    throw schemaError(`did not match the schema: ${summarizeIssues(parsed.error)}`);

  return { value: parsed.data, usage, model, stopReason: stopReason ?? 'unknown' };
}

function readUsage(usage: AnthropicMessageLike['usage']): LlmUsage {
  return {
    input_tokens: count(usage.input_tokens),
    output_tokens: count(usage.output_tokens),
    cache_read_tokens: count(usage.cache_read_input_tokens),
    cache_creation_tokens: count(usage.cache_creation_input_tokens),
  };
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

/** Paths and messages only: Zod's messages describe the schema, they do not quote the reply or the prompt. */
function summarizeIssues(error: {
  issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
}): string {
  const shown = error.issues.slice(0, 5).map((issue) => {
    const path = issue.path.map(String).join('.');
    return `${path === '' ? '(root)' : path}: ${issue.message}`;
  });
  const more =
    error.issues.length > shown.length ? `; and ${error.issues.length - shown.length} more` : '';
  return `${shown.join('; ')}${more}`;
}
