import { describe, expect, it } from 'vitest';
import {
  DEFAULT_AI_SETTINGS,
  type JobInput,
  type JobKind,
  type JobState,
  type LlmClient,
  type LlmRequest,
} from '../contract';
import { createDemoLlm } from '../fakes/demoLlm';
import {
  goldenUnit2,
  makeDeps,
  sampleChapterPlanInput,
  sampleReviseInput,
  sampleSchemeInput,
  sampleUnitInput,
} from '../../test-support/testKit';
import { createJobEngine } from './engine';
import { DEFAULT_EFFORT, MAX_OUTPUT_TOKENS } from './settings';

const engine = createJobEngine();

const cases: { [K in JobKind]: JobInput[K] } = {
  scheme_ingest: engine.parseInput('scheme_ingest', sampleSchemeInput()),
  chapter_plan: engine.parseInput('chapter_plan', sampleChapterPlanInput()),
  unit_generate: engine.parseInput('unit_generate', sampleUnitInput()),
  unit_revise: engine.parseInput('unit_revise', sampleReviseInput(goldenUnit2)),
};

describe('every step of every kind', () => {
  for (const kind of Object.keys(cases) as JobKind[]) {
    it(`${kind}: runs the same step twice with the same state and gets the same outcome, and finishes with progress complete`, async () => {
      const deps = makeDeps(createDemoLlm());
      const input = cases[kind] as never;
      let state: JobState = { outputs: {} };
      const seen: string[] = [];
      for (let i = 0; i < 60; i += 1) {
        const step = engine.nextStep(kind, input, state);
        if (step === null) break;
        const first = await engine.runStep({ kind, input, state, step }, deps);
        const second = await engine.runStep({ kind, input, state, step }, deps);
        expect(second.output, `${kind}:${step}`).toEqual(first.output);
        expect(second.result, `${kind}:${step}`).toEqual(first.result);
        seen.push(step);
        state = JSON.parse(
          JSON.stringify({ outputs: { ...state.outputs, [step]: first.output } }),
        ) as JobState;
        const progress = engine.progress(kind, input, state);
        expect(progress.done).toContain(step);
        expect(progress.total).toBeGreaterThanOrEqual(progress.done.length);
      }
      const finished = engine.progress(kind, input, state);
      expect(finished.next).toBeNull();
      expect(finished.done.length).toBe(finished.total);
      expect(engine.nextStep(kind, input, state)).toBeNull();
      expect(seen.length).toBe(finished.total);
    });
  }

  it('refuses a step that does not exist for the kind', async () => {
    const deps = makeDeps(createDemoLlm());
    for (const kind of Object.keys(cases) as JobKind[]) {
      await expect(
        engine.runStep(
          { kind, input: cases[kind] as never, state: { outputs: {} }, step: 'nonsense' },
          deps,
        ),
      ).rejects.toMatchObject({ code: 'internal', retryable: false });
    }
  });
});

describe('effort and output budget', () => {
  function recordingDeps(effort: Record<string, 'low' | 'medium' | 'high' | 'xhigh' | 'max'> = {}) {
    const demo = createDemoLlm();
    const requests: LlmRequest<unknown>[] = [];
    const llm: LlmClient = {
      generate(request) {
        requests.push(request as LlmRequest<unknown>);
        return demo.generate(request);
      },
    };
    return { requests, deps: makeDeps(llm, {}, { ...DEFAULT_AI_SETTINGS, effort }) };
  }

  it('sets the effort explicitly on every call, from the default table, and always asks for the authoring task', async () => {
    const { requests, deps } = recordingDeps();
    const input = cases.unit_generate;
    let state: JobState = { outputs: {} };
    for (;;) {
      const step = engine.nextStep('unit_generate', input, state);
      if (step === null) break;
      const outcome = await engine.runStep({ kind: 'unit_generate', input, state, step }, deps);
      state = { outputs: { ...state.outputs, [step]: outcome.output } };
    }
    for (const request of requests) {
      expect(request.task).toBe('authoring');
      expect(['low', 'medium', 'high', 'xhigh', 'max']).toContain(request.effort);
      expect(request.maxTokens).toBeGreaterThan(1000);
      expect(request.maxTokens).toBeLessThanOrEqual(21_333);
    }
    const byLabel = (prefix: string) => requests.find((r) => r.label.startsWith(prefix))!;
    expect(byLabel('unit_generate:section:').effort).toBe(DEFAULT_EFFORT['unit_generate:section']);
    expect(byLabel('unit_generate:workbook').effort).toBe(DEFAULT_EFFORT['unit_generate:workbook']);
    expect(byLabel('unit_generate:section:').maxTokens).toBe(
      MAX_OUTPUT_TOKENS['unit_generate:section'],
    );
  });

  it('lets settings.effort override the default per step family', async () => {
    const { requests, deps } = recordingDeps({
      'unit_generate:section': 'xhigh',
      'unit_generate:outline': 'low',
    });
    const input = cases.unit_generate;
    const outline = await engine.runStep(
      { kind: 'unit_generate', input, state: { outputs: {} }, step: 'outline' },
      deps,
    );
    await engine.runStep(
      {
        kind: 'unit_generate',
        input,
        state: { outputs: { outline: outline.output } },
        step: 'section:story_opener',
      },
      deps,
    );
    expect(requests[0]!.effort).toBe('low');
    expect(requests[1]!.effort).toBe('xhigh');
    expect(requests[1]!.label).toBe('unit_generate:section:story_opener');
  });
});
