import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { EFFORTS, LlmError } from '../contract';
import type { LlmRequest } from '../contract';
import { createAnthropicLlm, MAX_CACHE_BREAKPOINTS, NONSTREAMING_MAX_TOKENS } from './anthropic';
import type {
  AnthropicLike,
  AnthropicMessageCreateParams,
  AnthropicMessageLike,
  AnthropicRequestOptions,
} from './anthropic';
import { LlmCallError, LlmRequestError, usageOfError } from './errors';

const MODELS = {
  authoring: 'model-authoring',
  tutor: 'model-tutor',
  moderation: 'model-moderation',
};
const PROMPT_MARKER = 'PROMPT-MARKER-do-not-echo';

const Reply = z.object({ answer: z.string(), count: z.number().int().default(1) });
type Reply = z.output<typeof Reply>;

function request(overrides: Partial<LlmRequest<Reply>> = {}): LlmRequest<Reply> {
  return {
    task: 'authoring',
    label: 'unit_generate:test',
    system: [{ text: 'You draft lessons.', cache: true }, { text: 'Unit context.' }],
    messages: [{ role: 'user', content: `Write the answer. ${PROMPT_MARKER}` }],
    schema: Reply,
    schemaName: 'Reply',
    effort: 'high',
    maxTokens: 4096,
    ...overrides,
  };
}

function message(text: string, extra: Partial<AnthropicMessageLike> = {}): AnthropicMessageLike {
  return {
    model: 'served-model',
    stop_reason: 'end_turn',
    content: [{ type: 'thinking' }, { type: 'text', text }],
    usage: {
      input_tokens: 120,
      output_tokens: 45,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    },
    ...extra,
  };
}

const GOOD = message(JSON.stringify({ answer: 'four' }));

interface RecordedCall {
  via: 'create' | 'stream';
  params: AnthropicMessageCreateParams;
  options: AnthropicRequestOptions | undefined;
}

type Reaction =
  | AnthropicMessageLike
  | Error
  | ((call: RecordedCall) => AnthropicMessageLike | Promise<AnthropicMessageLike>);

class RecordingClient implements AnthropicLike {
  readonly calls: RecordedCall[] = [];
  readonly messages: AnthropicLike['messages'];

  constructor(private reaction: Reaction = GOOD) {
    const respond = async (call: RecordedCall): Promise<AnthropicMessageLike> => {
      this.calls.push(call);
      const reaction = this.reaction;
      if (reaction instanceof Error) throw reaction;
      return typeof reaction === 'function' ? reaction(call) : reaction;
    };
    this.messages = {
      create: (params, options) => respond({ via: 'create', params, options }),
      stream: (params, options) => ({
        finalMessage: () => respond({ via: 'stream', params, options }),
      }),
    };
  }

  get last(): RecordedCall {
    const call = this.calls[this.calls.length - 1];
    if (!call) throw new Error('no call was made');
    return call;
  }
}

function llm(client: AnthropicLike, extra: Partial<Parameters<typeof createAnthropicLlm>[0]> = {}) {
  return createAnthropicLlm({ client, models: MODELS, now: () => 1_000_000, ...extra });
}

async function caught(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

async function failure(promise: Promise<unknown>): Promise<LlmError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof LlmError) return error;
    throw error;
  }
  throw new Error('expected the call to fail');
}

function apiError(
  status: number,
  init: { headers?: Record<string, string>; type?: string; message?: string } = {},
): Error {
  return Object.assign(new Error(`${status} ${init.message ?? 'boom'}`), {
    status,
    headers: new Headers(init.headers ?? {}),
    error: {
      type: 'error',
      error: { type: init.type ?? 'api_error', message: init.message ?? 'boom' },
    },
    requestID: 'req_123',
  });
}

describe('the request body', () => {
  it('sends model, adaptive thinking, explicit effort and the JSON schema, and nothing forbidden', async () => {
    const client = new RecordingClient();
    await llm(client).generate(request());

    const { params, via } = client.last;
    expect(via).toBe('create');
    expect(params.model).toBe('model-authoring');
    expect(params.max_tokens).toBe(4096);
    expect(params.thinking).toEqual({ type: 'adaptive' });
    expect(params.output_config.effort).toBe('high');
    expect(params.output_config.format.type).toBe('json_schema');
    expect(params.output_config.format.schema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      required: ['answer'],
    });
    expect(params.messages).toEqual([
      { role: 'user', content: `Write the answer. ${PROMPT_MARKER}` },
    ]);
    // Rejected by these models, or deliberately unused.
    for (const key of ['tool_choice', 'tools', 'temperature', 'top_p', 'top_k', 'stream']) {
      expect(params).not.toHaveProperty(key);
    }
  });

  it.each(EFFORTS)('passes effort %s through', async (effort) => {
    const client = new RecordingClient();
    await llm(client).generate(request({ effort }));
    expect(client.last.params.output_config.effort).toBe(effort);
  });

  it('resolves the model from the task', async () => {
    const client = new RecordingClient();
    await llm(client).generate(request({ task: 'moderation' }));
    expect(client.last.params.model).toBe('model-moderation');
    await llm(client).generate(request({ task: 'tutor' }));
    expect(client.last.params.model).toBe('model-tutor');
  });

  it('omits the system parameter when there are no system blocks', async () => {
    const client = new RecordingClient();
    await llm(client).generate(request({ system: [] }));
    expect(client.last.params).not.toHaveProperty('system');
  });

  it('turns pdf parts into base64 document blocks, in order, and strips line breaks', async () => {
    const client = new RecordingClient();
    await llm(client).generate(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'pdf', base64: 'QUJD\nREVG\r\n', title: 'scheme.pdf' },
              { type: 'pdf', base64: 'R0hJ' },
              { type: 'text', text: 'Extract the scheme.' },
            ],
          },
        ],
      }),
    );
    expect(client.last.params.messages[0]?.content).toEqual([
      {
        type: 'document',
        source: { type: 'base64', media_type: 'application/pdf', data: 'QUJDREVG' },
        title: 'scheme.pdf',
      },
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'R0hJ' } },
      { type: 'text', text: 'Extract the scheme.' },
    ]);
  });

  it('keeps earlier turns and consecutive roles as given', async () => {
    const client = new RecordingClient();
    await llm(client).generate(
      request({
        messages: [
          { role: 'user', content: 'one' },
          { role: 'assistant', content: 'two' },
          { role: 'user', content: 'three' },
        ],
      }),
    );
    expect(client.last.params.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('prompt caching', () => {
  it('turns cache:true system blocks into ephemeral breakpoints and leaves the others unmarked', async () => {
    const client = new RecordingClient();
    await llm(client).generate(
      request({
        system: [
          { text: 'stable prefix', cache: true },
          { text: 'also stable', cache: false },
          { text: 'per-step context' },
        ],
      }),
    );
    expect(client.last.params.system).toEqual([
      { type: 'text', text: 'stable prefix', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'also stable' },
      { type: 'text', text: 'per-step context' },
    ]);
  });

  it(`marks at most ${MAX_CACHE_BREAKPOINTS} breakpoints, keeping the last ones`, async () => {
    const client = new RecordingClient();
    const system = Array.from({ length: 6 }, (_, index) => ({
      text: `block ${index}`,
      cache: true,
    }));
    await llm(client).generate(request({ system }));
    const marked = (client.last.params.system ?? []).map(
      (block) => block.cache_control !== undefined,
    );
    expect(marked).toEqual([false, false, true, true, true, true]);
  });
});

describe('request validation (programmer errors)', () => {
  it.each([
    [
      'a trailing assistant message (prefill)',
      {
        messages: [
          { role: 'user', content: 'a' },
          { role: 'assistant', content: 'b' },
        ],
      },
    ],
    ['no messages', { messages: [] }],
    [
      'a leading assistant message',
      {
        messages: [
          { role: 'assistant', content: 'a' },
          { role: 'user', content: 'b' },
        ],
      },
    ],
    ['a blank message', { messages: [{ role: 'user', content: '   ' }] }],
    ['an empty content array', { messages: [{ role: 'user', content: [] }] }],
    ['a blank text part', { messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] }],
    ['an empty pdf', { messages: [{ role: 'user', content: [{ type: 'pdf', base64: '' }] }] }],
    ['a blank system block', { system: [{ text: ' ' }] }],
    ['zero max tokens', { maxTokens: 0 }],
    ['a blank label', { label: ' ' }],
  ] as Array<[string, Partial<LlmRequest<Reply>>]>)(
    'rejects %s without calling the API',
    async (_name, overrides) => {
      const client = new RecordingClient();
      const call = llm(client).generate(request(overrides));
      await expect(call).rejects.toBeInstanceOf(LlmRequestError);
      await expect(call).rejects.not.toBeInstanceOf(LlmError);
      expect(client.calls).toHaveLength(0);
    },
  );

  it('names the label but never the prompt text', async () => {
    const client = new RecordingClient();
    const error = await caught(
      llm(client).generate(
        request({
          label: 'unit_generate:prefill',
          messages: [
            { role: 'user', content: PROMPT_MARKER },
            { role: 'assistant', content: PROMPT_MARKER },
          ],
        }),
      ),
    );
    expect(error.message).toContain('unit_generate:prefill');
    expect(error.message).not.toContain(PROMPT_MARKER);
  });

  it('rejects a schema structured outputs cannot express, before any call', async () => {
    const client = new RecordingClient();
    const loose = z.object({ bag: z.record(z.string(), z.string()) });
    const call = llm(client).generate({
      ...request(),
      schema: loose,
      schemaName: 'Loose',
    } as never);
    await expect(call).rejects.toBeInstanceOf(LlmRequestError);
    await expect(call).rejects.toThrow(/Loose.*bag/);
    expect(client.calls).toHaveLength(0);
  });
});

describe('streaming', () => {
  it('does not stream up to the SDK limit and streams above it', async () => {
    const client = new RecordingClient();
    await llm(client).generate(request({ maxTokens: NONSTREAMING_MAX_TOKENS }));
    expect(client.last.via).toBe('create');
    await llm(client).generate(request({ maxTokens: NONSTREAMING_MAX_TOKENS + 1 }));
    expect(client.last.via).toBe('stream');
    await llm(client).generate(request({ maxTokens: 64_000 }));
    expect(client.last.via).toBe('stream');
  });

  it('can be told to stream everything', async () => {
    const client = new RecordingClient();
    await llm(client, { streamAboveMaxTokens: 0 }).generate(request({ maxTokens: 10 }));
    expect(client.last.via).toBe('stream');
  });

  it('falls back to streaming when the SDK refuses a non-streaming request', async () => {
    let first = true;
    const client = new RecordingClient(() => {
      if (first) {
        first = false;
        throw new Error(
          'Streaming is required for operations that may take longer than 10 minutes.',
        );
      }
      return GOOD;
    });
    const result = await llm(client).generate(request());
    expect(client.calls.map((call) => call.via)).toEqual(['create', 'stream']);
    expect(result.value.answer).toBe('four');
  });

  it('maps a failure of the stream like any other', async () => {
    const client = new RecordingClient(apiError(529, { type: 'overloaded_error' }));
    const error = await failure(llm(client).generate(request({ maxTokens: 64_000 })));
    expect(error).toMatchObject({ code: 'transport', retryable: true, status: 529 });
  });
});

describe('abort', () => {
  it('hands the signal to the client', async () => {
    const client = new RecordingClient();
    const controller = new AbortController();
    await llm(client).generate(request({ signal: controller.signal }));
    expect(client.last.options?.signal).toBe(controller.signal);
  });

  it('does not call the API when the signal is already aborted', async () => {
    const client = new RecordingClient();
    const controller = new AbortController();
    controller.abort();
    const error = await failure(llm(client).generate(request({ signal: controller.signal })));
    expect(error).toMatchObject({ code: 'aborted', retryable: true });
    expect(client.calls).toHaveLength(0);
  });

  it('maps an abort during the call to aborted, whatever the client throws', async () => {
    const controller = new AbortController();
    const client = new RecordingClient(() => {
      controller.abort();
      throw new Error('Request was aborted.');
    });
    const error = await failure(llm(client).generate(request({ signal: controller.signal })));
    expect(error).toMatchObject({ code: 'aborted', retryable: true });

    const named = new RecordingClient(Object.assign(new Error('x'), { name: 'AbortError' }));
    expect(await failure(llm(named).generate(request()))).toMatchObject({ code: 'aborted' });
  });
});

describe('the reply', () => {
  it('validates with the Zod schema, applies its defaults and reports usage and the served model', async () => {
    const client = new RecordingClient();
    const result = await llm(client).generate(request());
    expect(result.value).toEqual({ answer: 'four', count: 1 });
    expect(result.usage).toEqual({
      input_tokens: 120,
      output_tokens: 45,
      cache_read_tokens: 800,
      cache_creation_tokens: 0,
    });
    expect(result.model).toBe('served-model');
    expect(result.stopReason).toBe('end_turn');
  });

  it('defaults missing cache usage to 0 and the model to the requested one', async () => {
    const client = new RecordingClient(
      message(JSON.stringify({ answer: 'x' }), {
        model: undefined,
        usage: { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: null },
      }),
    );
    const result = await llm(client).generate(request());
    expect(result.usage).toEqual({
      input_tokens: 7,
      output_tokens: 3,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    expect(result.model).toBe('model-authoring');
  });

  it('joins several text blocks and ignores the other block types', async () => {
    const client = new RecordingClient(
      message('', {
        content: [
          { type: 'thinking' },
          { type: 'text', text: '{"answer":' },
          { type: 'text', text: '"joined"}' },
        ],
      }),
    );
    expect((await llm(client).generate(request())).value.answer).toBe('joined');
  });

  it('turns an invalid JSON reply into a schema error that keeps the raw text', async () => {
    const client = new RecordingClient(message('not json at all'));
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'schema', retryable: false, raw: 'not json at all' });
  });

  it('turns a reply that fails the schema into a schema error naming the field, not the prompt', async () => {
    const client = new RecordingClient(message(JSON.stringify({ answer: 5 })));
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'schema', retryable: false, raw: '{"answer":5}' });
    expect(error.message).toContain('answer');
    expect(error.message).toContain('Reply');
    expect(error.message).not.toContain(PROMPT_MARKER);
  });

  it('turns an empty reply into a schema error', async () => {
    const client = new RecordingClient(message('', { content: [{ type: 'thinking' }] }));
    expect(await failure(llm(client).generate(request()))).toMatchObject({ code: 'schema' });
  });

  it('rejects a reply the API constraint would allow but the Zod schema does not', async () => {
    const strict = z.object({ n: z.number().int().min(10) });
    const client = new RecordingClient(message('{"n":3}'));
    const error = await failure(
      llm(client).generate({ ...request(), schema: strict, schemaName: 'Strict' } as never),
    );
    expect(error.code).toBe('schema');
  });

  it('keeps the usage of a failed but billed call on the error', async () => {
    const client = new RecordingClient(message('nope'));
    const error = await failure(llm(client).generate(request()));
    expect(error).toBeInstanceOf(LlmCallError);
    expect(usageOfError(error)).toEqual({
      usage: {
        input_tokens: 120,
        output_tokens: 45,
        cache_read_tokens: 800,
        cache_creation_tokens: 0,
      },
      model: 'served-model',
      stopReason: 'end_turn',
    });
    expect(usageOfError(new LlmError('transport', 'x'))).toBeUndefined();
  });
});

describe('stop reasons', () => {
  it('maps a refusal to a non-retryable refusal and says the category', async () => {
    const client = new RecordingClient(
      message('', {
        stop_reason: 'refusal',
        stop_details: { category: 'general_harms' },
        content: [],
      }),
    );
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'refusal', retryable: false });
    expect(error.message).toContain('general_harms');
    expect(usageOfError(error)?.usage.output_tokens).toBe(45);
  });

  it('maps max_tokens to a non-retryable truncation that keeps what was written', async () => {
    const client = new RecordingClient(message('{"answer":"cut o', { stop_reason: 'max_tokens' }));
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'truncated', retryable: false, raw: '{"answer":"cut o' });
    expect(error.message).toContain('4096');
  });

  it('treats an exhausted context window as truncation too', async () => {
    const client = new RecordingClient(
      message('', { stop_reason: 'model_context_window_exceeded' }),
    );
    expect(await failure(llm(client).generate(request()))).toMatchObject({
      code: 'truncated',
      retryable: false,
    });
  });
});

describe('transport errors', () => {
  it.each([429, 500, 502, 503, 504, 529, 408])('retries HTTP %i', async (status) => {
    const client = new RecordingClient(apiError(status));
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'transport', retryable: true, status });
  });

  it.each([400, 401, 402, 403, 404, 413, 422])('does not retry HTTP %i', async (status) => {
    const client = new RecordingClient(apiError(status));
    const error = await failure(llm(client).generate(request()));
    expect(error).toMatchObject({ code: 'transport', retryable: false, status });
  });

  it('treats a failure without an HTTP status (network, timeout) as retryable', async () => {
    for (const cause of [new TypeError('fetch failed'), new Error('Request timed out.')]) {
      const error = await failure(llm(new RecordingClient(cause)).generate(request()));
      expect(error).toMatchObject({ code: 'transport', retryable: true });
      expect(error.status).toBeUndefined();
      expect(error.cause).toBe(cause);
    }
  });

  it('reads retry-after in seconds, retry-after-ms, and an HTTP date', async () => {
    const seconds = await failure(
      llm(new RecordingClient(apiError(429, { headers: { 'retry-after': '7' } }))).generate(
        request(),
      ),
    );
    expect(seconds.retryAfterMs).toBe(7000);

    const millis = await failure(
      llm(
        new RecordingClient(
          apiError(429, { headers: { 'retry-after': '7', 'retry-after-ms': '1500' } }),
        ),
      ).generate(request()),
    );
    expect(millis.retryAfterMs).toBe(1500);

    // The clock says 1 000 000 ms past the epoch; the header is 90 s later.
    const date = new Date(1_000_000 + 90_000).toUTCString();
    const dated = await failure(
      llm(new RecordingClient(apiError(503, { headers: { 'retry-after': date } }))).generate(
        request(),
      ),
    );
    expect(dated.retryAfterMs).toBe(90_000);
  });

  it('does not invent a retry-after, and ignores one on a non-retryable status', async () => {
    const none = await failure(llm(new RecordingClient(apiError(429))).generate(request()));
    expect(none.retryAfterMs).toBeUndefined();
    const bad = await failure(
      llm(new RecordingClient(apiError(400, { headers: { 'retry-after': '5' } }))).generate(
        request(),
      ),
    );
    expect(bad.retryAfterMs).toBeUndefined();
  });

  it('reads headers from a plain object too', async () => {
    const plain = Object.assign(apiError(429), { headers: { 'Retry-After': '2' } });
    const error = await failure(llm(new RecordingClient(plain)).generate(request()));
    expect(error.retryAfterMs).toBe(2000);
  });

  it('puts the status, error type, server message and request id in the message, not the prompt', async () => {
    const client = new RecordingClient(
      apiError(400, { type: 'invalid_request_error', message: 'output_config.format: bad schema' }),
    );
    const error = await failure(llm(client).generate(request()));
    expect(error.message).toContain('400');
    expect(error.message).toContain('invalid_request_error');
    expect(error.message).toContain('bad schema');
    expect(error.message).toContain('req_123');
    expect(error.message).not.toContain(PROMPT_MARKER);
  });

  it('truncates a very long server message', async () => {
    const client = new RecordingClient(apiError(500, { message: 'x'.repeat(5000) }));
    const error = await failure(llm(client).generate(request()));
    expect(error.message.length).toBeLessThan(500);
  });

  it('passes an LlmError thrown by the client through unchanged', async () => {
    const original = new LlmError('refusal', 'declined');
    const error = await failure(llm(new RecordingClient(original)).generate(request()));
    expect(error).toBe(original);
  });
});

describe('client options', () => {
  it('passes maxRetries and the timeout only when configured', async () => {
    const plain = new RecordingClient();
    await llm(plain).generate(request());
    expect(plain.last.options).toEqual({});

    const configured = new RecordingClient();
    await llm(configured, { maxRetries: 0, timeoutMs: 90_000 }).generate(request());
    expect(configured.last.options).toEqual({ maxRetries: 0, timeout: 90_000 });
  });
});
