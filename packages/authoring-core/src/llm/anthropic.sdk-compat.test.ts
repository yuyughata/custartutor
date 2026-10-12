// Proves the adapter against the REAL @anthropic-ai/sdk, without a network:
//   1. at compile time (`tsc` is the test): an `Anthropic` client is assignable to `AnthropicLike`, our request
//      type is assignable to the SDK's params, and the SDK's `Message` is assignable to what we read;
//   2. at run time: a real `Anthropic` client whose `fetch` is stubbed. That exercises the SDK's own request
//      building (it throws "Streaming is required" for large max_tokens), its SSE parser, and its error classes,
//      and lets us assert on the exact HTTP body that would be sent.
// The key below is a placeholder; the stubbed fetch never leaves the process.
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_MODELS, LlmError } from '../contract';
import type { LlmRequest } from '../contract';
import { createAnthropicLlm, NONSTREAMING_MAX_TOKENS } from './anthropic';
import type {
  AnthropicLike,
  AnthropicMessageCreateParams,
  AnthropicMessageLike,
} from './anthropic';

// --- compile time ----------------------------------------------------------------------------------

type AssertAssignable<_To, _From extends _To> = true;

export type ClientIsAssignable = AssertAssignable<AnthropicLike, Anthropic>;
export type ParamsAreAssignable = [
  AssertAssignable<Anthropic.MessageCreateParamsNonStreaming, AnthropicMessageCreateParams>,
  AssertAssignable<Anthropic.MessageStreamParams, AnthropicMessageCreateParams>,
];
export type ReplyIsAssignable = AssertAssignable<AnthropicMessageLike, Anthropic.Message>;

// A client without `messages.stream` must not be accepted.
// @ts-expect-error the structural type requires both create and stream
export const incomplete: AnthropicLike = { messages: { create: async () => ({}) } };

// --- run time --------------------------------------------------------------------------------------

const MODELS = DEFAULT_MODELS;

const Reply = z.object({ answer: z.string() });
const request = (overrides: Partial<LlmRequest<{ answer: string }>> = {}) =>
  ({
    task: 'authoring',
    label: 'sdk_compat',
    system: [{ text: 'Stable rules.', cache: true }, { text: 'Context.' }],
    messages: [{ role: 'user', content: 'Answer.' }],
    schema: Reply,
    schemaName: 'Reply',
    effort: 'medium',
    maxTokens: 2000,
    ...overrides,
  }) satisfies LlmRequest<{ answer: string }>;

interface Seen {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

type Responder = (seen: Seen, init: RequestInit) => Response | Promise<Response>;

function harness(respond: Responder) {
  const seen: Seen[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const entry: Seen = {
      url: String(input),
      method: init?.method ?? 'GET',
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    seen.push(entry);
    return respond(entry, init ?? {});
  };
  // maxRetries 0: the SDK's own retry loop would sleep; the port's caller owns retries.
  const client = new Anthropic({
    apiKey: 'placeholder-not-a-real-key',
    baseURL: 'https://api.invalid',
    fetch: fetchStub,
    maxRetries: 0,
  });
  return { client, seen, llm: createAnthropicLlm({ client, models: MODELS }) };
}

async function caught(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

const json = (body: unknown, init: ResponseInit = {}): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });

function messageBody(text: string, extra: Record<string, unknown> = {}) {
  return {
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: DEFAULT_MODELS.authoring,
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' },
      { type: 'text', text },
    ],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: {
      input_tokens: 30,
      output_tokens: 12,
      cache_creation_input_tokens: 100,
      cache_read_input_tokens: 400,
    },
    ...extra,
  };
}

function sse(events: Array<[string, unknown]>): Response {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(text, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function streamedMessage(chunks: string[]): Response {
  return sse([
    [
      'message_start',
      {
        type: 'message_start',
        message: {
          id: 'msg_stream',
          type: 'message',
          role: 'assistant',
          model: DEFAULT_MODELS.authoring,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 25,
            output_tokens: 1,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 10,
          },
        },
      },
    ],
    [
      'content_block_start',
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    ],
    ...chunks.map((text): [string, unknown] => [
      'content_block_delta',
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    ]),
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 15 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);
}

describe('against the real SDK with a stubbed fetch', () => {
  it('sends the documented body for a non-streaming call and reads the reply', async () => {
    const { llm, seen } = harness(() => json(messageBody('{"answer":"yes"}')));
    const result = await llm.generate(request());

    expect(result.value).toEqual({ answer: 'yes' });
    expect(result.usage).toEqual({
      input_tokens: 30,
      output_tokens: 12,
      cache_read_tokens: 400,
      cache_creation_tokens: 100,
    });
    expect(result.model).toBe(DEFAULT_MODELS.authoring);

    expect(seen).toHaveLength(1);
    const [call] = seen;
    expect(call?.method).toBe('POST');
    expect(call?.url).toBe('https://api.invalid/v1/messages');
    expect(call?.body).toMatchObject({
      model: DEFAULT_MODELS.authoring,
      max_tokens: 2000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'medium', format: { type: 'json_schema' } },
      system: [
        { type: 'text', text: 'Stable rules.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Context.' },
      ],
      messages: [{ role: 'user', content: 'Answer.' }],
    });
    expect(call?.body).not.toHaveProperty('stream');
    expect(call?.body).not.toHaveProperty('tool_choice');
    expect(call?.body).not.toHaveProperty('temperature');
  });

  it('sends a pdf as a base64 document block', async () => {
    const { llm, seen } = harness(() => json(messageBody('{"answer":"ok"}')));
    await llm.generate(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'pdf', base64: 'JVBERi0=', title: 'scheme.pdf' },
              { type: 'text', text: 'Read it.' },
            ],
          },
        ],
      }),
    );
    expect(seen[0]?.body['messages']).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0=' },
            title: 'scheme.pdf',
          },
          { type: 'text', text: 'Read it.' },
        ],
      },
    ]);
  });

  it('streams above the threshold and assembles the reply from server-sent events', async () => {
    const { llm, seen } = harness(() => streamedMessage(['{"ans', 'wer":"stre', 'amed"}']));
    const result = await llm.generate(request({ maxTokens: 64_000 }));

    expect(seen[0]?.body).toMatchObject({ stream: true, max_tokens: 64_000 });
    expect(result.value).toEqual({ answer: 'streamed' });
    expect(result.usage).toMatchObject({
      input_tokens: 25,
      output_tokens: 15,
      cache_read_tokens: 10,
    });
    expect(result.stopReason).toBe('end_turn');
  });

  it('agrees with the SDK about where streaming becomes mandatory', async () => {
    const { client } = harness(() => json(messageBody('{"answer":"x"}')));
    const base = {
      model: DEFAULT_MODELS.authoring,
      messages: [{ role: 'user' as const, content: 'hi' }],
    };
    await expect(
      client.messages.create({ ...base, max_tokens: NONSTREAMING_MAX_TOKENS }),
    ).resolves.toBeDefined();
    // The SDK throws synchronously, before it returns a promise.
    expect(() =>
      client.messages.create({ ...base, max_tokens: NONSTREAMING_MAX_TOKENS + 1 }),
    ).toThrow(/Streaming is required/);
  });

  it('falls back to streaming if the SDK refuses a non-streaming request the adapter allowed', async () => {
    const { client, seen } = harness(() => streamedMessage(['{"answer":"fell back"}']));
    const llm = createAnthropicLlm({ client, models: MODELS, streamAboveMaxTokens: 1_000_000 });
    const result = await llm.generate(request({ maxTokens: 30_000 }));
    expect(result.value.answer).toBe('fell back');
    // The refused attempt never reached the network; only the streamed request did.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.body['stream']).toBe(true);
  });

  it('maps the SDK error classes: 429 with retry-after, overloaded, and a bad request', async () => {
    const errorBody = (type: string, message: string) => ({
      type: 'error',
      error: { type, message },
    });

    const limited = harness(() =>
      json(errorBody('rate_limit_error', 'slow down'), {
        status: 429,
        headers: { 'retry-after': '4', 'content-type': 'application/json' },
      }),
    );
    const rateLimited = await caught(limited.llm.generate(request()));
    expect(rateLimited).toMatchObject({
      code: 'transport',
      retryable: true,
      status: 429,
      retryAfterMs: 4000,
    });

    const busy = harness(() => json(errorBody('overloaded_error', 'busy'), { status: 529 }));
    expect(await caught(busy.llm.generate(request()))).toMatchObject({
      retryable: true,
      status: 529,
    });

    const bad = harness(() => json(errorBody('invalid_request_error', 'nope'), { status: 400 }));
    const rejected = await caught(bad.llm.generate(request()));
    expect(rejected).toMatchObject({ code: 'transport', retryable: false, status: 400 });
    expect(rejected.message).toContain('invalid_request_error');
  });

  it('maps a connection failure to a retryable transport error', async () => {
    const { llm } = harness(() => {
      throw new TypeError('fetch failed');
    });
    const error = await caught(llm.generate(request()));
    expect(error).toMatchObject({ code: 'transport', retryable: true });
    expect(error.status).toBeUndefined();
  });

  it('maps an abort to aborted, before and during the request', async () => {
    const before = harness(() => json(messageBody('{"answer":"x"}')));
    const early = new AbortController();
    early.abort();
    expect(await caught(before.llm.generate(request({ signal: early.signal })))).toMatchObject({
      code: 'aborted',
      retryable: true,
    });
    expect(before.seen).toHaveLength(0);

    const during = new AbortController();
    const slow = harness(
      (_seen, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () =>
            reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
          );
          queueMicrotask(() => during.abort());
        }),
    );
    expect(await caught(slow.llm.generate(request({ signal: during.signal })))).toMatchObject({
      code: 'aborted',
      retryable: true,
    });
  });

  it('maps a refusal and a truncation from real response bodies', async () => {
    const refusal = harness(() =>
      json(
        messageBody('', {
          content: [],
          stop_reason: 'refusal',
          stop_details: { type: 'refusal', category: 'general_harms', explanation: null },
        }),
      ),
    );
    expect(await caught(refusal.llm.generate(request()))).toMatchObject({
      code: 'refusal',
      retryable: false,
    });

    const truncated = harness(() =>
      json(messageBody('{"answer":"cu', { stop_reason: 'max_tokens' })),
    );
    expect(await caught(truncated.llm.generate(request()))).toMatchObject({
      code: 'truncated',
      retryable: false,
      raw: '{"answer":"cu',
    });
  });
});
