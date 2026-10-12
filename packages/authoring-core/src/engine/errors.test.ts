import { describe, expect, it } from 'vitest';
import { LlmError, StepError, type LlmRequest, type LlmUsage } from '../contract';
import { LlmCallError } from '../llm/errors';
import { createDemoLlm } from '../fakes/demoLlm';
import { createJobEngine } from './engine';
import { makeDeps, sampleUnitInput, type ScriptedCall } from '../../test-support/testKit';
import type { JobState } from '../contract';

const engine = createJobEngine();
const demo = createDemoLlm();

/** A model that answers like the demo, except where `intercept` returns something else. */
function delegating(
  intercept: (
    request: LlmRequest<unknown>,
    call: number,
  ) => { throw?: unknown; value?: unknown } | undefined,
  calls: ScriptedCall[] = [],
) {
  let n = 0;
  return {
    async generate<T>(request: LlmRequest<T>) {
      calls.push({ request: request as LlmRequest<unknown> });
      const hit = intercept(request as LlmRequest<unknown>, n++);
      if (hit?.throw) throw hit.throw;
      if (hit && 'value' in hit) {
        const value = request.schema.parse(hit.value);
        return {
          value,
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'scripted-test-model',
          stopReason: 'end_turn',
        };
      }
      return demo.generate(request);
    },
  };
}

const input = engine.parseInput('unit_generate', sampleUnitInput());

async function runUpTo(step: string, llm = demo): Promise<JobState> {
  let state: JobState = { outputs: {} };
  const deps = makeDeps(llm);
  for (;;) {
    const next = engine.nextStep('unit_generate', input, state);
    if (next === null || next === step) return state;
    const outcome = await engine.runStep({ kind: 'unit_generate', input, state, step: next }, deps);
    state = { outputs: { ...state.outputs, [next]: outcome.output } };
  }
}

async function failure(
  llm: ReturnType<typeof delegating>,
  step = 'outline',
  state: JobState = { outputs: {} },
): Promise<StepError> {
  try {
    await engine.runStep({ kind: 'unit_generate', input, state, step }, makeDeps(llm));
  } catch (error) {
    expect(error).toBeInstanceOf(StepError);
    return error as StepError;
  }
  throw new Error('the step should have failed');
}

describe('model failures become StepErrors', () => {
  it('a refusal is not retryable', async () => {
    const error = await failure(delegating(() => ({ throw: new LlmError('refusal', 'declined') })));
    expect(error.code).toBe('refusal');
    expect(error.retryable).toBe(false);
    expect(error.step).toBe('outline');
  });

  it('a truncated reply is a truncated StepError', async () => {
    const error = await failure(
      delegating(() => ({ throw: new LlmError('truncated', 'ran out of tokens') })),
    );
    expect(error.code).toBe('truncated');
    expect(error.retryable).toBe(false);
  });

  it('a transport failure keeps retryable and retryAfterMs', async () => {
    const error = await failure(
      delegating(() => ({
        throw: new LlmError('transport', 'rate limited', {
          retryable: true,
          retryAfterMs: 7000,
          status: 429,
        }),
      })),
    );
    expect(error.code).toBe('transport');
    expect(error.retryable).toBe(true);
    expect(error.retryAfterMs).toBe(7000);
    const hard = await failure(
      delegating(() => ({
        throw: new LlmError('transport', 'bad key', { retryable: false, status: 401 }),
      })),
    );
    expect(hard.retryable).toBe(false);
  });

  it('an abort is an aborted StepError', async () => {
    const error = await failure(delegating(() => ({ throw: new LlmError('aborted', 'deadline') })));
    expect(error.code).toBe('aborted');
    const controller = new AbortController();
    controller.abort();
    let thrown: unknown;
    try {
      await engine.runStep(
        { kind: 'unit_generate', input, state: { outputs: {} }, step: 'outline' },
        makeDeps(demo, { signal: controller.signal }),
      );
    } catch (e) {
      thrown = e;
    }
    expect((thrown as StepError).code).toBe('aborted');
  });

  it('a billed failure carries its usage on the StepError, so the budgets count it', async () => {
    const usage: LlmUsage = {
      input_tokens: 900,
      output_tokens: 40,
      cache_read_tokens: 800,
      cache_creation_tokens: 0,
    };
    const error = await failure(
      delegating(() => ({
        throw: new LlmCallError('refusal', 'declined', {
          usage,
          model: 'claude-opus-5-5',
          stopReason: 'refusal',
        }),
      })),
    );
    expect(error.code).toBe('refusal');
    expect(error.usage).toHaveLength(1);
    expect(error.usage[0]).toMatchObject({
      model: 'claude-opus-5-5',
      input_tokens: 900,
      output_tokens: 40,
      cache_read_tokens: 800,
      stop_reason: 'refusal',
      task: 'authoring',
    });
  });

  it('an unknown error becomes an internal StepError', async () => {
    const error = await failure(delegating(() => ({ throw: new TypeError('boom') })));
    expect(error.code).toBe('internal');
  });
});

describe('one schema repair retry inside the step', () => {
  it('re-asks once with the problems when the reply fails the adapter schema, then succeeds', async () => {
    const calls: ScriptedCall[] = [];
    let first = true;
    const llm = delegating((request) => {
      if (request.label === 'unit_generate:outline' && first) {
        first = false;
        return {
          throw: new LlmError(
            'schema',
            'enrichment.0.type: Invalid option: expected one of "story_opener"|...',
            {
              raw: '{"enrichment":[{"type":"nope"}]}',
            },
          ),
        };
      }
      return undefined;
    }, calls);
    const outcome = await engine.runStep(
      { kind: 'unit_generate', input, state: { outputs: {} }, step: 'outline' },
      makeDeps(llm),
    );
    expect(calls).toHaveLength(2);
    const second = calls[1]!.request;
    expect(second.messages.length).toBe(3);
    expect(second.messages[1]).toMatchObject({
      role: 'assistant',
      content: '{"enrichment":[{"type":"nope"}]}',
    });
    const retry = second.messages[2]!;
    expect(retry.role).toBe('user');
    expect(String(retry.content)).toContain('enrichment.0.type');
    expect(String(retry.content)).toContain('rejected');
    expect(outcome.usage).toHaveLength(1);
  });

  it('a failed first call that was billed is reported together with the successful retry', async () => {
    const usage: LlmUsage = {
      input_tokens: 500,
      output_tokens: 20,
      cache_read_tokens: 0,
      cache_creation_tokens: 400,
    };
    let first = true;
    const llm = delegating((request) => {
      if (request.label === 'unit_generate:outline' && first) {
        first = false;
        return {
          throw: new LlmCallError('schema', 'bad shape', {
            usage,
            model: 'm',
            stopReason: 'end_turn',
          }),
        };
      }
      return undefined;
    });
    const outcome = await engine.runStep(
      { kind: 'unit_generate', input, state: { outputs: {} }, step: 'outline' },
      makeDeps(llm),
    );
    expect(outcome.usage).toHaveLength(2);
    expect(outcome.usage[0]!.cache_creation_tokens).toBe(400);
  });

  it('fails with a schema StepError (usage kept) when the retry is invalid too', async () => {
    const error = await failure(
      delegating(() => ({
        throw: new LlmCallError('schema', 'still wrong', {
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'm',
          stopReason: 'end_turn',
        }),
      })),
    );
    expect(error.code).toBe('schema');
    expect(error.retryable).toBe(false);
    expect(error.usage).toHaveLength(2);
  });

  it('also retries once when the reply fits the schema but breaks a rule the code checks', async () => {
    const calls: ScriptedCall[] = [];
    const state = await runUpTo('section:concept_1');
    const llm = delegating((request, n) => {
      if (request.label === 'unit_generate:section:concept_1' && n === 0) {
        // a multiple-choice question whose answer is not among the options
        return {
          value: {
            blocks: [
              {
                type: 'paragraph',
                text: 'Our school has places.',
                label: '',
                brief: '',
                alt: '',
                tone: 'none',
                items: [],
                headers: [],
                rows: [],
                question_ref: '',
              },
              {
                type: 'question',
                text: '',
                label: '',
                brief: '',
                alt: '',
                tone: 'none',
                items: [],
                headers: [],
                rows: [],
                question_ref: 'q1',
              },
            ],
            questions: [
              {
                ref: 'q1',
                kind: 'mcq',
                tier: 1,
                prompt: 'Where do we learn?',
                hint: '',
                explanation: '',
                skill_tag: '',
                options: ['classroom', 'kitchen'],
                answers: ['library'],
                blanks: [],
                numeric: false,
                units: [],
                pairs: [],
                checks: [],
                exemplar: '',
              },
            ],
            tutor_script: [],
          },
        };
      }
      return undefined;
    }, calls);
    const outcome = await engine.runStep(
      { kind: 'unit_generate', input, state, step: 'section:concept_1' },
      makeDeps(llm),
    );
    expect(calls).toHaveLength(2);
    const retry = String(
      calls[1]!.request.messages[calls[1]!.request.messages.length - 1]!.content,
    );
    expect(retry).toContain('"library" is not one of the options');
    expect(outcome.usage).toHaveLength(2);
  });

  it('a rule-breaking reply twice in a row is a schema StepError', async () => {
    const state = await runUpTo('section:concept_1');
    const bad = {
      blocks: [],
      questions: [],
      tutor_script: [],
    };
    const error = await failure(
      delegating((r) =>
        r.label === 'unit_generate:section:concept_1' ? { value: bad } : undefined,
      ),
      'section:concept_1',
      state,
    );
    expect(error.code).toBe('schema');
    expect(error.message).toContain('blocks');
    expect(error.usage).toHaveLength(2);
  });
});

describe('the whole job survives a transient failure on retry', () => {
  it('runs to the end when a transport error is retried by the client', async () => {
    let failedOnce = false;
    const llm = delegating((request) => {
      if (request.label === 'unit_generate:workbook' && !failedOnce) {
        failedOnce = true;
        return {
          throw: new LlmError('transport', 'overloaded', { retryable: true, retryAfterMs: 1000 }),
        };
      }
      return undefined;
    });
    const deps = makeDeps(llm);
    // the client retries a retryable step with the same state: emulate it here
    let state: JobState = { outputs: {} };
    let attempts = 0;
    for (;;) {
      const step = engine.nextStep('unit_generate', input, state);
      if (step === null) break;
      try {
        const outcome = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps);
        state = { outputs: { ...state.outputs, [step]: outcome.output } };
      } catch (error) {
        expect((error as StepError).retryable).toBe(true);
        attempts += 1;
      }
    }
    expect(attempts).toBe(1);
    expect(state.outputs['review']).toBeDefined();
  });
});
