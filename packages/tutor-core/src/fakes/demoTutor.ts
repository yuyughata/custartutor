// The demo tutor's "model": scripted, deterministic, and impossible to mistake for Claude. It is used by the
// learner app's demo mode. It runs behind the REAL pipeline (redaction, patterns, router, sanitiser), so the demo
// screens show the real safety behaviour; only the two model calls are replaced:
//   - the tutor's reply is a line taken from the unit's own Tutor Lite script (or its objective), prefixed so a
//     reader can see it is a demo;
//   - the "classifier" is the deterministic pattern list: it knows nothing a pattern does not, and says so.
import { sectionsOf } from '@custar/content-schema';
import type { UnitContent } from '@custar/content-schema';
import type { LlmClient, LlmRequest, LlmResult } from '@custar/authoring-core';
import type { ModerationVerdict, TutorLlm, TutorLlmEvent } from '../contract';
import { SEVERITY_RANK, detectGuardPatterns, detectSafetyPatterns } from '../safety/patterns';
import type { SafetyHit } from '../safety/patterns';
import { SCRIPTED_USAGE, doneStep, textSteps } from './scriptedTutorLlm';

export const DEMO_TUTOR_MODEL_ID = 'demo-scripted-tutor';
export const DEMO_REPLY_PREFIX = 'Demo tutor (not Claude):';

const NO_USAGE = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
};

function firstSentence(text: string, max: number): string {
  const sentence = /^[^.!?]*[.!?]?/.exec(text.trim())?.[0] ?? text;
  const cut =
    sentence.length > max ? `${sentence.slice(0, max).replace(/\s+\S*$/, '')}.` : sentence;
  return cut.trim();
}

/** The lines of the tutor script of a section (or of the first section that has one). */
export function demoLines(
  unit: UnitContent,
  sectionId?: string,
): { say: string[]; hint: string[] } {
  const scripts = sectionsOf(unit).filter((section) => section.tutor_script !== undefined);
  const chosen = scripts.find((section) => section.id === sectionId) ?? scripts[0];
  const nodes =
    chosen?.tutor_script?.nodes ??
    ('tutor_script' in unit ? unit.tutor_script?.nodes : undefined) ??
    [];
  return {
    say: nodes.map((node) => node.say),
    hint: nodes.flatMap((node) => node.hint),
  };
}

export interface DemoReplyInput {
  unit: UnitContent;
  sectionId?: string;
  /** How many tutor replies this session has had, so the lines come round in order. */
  turnIndex: number;
  childText: string;
}

export function demoReplyText(input: DemoReplyInput): string {
  const { say, hint } = demoLines(input.unit, input.sectionId);
  const wantsHint = /\b(hint|help|stuck|clue)\b/i.test(input.childText);
  let body: string;
  if (wantsHint && hint.length > 0) body = hint[input.turnIndex % hint.length] as string;
  else if (say.length > 0) body = say[input.turnIndex % say.length] as string;
  else
    body = `We are learning this: ${firstSentence(input.unit.header.objective, 140)} What do you think?`;
  return `${DEMO_REPLY_PREFIX} ${body.replace(/\*\*/g, '')}`;
}

/** A TutorLlm that "says" a fixed reply. */
export function createDemoTutorLlm(replyText: string): TutorLlm {
  return {
    async *stream(request): AsyncGenerator<TutorLlmEvent> {
      if (request.signal?.aborted) return;
      for (const step of textSteps(replyText, 24)) yield step;
      yield doneStep({ model: DEMO_TUTOR_MODEL_ID, usage: { ...SCRIPTED_USAGE, ...NO_USAGE } });
    },
  };
}

const NONE: ModerationVerdict = {
  self_harm: 'none',
  abuse_disclosure: 'none',
  distress: 'none',
  sexual: 'none',
  violence: 'none',
  personal_info_shared: 'none',
  jailbreak: 'none',
  off_topic: 'none',
  summary: 'Demo: rated by the pattern list only.',
};

/** What the pattern list alone can say about a message, in the shape of the classifier's verdict. */
export function demoVerdict(hits: readonly SafetyHit[]): ModerationVerdict {
  const verdict = { ...NONE };
  for (const hit of hits) {
    if (SEVERITY_RANK[hit.severity] > SEVERITY_RANK[verdict[hit.category]]) {
      verdict[hit.category] = hit.severity;
    }
  }
  return verdict;
}

export function demoHits(rawText: string): SafetyHit[] {
  return [...detectSafetyPatterns(rawText), ...detectGuardPatterns(rawText)];
}

/** A moderation client for the demo: rates by pattern list, approves every output. Not a model. */
export function createDemoModerationLlm(rawText: string): LlmClient {
  const verdict = demoVerdict(demoHits(rawText));
  return {
    async generate<T>(request: LlmRequest<T>): Promise<LlmResult<T>> {
      const raw =
        request.schemaName === 'ModerationVerdict' ? verdict : { ok: true, reason: 'none' };
      return {
        value: request.schema.parse(raw),
        usage: NO_USAGE,
        model: DEMO_TUTOR_MODEL_ID,
        stopReason: 'end_turn',
      };
    },
  };
}
