// Shared helpers for the pipeline tests. Not shipped; imports the authoring-core fakes (FakeLlm).
import { DEFAULT_CAST } from '@custar/authoring-core';
import { FakeLlm } from '@custar/authoring-core/fakes';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { DEFAULT_TUTOR_SETTINGS } from '../src/contract';
import type {
  ModerationVerdict,
  TutorStreamEvent,
  TutorTurnDeps,
  TutorTurnOutcome,
  TutorTurnRun,
} from '../src/contract';
import { ScriptedTutorLlm } from '../src/fakes/scriptedTutorLlm';
import type { TutorScript } from '../src/fakes/scriptedTutorLlm';
import { OUTPUT_CHECK_LABEL } from '../src/pipeline/outputCheck';
import type { TutorTurnRunInput } from '../src/pipeline/prepare';
import { buildGrounding, buildMasteryGuard } from '../src/prompt/grounding';
import { CLASSIFIER_LABEL } from '../src/safety/classifier';

export const GROUNDING = buildGrounding(goldenUnit2, {
  versionNo: 1,
  unitId: '11111111-1111-4111-8111-111111111111',
});

export const IDS = {
  session_id: '22222222-2222-4222-8222-222222222222',
  message_id: '33333333-3333-4333-8333-333333333333',
};

export const NONE: ModerationVerdict = {
  self_harm: 'none',
  abuse_disclosure: 'none',
  distress: 'none',
  sexual: 'none',
  violence: 'none',
  personal_info_shared: 'none',
  jailbreak: 'none',
  off_topic: 'none',
  summary: 'An ordinary lesson question.',
};

export const verdict = (patch: Partial<ModerationVerdict> = {}): ModerationVerdict => ({
  ...NONE,
  ...patch,
});

export function makeInput(patch: Partial<TutorTurnRunInput> = {}): TutorTurnRunInput {
  return {
    child: { alias: 'Star', level_code: 'P1', stage: 'connect', reading_mode: 'reader' },
    grounding: GROUNDING,
    position: { section_id: 'places_in_school' },
    history: [],
    message: { mode: 'text', text: 'where do we cook' },
    helper_present: false,
    cast: DEFAULT_CAST,
    ids: IDS,
    mastery_guard: buildMasteryGuard(goldenUnit2),
    ...patch,
  };
}

export interface Rig {
  llm: FakeLlm;
  tutor: ScriptedTutorLlm;
  deps: TutorTurnDeps;
}

export interface RigOptions {
  tutorScript?: TutorScript;
  settings?: Partial<TutorTurnDeps['settings']>;
  signal?: AbortSignal;
}

/** A pipeline with a fake classifier/output-check client (nothing scripted yet) and a scripted tutor. */
export function makeRig(options: RigOptions = {}): Rig {
  const llm = new FakeLlm();
  const tutor = new ScriptedTutorLlm(options.tutorScript ?? []);
  let tick = 0;
  const deps: TutorTurnDeps = {
    llm,
    tutorLlm: tutor,
    settings: { ...DEFAULT_TUTOR_SETTINGS, enabled: true, ...options.settings },
    now: () => new Date((tick += 10)),
    ...(options.signal ? { signal: options.signal } : {}),
  };
  return { llm, tutor, deps };
}

/** Scripts the classifier (and the output check, approving by default). */
export function script(
  rig: Rig,
  verdictValue: ModerationVerdict | Error,
  check: { ok: boolean } | Error = { ok: true },
): void {
  rig.llm.on(CLASSIFIER_LABEL, verdictValue);
  rig.llm.on(
    OUTPUT_CHECK_LABEL,
    check instanceof Error ? check : { ok: check.ok, reason: check.ok ? 'none' : 'unsafe_content' },
  );
}

export interface Collected {
  events: TutorStreamEvent[];
  outcome: TutorTurnOutcome;
  text: string;
}

export async function collect(run: TutorTurnRun): Promise<Collected> {
  const events: TutorStreamEvent[] = [];
  for await (const event of run.events) events.push(event);
  const outcome = await run.outcome;
  let text = '';
  for (const event of events) {
    if (event.type === 'delta') text += event.text;
    else if (event.type === 'replace') text = event.text;
  }
  return { events, outcome, text };
}

export const types = (events: TutorStreamEvent[]): string[] => events.map((event) => event.type);
