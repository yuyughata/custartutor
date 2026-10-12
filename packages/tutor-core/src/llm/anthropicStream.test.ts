import { DEFAULT_MODELS, LlmCallError, LlmError, LlmRequestError } from '@custar/authoring-core';
import { describe, expect, it } from 'vitest';
import type { TutorLlmEvent, TutorLlmRequest } from '../contract';
import { TUTOR_TOOLS } from '../prompt/tools';
import { buildStreamParams, createAnthropicTutorLlm } from './anthropicStream';
import type {
  AnthropicStreamEventLike,
  AnthropicStreamLike,
  AnthropicStreamParams,
} from './anthropicStream';

type Script = Array<AnthropicStreamEventLike | Error>;

class RecordingClient implements AnthropicStreamLike {
  params: AnthropicStreamParams[] = [];
  options: Array<{ signal?: AbortSignal; maxRetries?: number; timeout?: number } | undefined> = [];
  aborts = 0;
  constructor(private readonly events: Script) {}
  messages = {
    stream: (
      params: AnthropicStreamParams,
      options?: { signal?: AbortSignal; maxRetries?: number; timeout?: number },
    ) => {
      this.params.push(params);
      this.options.push(options);
      const events = this.events;
      const abort = () => {
        this.aborts += 1;
      };
      return {
        abort,
        async *[Symbol.asyncIterator]() {
          for (const event of events) {
            if (event instanceof Error) throw event;
            yield event;
          }
        },
      };
    },
  };
}

const start = (
  usage = {
    input_tokens: 25,
    output_tokens: 1,
    cache_read_input_tokens: 1000,
    cache_creation_input_tokens: 0,
  },
): AnthropicStreamEventLike => ({
  type: 'message_start',
  message: { model: 'served-model-1', usage },
});
const textStart = (index = 0): AnthropicStreamEventLike => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'text', text: '' },
});
const text = (value: string, index = 0): AnthropicStreamEventLike => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'text_delta', text: value },
});
const stop = (index = 0): AnthropicStreamEventLike => ({ type: 'content_block_stop', index });
const toolStart = (index: number, name: string): AnthropicStreamEventLike => ({
  type: 'content_block_start',
  index,
  content_block: { type: 'tool_use', id: `toolu_${index}`, name },
});
const json = (index: number, partial: string): AnthropicStreamEventLike => ({
  type: 'content_block_delta',
  index,
  delta: { type: 'input_json_delta', partial_json: partial },
});
const end = (reason: string | null, output = 15): AnthropicStreamEventLike => ({
  type: 'message_delta',
  delta: { stop_reason: reason, stop_details: null },
  usage: {
    input_tokens: null,
    output_tokens: output,
    cache_read_input_tokens: null,
    cache_creation_input_tokens: null,
  },
});
const finish: AnthropicStreamEventLike = { type: 'message_stop' };

const request = (patch: Partial<TutorLlmRequest> = {}): TutorLlmRequest => ({
  label: 'tutor:turn',
  system: [{ text: 'Stable rules.', cache: true }, { text: 'Notes.' }],
  messages: [{ role: 'user', content: 'hello' }],
  tools: TUTOR_TOOLS,
  effort: 'low',
  maxTokens: 900,
  ...patch,
});

async function run(events: Script, req = request(), signal?: AbortSignal) {
  const client = new RecordingClient(events);
  const llm = createAnthropicTutorLlm({ client, models: DEFAULT_MODELS });
  const out: TutorLlmEvent[] = [];
  let error: unknown;
  try {
    for await (const event of llm.stream(signal ? { ...req, signal } : req)) out.push(event);
  } catch (caught) {
    error = caught;
  }
  return { client, out, error };
}

describe('the request', () => {
  it('uses the tutor model, adaptive thinking, explicit effort, a cached prefix and the tools, nothing forced', async () => {
    const { client } = await run([start(), end('end_turn'), finish]);
    const body = client.params[0] as AnthropicStreamParams;
    expect(body).toMatchObject({
      model: DEFAULT_MODELS.tutor,
      max_tokens: 900,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },
      system: [
        { type: 'text', text: 'Stable rules.', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'Notes.' },
      ],
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(body.system?.[1]).not.toHaveProperty('cache_control');
    expect(body.tools?.map((t) => t.name)).toEqual(['show_activity', 'record_evidence']);
    for (const tool of body.tools ?? []) expect(tool.input_schema.type).toBe('object');
    for (const key of ['tool_choice', 'temperature', 'top_p', 'top_k', 'stream'])
      expect(body).not.toHaveProperty(key);
  });

  it('keeps only the last four cache breakpoints', () => {
    const system = Array.from({ length: 6 }, (_, i) => ({ text: `block ${i}`, cache: true }));
    const body = buildStreamParams(request({ system }), 'm');
    expect(body.system?.map((b) => b.cache_control !== undefined)).toEqual([
      false,
      false,
      true,
      true,
      true,
      true,
    ]);
  });

  it('passes the signal and the retry and timeout settings to the SDK', async () => {
    const controller = new AbortController();
    const client = new RecordingClient([start(), end('end_turn'), finish]);
    const llm = createAnthropicTutorLlm({
      client,
      models: DEFAULT_MODELS,
      maxRetries: 0,
      timeoutMs: 20_000,
    });
    for await (const event of llm.stream(request({ signal: controller.signal }))) void event;
    expect(client.options[0]).toEqual({
      signal: controller.signal,
      maxRetries: 0,
      timeout: 20_000,
    });
  });

  it('refuses a request that could never work (a programmer error, not a model failure)', async () => {
    const prefill = await run(
      [],
      request({
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      }),
    );
    expect(prefill.error).toBeInstanceOf(LlmRequestError);
    const blank = await run([], request({ system: [{ text: '  ' }] }));
    expect(blank.error).toBeInstanceOf(LlmRequestError);
    const pdf = await run(
      [],
      request({ messages: [{ role: 'user', content: [{ type: 'pdf', base64: 'AAAA' }] }] }),
    );
    expect(pdf.error).toBeInstanceOf(LlmRequestError);
    expect(prefill.client.params).toHaveLength(0);
  });
});

describe('the events', () => {
  it('turns text deltas into text events and ends with done: usage, served model, stop reason', async () => {
    const { out, error } = await run([
      start(),
      textStart(),
      text('We cook '),
      text('in the kitchen.'),
      stop(),
      end('end_turn', 15),
      finish,
    ]);
    expect(error).toBeUndefined();
    expect(out).toEqual([
      { type: 'text', text: 'We cook ' },
      { type: 'text', text: 'in the kitchen.' },
      {
        type: 'done',
        usage: {
          input_tokens: 25,
          output_tokens: 15,
          cache_read_tokens: 1000,
          cache_creation_tokens: 0,
        },
        model: 'served-model-1',
        stopReason: 'end_turn',
      },
    ]);
  });

  it('ignores thinking blocks and signatures', async () => {
    const { out } = await run([
      start(),
      { type: 'content_block_start', index: 0, content_block: { type: 'thinking' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta' } },
      stop(0),
      textStart(1),
      text('Hello.', 1),
      stop(1),
      end('end_turn'),
      finish,
    ]);
    expect(out.map((e) => e.type)).toEqual(['text', 'done']);
  });

  it('assembles a tool call from split json and yields it when its block ends', async () => {
    const { out } = await run([
      start(),
      textStart(0),
      text('Try this.', 0),
      stop(0),
      toolStart(1, 'show_activity'),
      json(1, '{"question'),
      json(1, '_id": "qf_gu'),
      json(1, 'tter"}'),
      stop(1),
      toolStart(2, 'record_evidence'),
      stop(2),
      end('tool_use'),
      finish,
    ]);
    expect(out.map((e) => e.type)).toEqual(['text', 'tool', 'tool', 'done']);
    expect(out[1]).toEqual({
      type: 'tool',
      name: 'show_activity',
      input: { question_id: 'qf_gutter' },
    });
    expect(out[2]).toEqual({ type: 'tool', name: 'record_evidence', input: {} });
    expect(out[3]).toMatchObject({ stopReason: 'tool_use' });
  });

  it('drops a tool call whose json never became valid', async () => {
    const { out } = await run([
      start(),
      toolStart(0, 'show_activity'),
      json(0, '{"question_id": '),
      stop(0),
      end('end_turn'),
      finish,
    ]);
    expect(out.map((e) => e.type)).toEqual(['done']);
  });

  it('lets a reply that hit the token limit end gracefully', async () => {
    const { out, error } = await run([
      start(),
      textStart(),
      text('Half a sent'),
      stop(),
      end('max_tokens', 900),
      finish,
    ]);
    expect(error).toBeUndefined();
    expect(out.at(-1)).toMatchObject({
      type: 'done',
      stopReason: 'max_tokens',
      usage: { output_tokens: 900 },
    });
  });
});

describe('failures', () => {
  it('a refusal is an LlmError("refusal") that carries the billed usage, after any text already sent', async () => {
    const { out, error } = await run([
      start(),
      textStart(),
      text('I will'),
      {
        type: 'message_delta',
        delta: { stop_reason: 'refusal', stop_details: { category: 'general_harms' } },
        usage: { output_tokens: 4 },
      },
      finish,
    ]);
    expect(out).toEqual([{ type: 'text', text: 'I will' }]);
    expect(error).toBeInstanceOf(LlmCallError);
    expect(error).toMatchObject({
      code: 'refusal',
      retryable: false,
      model: 'served-model-1',
      stopReason: 'refusal',
    });
    expect((error as LlmCallError).usage).toMatchObject({ input_tokens: 25, output_tokens: 4 });
  });

  it('a stream that ends without a stop reason is a retryable transport error', async () => {
    const { error } = await run([start(), textStart(), text('cut')]);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ code: 'transport', retryable: true });
  });

  it('maps API errors thrown mid-stream with the shared mapper', async () => {
    const overloaded = Object.assign(new Error('overloaded'), {
      status: 529,
      headers: new Headers({ 'retry-after': '3' }),
      error: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    });
    const first = await run([start(), textStart(), text('Hi. '), overloaded]);
    expect(first.out).toEqual([{ type: 'text', text: 'Hi. ' }]);
    expect(first.error).toMatchObject({
      code: 'transport',
      retryable: true,
      status: 529,
      retryAfterMs: 3000,
    });
    const bad = await run([Object.assign(new Error('bad'), { status: 400 })]);
    expect(bad.error).toMatchObject({ code: 'transport', retryable: false, status: 400 });
    const dropped = await run([new TypeError('fetch failed')]);
    expect(dropped.error).toMatchObject({ code: 'transport', retryable: true });
  });

  it('maps an abort to "aborted", before and during the stream', async () => {
    const early = new AbortController();
    early.abort();
    const before = await run([start()], request(), early.signal);
    expect(before.error).toMatchObject({ code: 'aborted', retryable: true });
    expect(before.client.params).toHaveLength(0);

    const during = new AbortController();
    const abortError = Object.assign(new Error('aborted'), { name: 'AbortError' });
    const mid = await run([start(), abortError], request(), during.signal);
    expect(mid.error).toMatchObject({ code: 'aborted' });
  });

  it('aborts the SDK stream when the consumer stops reading', async () => {
    const client = new RecordingClient([
      start(),
      textStart(),
      text('One. '),
      text('Two. '),
      stop(),
      end('end_turn'),
      finish,
    ]);
    const llm = createAnthropicTutorLlm({ client, models: DEFAULT_MODELS });
    for await (const event of llm.stream(request())) {
      if (event.type === 'text') break;
    }
    expect(client.aborts).toBe(1);
  });
});
