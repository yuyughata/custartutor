// Proves the streaming adapter against the REAL @anthropic-ai/sdk, without a network:
//   1. at compile time (`tsc` is the test): an `Anthropic` client is assignable to `AnthropicStreamLike`, our request
//      type is assignable to the SDK's stream params, and the SDK's raw stream events are assignable to what we read;
//   2. at run time: a real `Anthropic` client whose `fetch` is stubbed with a server-sent-event body. That exercises
//      the SDK's own request building, its SSE parser and its error classes, and lets us assert on the exact HTTP
//      body that would be sent.
// The key below is a placeholder; the stubbed fetch never leaves the process. This is NOT a live run.
import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_MODELS, LlmError } from '@custar/authoring-core';
import { describe, expect, it } from 'vitest';
import type { TutorLlmEvent, TutorLlmRequest } from '../contract';
import { TUTOR_TOOLS } from '../prompt/tools';
import { createAnthropicTutorLlm } from './anthropicStream';
import type {
  AnthropicStreamEventLike,
  AnthropicStreamLike,
  AnthropicStreamParams,
} from './anthropicStream';

// --- compile time ----------------------------------------------------------------------------------

type AssertAssignable<_To, _From extends _To> = true;

export type ClientIsAssignable = AssertAssignable<AnthropicStreamLike, Anthropic>;
export type ParamsAreAssignable = AssertAssignable<
  Anthropic.MessageStreamParams,
  AnthropicStreamParams
>;
export type EventsAreAssignable = AssertAssignable<
  AnthropicStreamEventLike,
  Anthropic.RawMessageStreamEvent
>;

// A client without `messages.stream` must not be accepted.
// @ts-expect-error the structural type requires stream
export const incomplete: AnthropicStreamLike = { messages: { create: async () => ({}) } };

// --- run time --------------------------------------------------------------------------------------

interface Seen {
  url: string;
  body: Record<string, unknown>;
}

function sse(events: Array<[string, unknown]>, status = 200): Response {
  const text = events
    .map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
    .join('');
  return new Response(text, { status, headers: { 'content-type': 'text/event-stream' } });
}

function harness(respond: (seen: Seen) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const fetchStub = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const entry: Seen = {
      url: String(input),
      body: JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>,
    };
    seen.push(entry);
    return respond(entry);
  };
  const client = new Anthropic({
    apiKey: 'placeholder-not-a-real-key',
    baseURL: 'https://api.invalid',
    fetch: fetchStub,
    maxRetries: 0,
  });
  return { seen, llm: createAnthropicTutorLlm({ client, models: DEFAULT_MODELS, maxRetries: 0 }) };
}

const request: TutorLlmRequest = {
  label: 'tutor:turn',
  system: [{ text: 'Stable rules.', cache: true }, { text: 'Notes.' }],
  messages: [{ role: 'user', content: 'where do we cook' }],
  tools: TUTOR_TOOLS,
  effort: 'low',
  maxTokens: 900,
};

const message = (extra: Record<string, unknown> = {}) => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: DEFAULT_MODELS.tutor,
  content: [],
  stop_reason: null,
  stop_sequence: null,
  usage: {
    input_tokens: 30,
    output_tokens: 1,
    cache_read_input_tokens: 400,
    cache_creation_input_tokens: 0,
  },
  ...extra,
});

const reply = (blocks: Array<[string, unknown]>, stopReason = 'end_turn') =>
  sse([
    ['message_start', { type: 'message_start', message: message() }],
    ...blocks,
    [
      'message_delta',
      {
        type: 'message_delta',
        delta: { stop_reason: stopReason, stop_sequence: null },
        usage: { output_tokens: 22 },
      },
    ],
    ['message_stop', { type: 'message_stop' }],
  ]);

const textBlock = (index: number, pieces: string[]): Array<[string, unknown]> => [
  [
    'content_block_start',
    { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
  ],
  ...pieces.map((text): [string, unknown] => [
    'content_block_delta',
    { type: 'content_block_delta', index, delta: { type: 'text_delta', text } },
  ]),
  ['content_block_stop', { type: 'content_block_stop', index }],
];

async function collect(iterable: AsyncIterable<TutorLlmEvent>): Promise<TutorLlmEvent[]> {
  const out: TutorLlmEvent[] = [];
  for await (const event of iterable) out.push(event);
  return out;
}

describe('against the real SDK with a stubbed fetch', () => {
  it('sends the documented body and streams the reply, usage and model back', async () => {
    const { llm, seen } = harness(() => reply(textBlock(0, ['We cook ', 'in the kitchen.'])));
    const events = await collect(llm.stream(request));
    expect(events).toEqual([
      { type: 'text', text: 'We cook ' },
      { type: 'text', text: 'in the kitchen.' },
      {
        type: 'done',
        usage: {
          input_tokens: 30,
          output_tokens: 22,
          cache_read_tokens: 400,
          cache_creation_tokens: 0,
        },
        model: DEFAULT_MODELS.tutor,
        stopReason: 'end_turn',
      },
    ]);
    expect(seen[0]?.url).toBe('https://api.invalid/v1/messages');
    expect(seen[0]?.body).toMatchObject({
      model: DEFAULT_MODELS.tutor,
      max_tokens: 900,
      stream: true,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: 'Stable rules.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Notes.' },
      ],
      messages: [{ role: 'user', content: 'where do we cook' }],
    });
    expect(seen[0]?.body).not.toHaveProperty('tool_choice');
    expect((seen[0]?.body['tools'] as Array<{ name: string }>).map((t) => t.name)).toEqual([
      'show_activity',
      'record_evidence',
    ]);
  });

  it('reads a tool call out of the real SDK event stream', async () => {
    const tool: Array<[string, unknown]> = [
      [
        'content_block_start',
        {
          type: 'content_block_start',
          index: 1,
          content_block: { type: 'tool_use', id: 'toolu_1', name: 'show_activity', input: {} },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '{"question_id":' },
        },
      ],
      [
        'content_block_delta',
        {
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'input_json_delta', partial_json: '"qf_gutter"}' },
        },
      ],
      ['content_block_stop', { type: 'content_block_stop', index: 1 }],
    ];
    const { llm } = harness(() => reply([...textBlock(0, ['Try this.']), ...tool], 'tool_use'));
    const events = await collect(llm.stream(request));
    expect(events.map((e) => e.type)).toEqual(['text', 'tool', 'done']);
    expect(events[1]).toEqual({
      type: 'tool',
      name: 'show_activity',
      input: { question_id: 'qf_gutter' },
    });
  });

  it('maps a refusal that arrives as a stop reason', async () => {
    const { llm } = harness(() => reply(textBlock(0, ['I']), 'refusal'));
    const events: TutorLlmEvent[] = [];
    let error: unknown;
    try {
      for await (const event of llm.stream(request)) events.push(event);
    } catch (caught) {
      error = caught;
    }
    expect(events).toEqual([{ type: 'text', text: 'I' }]);
    expect(error).toMatchObject({ code: 'refusal', retryable: false });
  });

  it('maps the SDK error classes: overloaded and a bad request', async () => {
    const body = (type: string) => JSON.stringify({ type: 'error', error: { type, message: 'x' } });
    const busy = harness(
      () =>
        new Response(body('overloaded_error'), {
          status: 529,
          headers: { 'content-type': 'application/json', 'retry-after': '2' },
        }),
    );
    await expect(collect(busy.llm.stream(request))).rejects.toMatchObject({
      code: 'transport',
      retryable: true,
      status: 529,
      retryAfterMs: 2000,
    });
    const bad = harness(
      () =>
        new Response(body('invalid_request_error'), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
    );
    await expect(collect(bad.llm.stream(request))).rejects.toMatchObject({
      code: 'transport',
      retryable: false,
      status: 400,
    });
  });

  it('maps a connection failure and an abort', async () => {
    const down = harness(() => {
      throw new TypeError('fetch failed');
    });
    await expect(collect(down.llm.stream(request))).rejects.toBeInstanceOf(LlmError);

    const controller = new AbortController();
    const slow = harness(() => new Promise<Response>(() => undefined));
    const pending = collect(slow.llm.stream({ ...request, signal: controller.signal }));
    queueMicrotask(() => controller.abort());
    await expect(pending).rejects.toMatchObject({ code: 'aborted', retryable: true });
  });
});
