// The ONE file that imports the content engine's demo parts from @custar/authoring-core: the step engine, the
// fixture-backed STAND-IN model and the in-memory job API. Everything else in the admin app is written against
// the contract types, so when those pieces change only this file needs to follow.
//
// The stand-in model is NOT Claude. It replays prepared fixtures and reports the model id below; the app shows
// that id next to every draft and a permanent DEMO banner on every screen.
import type { JobApi, UsageRecord } from '@custar/authoring-core';
import { createJobEngine } from '@custar/authoring-core';
import { createDemoLlm, createInMemoryJobApi } from '@custar/authoring-core/fakes';
import type { DemoJobHooks } from './jobHooks';

/** A job API that can also report every model call it has seen (for the demo usage panel). */
export type DemoJobApi = JobApi & { usage?(): UsageRecord[] };

/** Each step waits this long, so the progress list is visible in the browser. */
export const DEMO_STEP_DELAY_MS = 120;

export function createDemoJobApi(
  hooks: DemoJobHooks,
  options: { stepDelayMs?: number } = {},
): DemoJobApi {
  return createInMemoryJobApi({
    engine: createJobEngine(),
    llm: createDemoLlm(),
    resolveInput: hooks.resolveInput,
    settings: hooks.settings,
    loadUpload: hooks.loadUpload,
    onSucceeded: hooks.onSucceeded,
    now: hooks.now,
    stepDelayMs: options.stepDelayMs ?? DEMO_STEP_DELAY_MS,
  });
}
