// Helpers for the engine's tests and for the live-evaluation script: sample inputs built from the repo fixtures,
// a driver that runs a job to the end the way the client does (state serialised between steps), and a tiny
// scripted model. Pure and platform-neutral, but not part of the public API.
import {
  goldenUnit2,
  p1BasicScienceTerm1,
  marketDayMathsUnit,
} from '@custar/content-schema/fixtures';
import {
  DEFAULT_AI_SETTINGS,
  emptyJobState,
  type AiSettings,
  type ChapterPlanInput,
  type EngineResult,
  type JobEngine,
  type JobInput,
  type JobKind,
  type JobState,
  type LlmClient,
  type LlmRequest,
  type LlmResult,
  type SchemeIngestInput,
  type StepDeps,
  type UnitGenerateInput,
  type UnitReviseInput,
  type UsageRecord,
} from '../src/contract';
import { DEFAULT_CAST } from '../src/engine/castDefaults';
import { clone, toJson } from '../src/engine/util';

export const UNIT_UUID = '00000000-0000-4000-8000-000000000001';
export const BASE_UUID = '00000000-0000-4000-8000-000000000002';
export const SCHEME_UUID = '00000000-0000-4000-8000-000000000003';

const week2 = p1BasicScienceTerm1.weeks.find((week) => week.week_no === 2)!;

export function sampleUnitInput(overrides: Partial<UnitGenerateInput> = {}): UnitGenerateInput {
  return {
    unit: {
      id: UNIT_UUID,
      kind: 'lesson',
      unit_no: 2,
      week_no: 2,
      title: 'Exploring Our Environment (Part 2)',
      objective: goldenUnit2.header.objective,
      stage: 'absorb',
      stage_to: 'connect',
      periods: 2,
    },
    chapter: { number: 1, title: 'Our World Around Us' },
    subject: { slug: 'basic-science', name: 'Basic Science' },
    level_code: 'P1',
    term: 1,
    theme: goldenUnit2.header.theme!,
    scheme_week: { topic: week2.topic, subtopics: [...week2.subtopics] },
    prior_units: [
      {
        unit_no: 1,
        title: 'Exploring Our Environment (Part 1)',
        objective: 'Understand what an environment is and describe it using our senses.',
        key_terms: ['environment', 'senses'],
      },
    ],
    previous_enrichment: [],
    cast: DEFAULT_CAST,
    ...overrides,
  };
}

export function sampleSchemeInput(overrides: Partial<SchemeIngestInput> = {}): SchemeIngestInput {
  return {
    subject_slug: 'basic-science',
    subject_name: 'Basic Science',
    level_code: 'P1',
    term: 1,
    source: {
      type: 'pdf',
      path: 'uploads/p1-basic-science.pdf',
      filename: 'P1_Basic_Science_Scheme_of_Work.pdf',
    },
    ...overrides,
  };
}

export function sampleChapterPlanInput(
  overrides: Partial<ChapterPlanInput> = {},
): ChapterPlanInput {
  return {
    scheme_id: SCHEME_UUID,
    scheme: clone(p1BasicScienceTerm1),
    subject_name: 'Basic Science',
    cast: DEFAULT_CAST,
    ...overrides,
  };
}

export function sampleReviseInput(
  baseContent: unknown,
  instruction = 'Make the story shorter.',
  overrides: Partial<UnitReviseInput> = {},
): UnitReviseInput {
  return {
    unit_id: UNIT_UUID,
    base_version_id: BASE_UUID,
    base_version_no: 1,
    base_content: toJson(baseContent),
    instruction,
    previous_enrichment: [],
    cast: DEFAULT_CAST,
    ...overrides,
  };
}

/** A minimal PDF header, enough for the engine's magic-byte check. */
export const FAKE_PDF = new TextEncoder().encode('%PDF-1.7\n% demo\n');

export function makeDeps(
  llm: LlmClient,
  overrides: Partial<StepDeps> = {},
  settings: AiSettings = DEFAULT_AI_SETTINGS,
): StepDeps {
  let tick = 0;
  return {
    llm,
    settings,
    loadUpload: () => Promise.resolve({ bytes: FAKE_PDF, mime: 'application/pdf' }),
    now: () => new Date(Date.UTC(2026, 9, 12, 12, 0, 0, (tick += 5))),
    ...overrides,
  };
}

export interface JobRun<K extends JobKind> {
  state: JobState;
  steps: string[];
  usage: UsageRecord[];
  result: EngineResult[K] | undefined;
}

/** Runs a job to the end like the client does: one step at a time, the state passed through JSON each time. */
export async function runJobToEnd<K extends JobKind>(
  engine: JobEngine,
  kind: K,
  input: JobInput[K],
  deps: StepDeps,
  options: { serialise?: boolean; maxSteps?: number } = {},
): Promise<JobRun<K>> {
  let state = emptyJobState();
  const steps: string[] = [];
  const usage: UsageRecord[] = [];
  let result: EngineResult[K] | undefined;
  const limit = options.maxSteps ?? 80;
  for (let i = 0; i < limit; i += 1) {
    const step = engine.nextStep(kind, input, state);
    if (step === null) return { state, steps, usage, result };
    const outcome = await engine.runStep({ kind, input, state, step }, deps);
    steps.push(step);
    usage.push(...outcome.usage);
    if (outcome.result !== undefined) result = outcome.result;
    const next: JobState = { outputs: { ...state.outputs, [step]: outcome.output } };
    state = options.serialise === false ? next : (JSON.parse(JSON.stringify(next)) as JobState);
  }
  throw new Error(`job did not finish in ${limit} steps (${steps.join(', ')})`);
}

export interface ScriptedCall {
  request: LlmRequest<unknown>;
}

/**
 * A scripted model for tests: `handler` sees every request (and its zero-based call number) and returns a value,
 * or throws an LlmError. The value is validated with the request's schema like the real adapter does.
 */
export function scriptedLlm(
  handler: (request: LlmRequest<unknown>, call: number) => unknown,
  calls: ScriptedCall[] = [],
): LlmClient {
  return {
    generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      calls.push({ request: request as LlmRequest<unknown> });
      try {
        const value = handler(request as LlmRequest<unknown>, calls.length - 1);
        const parsed = request.schema.parse(value);
        return Promise.resolve({
          value: parsed,
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_tokens: 0,
            cache_creation_tokens: 0,
          },
          model: 'scripted-test-model',
          stopReason: 'end_turn',
        });
      } catch (error) {
        return Promise.reject(error);
      }
    },
  };
}

export { goldenUnit2, marketDayMathsUnit, p1BasicScienceTerm1 };
