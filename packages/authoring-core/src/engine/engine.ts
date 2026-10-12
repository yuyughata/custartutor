// createJobEngine: the JobEngine of the contract. Dispatches by job kind to the step modules.
import type { z } from 'zod';
import { formatZodIssues } from '@custar/content-schema';
import {
  CastTraits,
  ChapterPlanInput,
  SchemeIngestInput,
  StepError,
  UnitGenerateInput,
  UnitReviseInput,
  type CastMember,
  type JobEngine,
  type JobInput,
  type JobKind,
  type JobProgress,
  type JobState,
  type StepDeps,
  type StepOutcome,
} from '../contract';
import { PLAN_STEPS, runGroup, runTitle } from './chapterPlan';
import { INGEST_STEPS, runCheck, runExtract } from './schemeIngest';
import { nextUnitStep, runUnitGenerateStep, unitProgress } from './unitGenerate';
import { nextReviseStep, reviseProgress, runUnitReviseStep } from './unitRevise';
import { isRecord } from './util';

function describeIssues(error: z.ZodError): string {
  const issues = formatZodIssues(error)
    .slice(0, 8)
    .map((issue) => `${issue.path === '' ? '(root)' : issue.path}: ${issue.message}`);
  return issues.join('; ');
}

/** Checks the cast (the contract types it loosely) and fills the defaults of its traits. */
export function normalizeCast(cast: readonly unknown[]): CastMember[] {
  return cast.map((member, index) => {
    if (
      !isRecord(member) ||
      typeof member['slug'] !== 'string' ||
      typeof member['name'] !== 'string'
    ) {
      throw new StepError('input', 'invalid_input', `cast[${index}] needs a slug and a name.`, {
        retryable: false,
      });
    }
    const traits = CastTraits.safeParse(member['traits'] ?? {});
    if (!traits.success) {
      throw new StepError(
        'input',
        'invalid_input',
        `cast[${index}].traits: ${describeIssues(traits.error)}`,
        { retryable: false },
      );
    }
    const voice = isRecord(member['voice']) ? (member['voice'] as CastMember['voice']) : {};
    return { slug: member['slug'], name: member['name'], traits: traits.data, voice };
  });
}

function parseWith<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw new StepError(
      'input',
      'invalid_input',
      `Invalid job input: ${describeIssues(parsed.error)}`,
      { retryable: false },
    );
  }
  return parsed.data;
}

function firstMissing(steps: readonly string[], state: JobState): string | null {
  return steps.find((step) => state.outputs[step] === undefined) ?? null;
}

function simpleProgress(steps: readonly string[], state: JobState): JobProgress {
  return {
    done: steps.filter((step) => state.outputs[step] !== undefined),
    next: firstMissing(steps, state),
    total: steps.length,
  };
}

export function createJobEngine(): JobEngine {
  return {
    parseInput<K extends JobKind>(kind: K, input: unknown): JobInput[K] {
      switch (kind) {
        case 'scheme_ingest':
          return parseWith(SchemeIngestInput, input) as JobInput[K];
        case 'chapter_plan': {
          const parsed = parseWith(ChapterPlanInput, input);
          return { ...parsed, cast: normalizeCast(parsed.cast) } as JobInput[K];
        }
        case 'unit_generate': {
          const parsed = parseWith(UnitGenerateInput, input);
          return { ...parsed, cast: normalizeCast(parsed.cast) } as JobInput[K];
        }
        case 'unit_revise': {
          const parsed = parseWith(UnitReviseInput, input);
          if (!isRecord(parsed.base_content)) {
            throw new StepError(
              'input',
              'invalid_input',
              'Invalid job input: base_content must be a unit object.',
              { retryable: false },
            );
          }
          return { ...parsed, cast: normalizeCast(parsed.cast) } as JobInput[K];
        }
        default:
          throw new StepError('input', 'invalid_input', `Unknown job kind "${String(kind)}".`, {
            retryable: false,
          });
      }
    },

    nextStep<K extends JobKind>(kind: K, input: JobInput[K], state: JobState): string | null {
      switch (kind) {
        case 'scheme_ingest':
          return firstMissing(INGEST_STEPS, state);
        case 'chapter_plan':
          return firstMissing(PLAN_STEPS, state);
        case 'unit_generate':
          return nextUnitStep(input as JobInput['unit_generate'], state);
        case 'unit_revise':
          return nextReviseStep(state);
        default:
          return null;
      }
    },

    progress<K extends JobKind>(kind: K, input: JobInput[K], state: JobState): JobProgress {
      switch (kind) {
        case 'scheme_ingest':
          return simpleProgress(INGEST_STEPS, state);
        case 'chapter_plan':
          return simpleProgress(PLAN_STEPS, state);
        case 'unit_generate':
          return unitProgress(input as JobInput['unit_generate'], state);
        case 'unit_revise':
          return reviseProgress(state);
        default:
          return { done: [], next: null, total: 0 };
      }
    },

    async runStep<K extends JobKind>(
      call: { kind: K; input: JobInput[K]; state: JobState; step: string },
      deps: StepDeps,
    ): Promise<StepOutcome<K>> {
      const { kind, state, step } = call;
      try {
        switch (kind) {
          case 'scheme_ingest': {
            const input = call.input as JobInput['scheme_ingest'];
            if (step === 'extract') return (await runExtract(input, deps)) as StepOutcome<K>;
            if (step === 'check') return runCheck(input, state) as StepOutcome<K>;
            break;
          }
          case 'chapter_plan': {
            const input = call.input as JobInput['chapter_plan'];
            if (step === 'group') return runGroup(input) as StepOutcome<K>;
            if (step === 'title') return (await runTitle(input, state, deps)) as StepOutcome<K>;
            break;
          }
          case 'unit_generate':
            return (await runUnitGenerateStep(
              { input: call.input as JobInput['unit_generate'], state, step },
              deps,
            )) as StepOutcome<K>;
          case 'unit_revise':
            return (await runUnitReviseStep(
              { input: call.input as JobInput['unit_revise'], state, step },
              deps,
            )) as StepOutcome<K>;
          default:
            break;
        }
      } catch (error) {
        if (error instanceof StepError) throw error;
        const message = error instanceof Error ? error.message : String(error);
        throw new StepError(step, 'internal', message, { retryable: false, cause: error });
      }
      throw new StepError(step, 'internal', `Unknown step "${step}" for ${String(kind)}.`, {
        retryable: false,
      });
    },
  };
}
