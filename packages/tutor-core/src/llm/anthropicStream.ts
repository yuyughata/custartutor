// The streaming adapter of the tutor: TutorLlm on top of the SDK's `messages.stream`.
//
// NOT YET RUN AGAINST THE LIVE API. It is tested against hand-written event sequences and against the real SDK
// with a stubbed `fetch` (anthropicStream.sdk-compat.test.ts), never against the service.
//
// `AnthropicStreamLike` is the slice of the SDK client this file calls, written structurally so the same code runs
// with `npm:@anthropic-ai/sdk` in Deno and with the Node SDK, and this package imports neither. The compat test
// proves at compile time that the SDK's client and event types are assignable to it. Every request field and
// event below is taken from the SDK's type definitions (resources/messages/messages.d.ts); the comments name the
// interface each one comes from.
import { LlmCallError, LlmError, LlmRequestError, toLlmTransportError } from '@custar/authoring-core';
import type { Effort, LlmModels, LlmUsage } from '@custar/authoring-core';
import type { TutorLlm, TutorLlmEvent, TutorLlmRequest } from '../contract';

/** `TextBlockParam`. `cache_control` is `CacheControlEphemeral`. */
export interface AnthropicTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** `Tool` (a custom client tool). `input_schema` is JSON Schema with an object root. */
export interface AnthropicToolParam {
  name: string;
  description?: string;
  input_schema: { type: 'object'; [key: string]: unknown };
}

/** The subset of `MessageStreamParams` this adapter sends. No `tool_choice`, no prefill, no sampling knobs. */
export interface AnthropicStreamParams {
  model: string;
  max_tokens: number;
  system?: AnthropicTextBlock[];
  messages: Array<{ role: 'user' | 'assistant'; content: string | AnthropicTextBlock[] }>;
  tools?: AnthropicToolParam[];
  /** `ThinkingConfigAdaptive`. */
  thinking: { type: 'adaptive' };
  /** `OutputConfig.effort`. */
  output_config: { effort: Effort };
}

interface UsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
}

/** `RawMessageStreamEvent`, as far as it is read here. */
export type AnthropicStreamEventLike =
  | { type: 'message_start'; message: { model?: string; usage: UsageLike } }
  | { type: 'content_block_start'; index: number; content_block: { type: string; id?: string; name?: string; text?: string } }
  | { type: 'content_block_delta'; index: number; delta: { type: string; text?: string; partial_json?: string } }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta';
      delta: { stop_reason: string | null; stop_details?: { category?: string | null } | null };
      usage: UsageLike;
    }
  | { type: 'message_stop' };

/** `MessageStream`: iterating it yields the raw events; `abort()` stops the request. */
export interface AnthropicMessageStreamLike extends AsyncIterable<AnthropicStreamEventLike> {
  abort?(): void;
}

export interface AnthropicStreamLike {
  messages: {
    stream(
      params: AnthropicStreamParams,
      options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number },
    ): AnthropicMessageStreamLike;
  };
}

export interface AnthropicTutorLlmOptions {
  client: AnthropicStreamLike;
  /** The model id per task (the `ai.models` setting); `tutor` is used. */
  models: LlmModels;
  /** Milliseconds since the epoch; only used to read an HTTP-date `retry-after`. Default `Date.now`. */
  now?: () => number;
  maxRetries?: number;
  timeoutMs?: number;
}

/** The API allows at most 4 cache breakpoints; the LAST ones are kept (the longest prefix stays cached). */
const MAX_CACHE_BREAKPOINTS = 4;

export function assertValidTutorRequest(request: TutorLlmRequest): void {
  const where = `Tutor request "${request.label}"`;
  if (request.label.trim() === '') throw new LlmRequestError('Tutor request has no label');
  if (!Number.isInteger(request.maxTokens) || request.maxTokens < 1) {
    throw new LlmRequestError(`${where}: maxTokens must be a positive integer`);
  }
  request.system.forEach((block, index) => {
    if (block.text.trim() === '') throw new LlmRequestError(`${where}: system block ${index} has no text`);
  });
  const first = request.messages[0];
  const last = request.messages[request.messages.length - 1];
  if (first === undefined || last === undefined) throw new LlmRequestError(`${where}: messages must not be empty`);
  if (first.role !== 'user') throw new LlmRequestError(`${where}: the first message must have role "user"`);
  if (last.role !== 'user') {
    throw new LlmRequestError(`${where}: the last message must have role "user" (assistant prefill is not supported)`);
  }
}

/** Exported for tests: the exact request this adapter sends. */
export function buildStreamParams(request: TutorLlmRequest, model: string): AnthropicStreamParams {
  assertValidTutorRequest(request);
  const marked = new Set(
    request.system.flatMap((block, index) => (block.cache === true ? [index] : [])).slice(-MAX_CACHE_BREAKPOINTS),
  );
  const system: AnthropicTextBlock[] = request.system.map((block, index) => ({
    type: 'text',
    text: block.text,
    ...(marked.has(index) ? { cache_control: { type: 'ephemeral' as const } } : {}),
  }));
  return {
    model,
    max_tokens: request.maxTokens,
    ...(system.length > 0 ? { system } : {}),
    messages: request.messages.map((message) => ({
      role: message.role,
      content:
        typeof message.content === 'string'
          ? message.content
          : message.content.map((part): AnthropicTextBlock => {
              if (part.type !== 'text') throw new LlmRequestError('The tutor sends text only');
              return { type: 'text', text: part.text };
            }),
    })),
    ...(request.tools.length > 0
      ? {
          tools: request.tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            input_schema: { ...tool.schema, type: 'object' as const },
          })),
        }
      : {}),
    // Adaptive thinking with an explicit effort. No `tool_choice` (the model decides), no temperature/top_p/top_k
    // (rejected by these models), no assistant prefill (assertValidTutorRequest).
    thinking: { type: 'adaptive' },
    output_config: { effort: request.effort },
  };
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

function parseToolInput(json: string): { ok: true; value: unknown } | { ok: false } {
  if (json.trim() === '') return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(json) as unknown };
  } catch {
    return { ok: false };
  }
}

export function createAnthropicTutorLlm(options: AnthropicTutorLlmOptions): TutorLlm {
  const now = options.now ?? Date.now;
  return {
    async *stream(request: TutorLlmRequest): AsyncGenerator<TutorLlmEvent> {
      const model = options.models.tutor;
      const params = buildStreamParams(request, model);
      if (request.signal?.aborted) {
        throw new LlmError('aborted', 'The model call was aborted before it started', { retryable: true });
      }
      let stream: AnthropicMessageStreamLike | undefined;
      let finished = false;
      try {
        stream = options.client.messages.stream(params, {
          ...(request.signal ? { signal: request.signal } : {}),
          ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
          ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        });

        let servedModel = model;
        const usage: LlmUsage = { input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 };
        const merge = (u: UsageLike): void => {
          if (typeof u.input_tokens === 'number') usage.input_tokens = count(u.input_tokens);
          if (typeof u.output_tokens === 'number') usage.output_tokens = count(u.output_tokens);
          if (typeof u.cache_read_input_tokens === 'number') usage.cache_read_tokens = count(u.cache_read_input_tokens);
          if (typeof u.cache_creation_input_tokens === 'number') {
            usage.cache_creation_tokens = count(u.cache_creation_input_tokens);
          }
        };
        const tools = new Map<number, { name: string; json: string }>();
        let stopReason: string | null = null;
        let refusalCategory: string | null | undefined;

        for await (const event of stream) {
          switch (event.type) {
            case 'message_start':
              if (event.message.model) servedModel = event.message.model;
              merge(event.message.usage);
              break;
            case 'content_block_start': {
              const block = event.content_block;
              if (block.type === 'tool_use' && typeof block.name === 'string') {
                tools.set(event.index, { name: block.name, json: '' });
              } else if (block.type === 'text' && typeof block.text === 'string' && block.text !== '') {
                yield { type: 'text', text: block.text };
              }
              break;
            }
            case 'content_block_delta': {
              const delta = event.delta;
              if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text !== '') {
                yield { type: 'text', text: delta.text };
              } else if (delta.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                const tool = tools.get(event.index);
                if (tool) tool.json += delta.partial_json;
              }
              // thinking_delta, signature_delta and citations_delta carry nothing the child may see
              break;
            }
            case 'content_block_stop': {
              const tool = tools.get(event.index);
              if (tool) {
                tools.delete(event.index);
                const parsed = parseToolInput(tool.json);
                if (parsed.ok) yield { type: 'tool', name: tool.name, input: parsed.value };
              }
              break;
            }
            case 'message_delta':
              stopReason = event.delta.stop_reason ?? stopReason;
              refusalCategory = event.delta.stop_details?.category ?? refusalCategory;
              merge(event.usage);
              break;
            case 'message_stop':
              break;
          }
        }

        if (stopReason === null) {
          throw new LlmError('transport', 'The model stream ended before the reply was complete', { retryable: true });
        }
        if (stopReason === 'refusal') {
          throw new LlmCallError(
            'refusal',
            `The model declined this request${refusalCategory ? ` (category: ${refusalCategory})` : ''}`,
            { usage, model: servedModel, stopReason },
            { retryable: false },
          );
        }
        finished = true;
        // 'max_tokens' ends the reply here; the pipeline cuts it at a sentence
        yield { type: 'done', usage, model: servedModel, stopReason };
      } catch (error) {
        finished = true;
        throw toLlmTransportError(error, { signal: request.signal, now });
      } finally {
        if (!finished) stream?.abort?.();
      }
    },
  };
}
