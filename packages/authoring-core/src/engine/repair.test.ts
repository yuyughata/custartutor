import { describe, expect, it } from 'vitest';
import { parseUnit, sectionsOf } from '@custar/content-schema';
import type { Json, JobState, LlmRequest } from '../contract';
import { createDemoLlm } from '../fakes/demoLlm';
import type { AuthorSectionBody, RepairOutput } from '../prompts/schemas';
import { createJobEngine } from './engine';
import { makeDeps, sampleUnitInput, type ScriptedCall } from '../../test-support/testKit';
import { affectedSectionIds, plannedUnitSteps } from './unitGenerate';
import { clone } from './util';

const engine = createJobEngine();
const input = engine.parseInput('unit_generate', sampleUnitInput());

/** Runs the job with the demo model up to (not including) `stop`, recording the replies. */
async function runUntil(stop: string, tamper?: (state: JobState, step: string) => void) {
  const demo = createDemoLlm();
  const replies = new Map<string, unknown>();
  const llm = {
    async generate<T>(request: LlmRequest<T>) {
      const result = await demo.generate(request);
      replies.set(request.label, result.value);
      return result;
    },
  };
  const deps = makeDeps(llm);
  let state: JobState = { outputs: {} };
  for (;;) {
    const step = engine.nextStep('unit_generate', input, state);
    if (step === null || step === stop) return { state, deps, replies };
    const outcome = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps);
    state = { outputs: { ...state.outputs, [step]: outcome.output } };
    tamper?.(state, step);
  }
}

/** Breaks the practice section's first fill_blank so that the unit no longer parses. */
function breakPractice(state: JobState, step: string): void {
  if (step !== 'section:practice') return;
  const part = state.outputs[step] as unknown as {
    questions: { kind: string; answer: { blanks: unknown[] } }[];
  };
  const q = part.questions.find((x) => x.kind === 'fill_blank')!;
  q.answer.blanks.push({ accepted: ['extra'] });
}

describe('repair steps', () => {
  it('plans repair:1 only when assemble has lint errors, and points it at the sections the errors name', async () => {
    const { state, deps } = await runUntil('assemble', breakPractice);
    const assembled = await engine.runStep(
      { kind: 'unit_generate', input, state, step: 'assemble' },
      deps,
    );
    const stored = assembled.output as unknown as {
      lint: { errors: { code: string; path?: string }[]; ok: boolean };
      parsed: boolean;
    };
    expect(stored.parsed).toBe(false);
    expect(stored.lint.ok).toBe(false);
    expect(stored.lint.errors[0]!.code).toBe('schema_invalid');
    const withAssemble: JobState = { outputs: { ...state.outputs, assemble: assembled.output } };
    expect(engine.nextStep('unit_generate', input, withAssemble)).toBe('repair:1');
    expect(plannedUnitSteps(input, withAssemble).slice(-2)).toEqual(['repair:1', 'review']);
    expect(
      affectedSectionIds(
        (assembled.output as { content: Json }).content,
        stored.lint.errors as never,
      ),
    ).toEqual(['practice']);
  });

  it('rewrites only the affected section, re-assembles inside the step and then goes on to the review', async () => {
    const { state, deps, replies } = await runUntil('assemble', breakPractice);
    const assembled = await engine.runStep(
      { kind: 'unit_generate', input, state, step: 'assemble' },
      deps,
    );
    let s: JobState = { outputs: { ...state.outputs, assemble: assembled.output } };

    const good = replies.get('unit_generate:section:practice') as AuthorSectionBody;
    const calls: ScriptedCall[] = [];
    const llm = {
      async generate<T>(request: LlmRequest<T>) {
        calls.push({ request: request as LlmRequest<unknown> });
        const value = request.schema.parse({
          sections: [{ id: 'practice', ...good }],
        } satisfies RepairOutput);
        return {
          value,
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'm',
          stopReason: 'end_turn',
        };
      },
    };
    const repaired = await engine.runStep(
      { kind: 'unit_generate', input, state: s, step: 'repair:1' },
      makeDeps(llm),
    );
    const text = String(calls[0]!.request.messages[0]!.content);
    expect(text).toContain('"id": "practice"');
    expect(text).not.toContain('"id": "story_opener"');
    expect(text).toMatch(/sections_to_repair/);
    const out = repaired.output as unknown as {
      lint: { ok: boolean; errors: unknown[] };
      parsed: boolean;
      replaced: Record<string, unknown>;
    };
    expect(out.parsed).toBe(true);
    expect(out.lint.ok).toBe(true);
    expect(Object.keys(out.replaced)).toEqual(['practice']);

    s = { outputs: { ...s.outputs, 'repair:1': repaired.output } };
    expect(engine.nextStep('unit_generate', input, s)).toBe('review');
    const review = await engine.runStep(
      { kind: 'unit_generate', input, state: s, step: 'review' },
      deps,
    );
    expect(parseUnit(review.result!.content).kind).toBe('lesson');
    expect(review.result!.lint.ok).toBe(true);
    expect(sectionsOf(parseUnit(review.result!.content)).map((x) => x.id)).toContain('practice');
  });

  it('with an error no section owns, the repair step makes no call, no second repair is planned, and the draft finishes with the errors visible', async () => {
    const tamper = (state: JobState, step: string) => {
      if (step === 'workbook') (state.outputs[step] as unknown as { drill: unknown[] }).drill = [];
    };
    const { state, deps } = await runUntil('assemble', tamper);
    const assembled = await engine.runStep(
      { kind: 'unit_generate', input, state, step: 'assemble' },
      deps,
    );
    const errors = (assembled.output as unknown as { lint: { errors: { code: string }[] } }).lint
      .errors;
    expect(errors.map((e) => e.code)).toContain('workbook_drill');
    let s: JobState = { outputs: { ...state.outputs, assemble: assembled.output } };
    expect(engine.nextStep('unit_generate', input, s)).toBe('repair:1');
    const noModel = {
      generate: () => Promise.reject(new Error('the model must not be called')),
    } as never;
    const skipped = await engine.runStep(
      { kind: 'unit_generate', input, state: s, step: 'repair:1' },
      makeDeps(noModel),
    );
    expect(skipped.usage).toEqual([]);
    expect((skipped.output as { skipped: boolean }).skipped).toBe(true);
    s = { outputs: { ...s.outputs, 'repair:1': skipped.output } };
    expect(engine.nextStep('unit_generate', input, s)).toBe('review');
    const review = await engine.runStep(
      { kind: 'unit_generate', input, state: s, step: 'review' },
      deps,
    );
    expect(review.result!.lint.ok).toBe(false);
    expect(review.result!.lint.errors.map((e) => e.code)).toContain('workbook_drill');
    expect(review.result!.content).toBeDefined();
  });

  it('plans at most two repairs, and only while errors remain', () => {
    const outline = {
      sections: [{ id: 'concept_1', type: 'concept', heading: 'C', plan: '', covers: [] }],
      periods: [
        { period: 1, sections: ['concept_1'], minutes: [{ segment: 'start', minutes: 10 }] },
      ],
      enrichment: [],
      notes: [],
    };
    const bad = {
      content: {},
      lint: { errors: [{ code: 'x' }], warnings: [], ok: false },
      notes: [],
      parsed: true,
    };
    const ok = { ...bad, lint: { errors: [], warnings: [], ok: true } };
    const base = {
      outline,
      workbook: {},
      manual: {},
      'section:concept_1': {},
    } as unknown as Record<string, Json>;
    const plan = (extra: Record<string, unknown>) =>
      plannedUnitSteps(input, { outputs: { ...base, ...extra } as never }).slice(-3);
    expect(plan({ assemble: ok })).toEqual(['manual', 'assemble', 'review']);
    expect(plan({ assemble: bad })).toEqual(['assemble', 'repair:1', 'review']);
    expect(plan({ assemble: bad, 'repair:1': bad })).toEqual(['repair:1', 'repair:2', 'review']);
    expect(plan({ assemble: bad, 'repair:1': bad, 'repair:2': bad })).toEqual([
      'repair:1',
      'repair:2',
      'review',
    ]);
    expect(plan({ assemble: bad, 'repair:1': ok })).toEqual(['assemble', 'repair:1', 'review']);
    expect(
      engine.nextStep('unit_generate', input, {
        outputs: { ...base, assemble: bad, 'repair:1': bad, 'repair:2': bad } as never,
      }),
    ).toBe('review');
  });

  it('maps lint errors to sections by path and by question ownership', () => {
    const content = clone({
      sections: [
        { id: 'a', type: 'concept', blocks: [{ type: 'question', question_id: 'q_a_1' }] },
        {
          id: 'practice',
          type: 'practice',
          blocks: [{ type: 'question', question_id: 'q_practice_1' }],
        },
        { id: 'mastery_check', type: 'mastery_check', blocks: [] },
      ],
    }) as unknown as Json;
    const error = (code: string, path?: string) => ({
      code,
      severity: 'concern' as const,
      message: 'm',
      ...(path ? { path } : {}),
    });
    expect(
      affectedSectionIds(content, [error('dangling_ref', 'sections[0].blocks[0].question_id')]),
    ).toEqual(['a']);
    expect(
      affectedSectionIds(content, [error('answer_spec_invalid', 'questions.q_practice_1.answer')]),
    ).toEqual(['practice']);
    expect(
      affectedSectionIds(content, [error('answer_spec_invalid', 'questions["q_a_9"].answer')]),
    ).toEqual(['a']);
    expect(affectedSectionIds(content, [error('mastery_no_gradable')])).toEqual(['mastery_check']);
    expect(
      affectedSectionIds(content, [
        error('workbook_tiers', 'workbook.tiers'),
        error('missing_section'),
      ]),
    ).toEqual([]);
  });
});
