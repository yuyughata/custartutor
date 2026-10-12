import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { DEFAULT_MODELS, LlmError } from '../contract';
import type { LlmRequest } from '../contract';
import { LlmRequestError } from '../llm/errors';
import { FakeLlm, FakeLlmScriptError } from './fakeLlm';

const Reply = z.object({ answer: z.string(), count: z.number().int().default(1) });
type Reply = z.output<typeof Reply>;

function request(overrides: Partial<LlmRequest<Reply>> = {}): LlmRequest<Reply> {
  return {
    task: 'authoring',
    label: 'unit_generate:outline',
    system: [{ text: 'Rules.', cache: true }, { text: 'Context.' }],
    messages: [{ role: 'user', content: 'Go.' }],
    schema: Reply,
    schemaName: 'Reply',
    effort: 'low',
    maxTokens: 1000,
    ...overrides,
  };
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

describe('FakeLlm', () => {
  it('answers a label, validates the value with the schema and fills its defaults', async () => {
    const llm = new FakeLlm().on('unit_generate:outline', { answer: 'hello' });
    const result = await llm.generate(request());
    expect(result.value).toEqual({ answer: 'hello', count: 1 });
    expect(result.model).toBe(DEFAULT_MODELS.authoring);
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
  });

  it('records every request with its system blocks, messages and schema name', async () => {
    const llm = new FakeLlm().on(/./, { answer: 'x' });
    const signal = new AbortController().signal;
    await llm.generate(request({ signal }));
    await llm.generate(request({ label: 'second', task: 'tutor', effort: 'max', maxTokens: 7 }));

    expect(llm.calls).toHaveLength(2);
    const [first, second] = llm.calls;
    expect(first).toMatchObject({
      index: 0,
      label: 'unit_generate:outline',
      task: 'authoring',
      schemaName: 'Reply',
      effort: 'low',
      maxTokens: 1000,
      outcome: 'value',
      system: [{ text: 'Rules.', cache: true }, { text: 'Context.' }],
      messages: [{ role: 'user', content: 'Go.' }],
      value: { answer: 'x', count: 1 },
    });
    expect(first?.signal).toBe(signal);
    expect(first?.jsonSchema).toMatchObject({ type: 'object', additionalProperties: false });
    expect(second).toMatchObject({ label: 'second', model: DEFAULT_MODELS.tutor, effort: 'max' });
  });

  it('matches by exact label, RegExp or predicate; an exact label beats an earlier pattern', async () => {
    const llm = new FakeLlm()
      .on(/^unit_generate:/, { answer: 'by pattern' })
      .on('unit_generate:outline', { answer: 'by label' })
      .on((r) => r.task === 'moderation', { answer: 'by predicate' });
    expect((await llm.generate(request())).value.answer).toBe('by label');
    expect((await llm.generate(request({ label: 'unit_generate:core' }))).value.answer).toBe(
      'by pattern',
    );
    expect((await llm.generate(request({ label: 'check', task: 'moderation' }))).value.answer).toBe(
      'by predicate',
    );
  });

  it('limits a handler with times and falls through to the next one', async () => {
    const llm = new FakeLlm()
      .on('a', { answer: 'once' }, { times: 1 })
      .on('a', { answer: 'then this' });
    const answers = [];
    for (let i = 0; i < 3; i += 1)
      answers.push((await llm.generate(request({ label: 'a' }))).value.answer);
    expect(answers).toEqual(['once', 'then this', 'then this']);
  });

  it('answers a sequence in order, then has nothing left', async () => {
    const llm = new FakeLlm().onSequence('s', [
      new LlmError('transport', 'blip'),
      { answer: 'second try' },
    ]);
    await expect(llm.generate(request({ label: 's' }))).rejects.toMatchObject({
      code: 'transport',
    });
    expect((await llm.generate(request({ label: 's' }))).value.answer).toBe('second try');
    await expect(llm.generate(request({ label: 's' }))).rejects.toBeInstanceOf(FakeLlmScriptError);
  });

  it('serves a plain queue first in, first out, after the handlers', async () => {
    const llm = new FakeLlm()
      .on('named', { answer: 'handler' })
      .enqueue({ answer: '1' }, { answer: '2' });
    expect((await llm.generate(request({ label: 'named' }))).value.answer).toBe('handler');
    expect((await llm.generate(request({ label: 'anything' }))).value.answer).toBe('1');
    expect((await llm.generate(request({ label: 'other' }))).value.answer).toBe('2');
    await expect(llm.generate(request({ label: 'third' }))).rejects.toBeInstanceOf(
      FakeLlmScriptError,
    );
  });

  it('throws a returned or thrown LlmError as scripted', async () => {
    const refusal = new LlmError('refusal', 'declined', { retryable: false });
    const llm = new FakeLlm().on('returned', refusal).on('thrown', () => {
      throw new LlmError('truncated', 'cut', { raw: 'part' });
    });
    await expect(llm.generate(request({ label: 'returned' }))).rejects.toBe(refusal);
    await expect(llm.generate(request({ label: 'thrown' }))).rejects.toMatchObject({
      code: 'truncated',
      raw: 'part',
    });
    expect(llm.calls.map((c) => c.outcome)).toEqual(['error', 'error']);
  });

  it('lets a function compute the answer from the request', async () => {
    const llm = new FakeLlm().on(/./, async (r, call) => ({
      answer: `${r.label}#${call.index}`,
    }));
    expect((await llm.generate(request())).value.answer).toBe('unit_generate:outline#0');
  });

  it('never makes up content: an unscripted call is a programmer error that names the label', async () => {
    const llm = new FakeLlm().on('known', { answer: 'x' });
    const error = await caught(llm.generate(request({ label: 'mystery:step' })));
    expect(error).toBeInstanceOf(FakeLlmScriptError);
    expect(error).not.toBeInstanceOf(LlmError);
    expect(error.message).toContain('mystery:step');
    expect(error.message).toContain('known');
    expect(llm.calls[0]?.outcome).toBe('unscripted');
  });

  it('fails loudly when a scripted value does not fit the schema', async () => {
    const llm = new FakeLlm().on('bad', { answer: 42 });
    const error = await caught(llm.generate(request({ label: 'bad' })));
    expect(error).toBeInstanceOf(FakeLlmScriptError);
    expect(error).not.toBeInstanceOf(LlmError);
    expect(error.message).toContain('bad');
    expect(error.message).toContain('answer');
    expect(llm.calls[0]?.outcome).toBe('invalid_script');
  });

  it('reports deterministic usage that can be set globally or per handler', async () => {
    const llm = new FakeLlm({ usage: { input_tokens: 10, output_tokens: 5 } })
      .on('plain', { answer: 'x' })
      .on('cached', { answer: 'x' }, { usage: { cache_read_tokens: 900 }, stopReason: 'end_turn' });
    expect((await llm.generate(request({ label: 'plain' }))).usage).toEqual({
      input_tokens: 10,
      output_tokens: 5,
      cache_read_tokens: 0,
      cache_creation_tokens: 0,
    });
    expect((await llm.generate(request({ label: 'cached' }))).usage.cache_read_tokens).toBe(900);
    llm.setUsage({ input_tokens: 77 });
    expect((await llm.generate(request({ label: 'plain' }))).usage.input_tokens).toBe(77);
  });

  it('uses the configured model ids', async () => {
    const llm = new FakeLlm({ models: { authoring: 'a', tutor: 't', moderation: 'm' } }).on(/./, {
      answer: 'x',
    });
    expect((await llm.generate(request({ task: 'moderation' }))).model).toBe('m');
  });

  it('forgets everything on reset', async () => {
    const llm = new FakeLlm().on('a', { answer: 'x' }).enqueue({ answer: 'q' });
    llm.setUsage({ input_tokens: 1 });
    await llm.generate(request({ label: 'a' }));
    llm.reset();
    expect(llm.calls).toHaveLength(0);
    await expect(llm.generate(request({ label: 'a' }))).rejects.toBeInstanceOf(FakeLlmScriptError);
    llm.on('a', { answer: 'again' });
    expect((await llm.generate(request({ label: 'a' }))).usage.input_tokens).toBe(100);
  });

  it('finds recorded calls with callsFor', async () => {
    const llm = new FakeLlm().on(/./, { answer: 'x' });
    await llm.generate(request({ label: 'a:1' }));
    await llm.generate(request({ label: 'b:1' }));
    await llm.generate(request({ label: 'a:2' }));
    expect(llm.callsFor(/^a:/).map((c) => c.label)).toEqual(['a:1', 'a:2']);
    expect(llm.callsFor('b:1')).toHaveLength(1);
  });

  describe('parity with the real adapter', () => {
    it('rejects a trailing assistant message', async () => {
      const llm = new FakeLlm().on(/./, { answer: 'x' });
      const call = llm.generate(
        request({
          messages: [
            { role: 'user', content: 'a' },
            { role: 'assistant', content: 'b' },
          ],
        }),
      );
      await expect(call).rejects.toBeInstanceOf(LlmRequestError);
      expect(llm.calls[0]?.outcome).toBe('rejected');
    });

    it('rejects a schema structured outputs cannot express, unless checking is off', async () => {
      const loose = z.object({ bag: z.record(z.string(), z.string()) });
      const req = {
        ...request(),
        schema: loose,
        schemaName: 'Loose',
      } as unknown as LlmRequest<unknown>;
      const checked = new FakeLlm().on(/./, { bag: {} });
      await expect(checked.generate(req)).rejects.toBeInstanceOf(LlmRequestError);
      const unchecked = new FakeLlm({ checkSchemas: false }).on(/./, { bag: {} });
      await expect(unchecked.generate(req)).resolves.toBeDefined();
    });
  });

  describe('abort', () => {
    it('rejects with aborted when the signal is already aborted', async () => {
      const llm = new FakeLlm().on(/./, { answer: 'x' });
      const controller = new AbortController();
      controller.abort();
      await expect(llm.generate(request({ signal: controller.signal }))).rejects.toMatchObject({
        code: 'aborted',
        retryable: true,
      });
    });

    it('rejects with aborted when the signal fires while the handler is still pending', async () => {
      const controller = new AbortController();
      const llm = new FakeLlm().on(/./, () => new Promise(() => undefined));
      const pending = llm.generate(request({ signal: controller.signal }));
      controller.abort();
      await expect(pending).rejects.toMatchObject({ code: 'aborted', retryable: true });
    });
  });
});
