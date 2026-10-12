// The moderation classifier: one structured call that rates the child's (already redacted) message in the eight
// categories of the contract. It runs in parallel with the tutor call; the pipeline holds the tutor's tokens until
// this verdict (or this failure) arrives.
//
// It never throws. A failed call returns `verdict: null` and the router fails closed. A call the API answered and
// billed (a refusal, a reply that failed the schema) still returns its usage, so the budgets count it.
import type { LlmClient, UsageRecord } from '@custar/authoring-core';
import type { Stage } from '@custar/content-schema';
import { ModerationVerdict } from '../contract';
import { fenceData, fenceTurns } from '../prompt/fence';
import { redactPii } from '../redact';
import { describeFailure, usageRecord, usageRecordOfError } from '../usage';
import type { FailureInfo } from '../usage';
import { CLASSIFIER_SYSTEM, stageNote } from './classifierPrompt';

export const CLASSIFIER_LABEL = 'tutor:moderation';
export const CLASSIFIER_MAX_TOKENS = 600;
/** How many earlier turns the classifier reads: enough for "yes" to mean something, little enough to be cheap. */
export const CLASSIFIER_CONTEXT_TURNS = 4;

export interface ClassifyInput {
  /** The child's message AFTER redaction. Raw text must never be passed in. */
  redactedText: string;
  recentTurns: readonly { role: 'child' | 'tutor'; text: string }[];
  stage: Stage;
  /** Real names, so the reviewer's summary cannot repeat one. */
  knownNames?: readonly string[];
  signal?: AbortSignal;
  now?: () => Date;
}

export interface ClassifyResult {
  verdict: ModerationVerdict | null;
  /** Zero or one record: the call, when it was billed. */
  usage: UsageRecord[];
  error?: FailureInfo;
}

const fixedClock = (): Date => new Date(0);

export async function classifyMessage(llm: LlmClient, input: ClassifyInput): Promise<ClassifyResult> {
  const now = input.now ?? fixedClock;
  const turns = input.recentTurns.slice(-CLASSIFIER_CONTEXT_TURNS);
  const blocks = [`The child's stage: ${stageNote(input.stage)}.`];
  if (turns.length > 0) blocks.push(`Earlier messages, oldest first:\n${fenceTurns('earlier', turns)}`);
  blocks.push(`The message to rate:\n${fenceData('child_message', input.redactedText)}`);

  const started = now().getTime();
  try {
    const result = await llm.generate({
      task: 'moderation',
      label: CLASSIFIER_LABEL,
      system: [{ text: CLASSIFIER_SYSTEM, cache: true }],
      messages: [{ role: 'user', content: blocks.join('\n\n') }],
      schema: ModerationVerdict,
      schemaName: 'ModerationVerdict',
      effort: 'low',
      maxTokens: CLASSIFIER_MAX_TOKENS,
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const names = input.knownNames ?? [];
    // The summary is for a reviewer and is stored: it must not carry personal data even if the model repeated some.
    const summary = redactPii(result.value.summary, { knownNames: names }).text.slice(0, 300);
    return {
      verdict: { ...result.value, summary },
      usage: [
        usageRecord({
          label: CLASSIFIER_LABEL,
          task: 'moderation',
          model: result.model,
          usage: result.usage,
          stopReason: result.stopReason,
          startedMs: started,
          endedMs: now().getTime(),
        }),
      ],
    };
  } catch (error) {
    const billed = usageRecordOfError(error, {
      label: CLASSIFIER_LABEL,
      task: 'moderation',
      startedMs: started,
      endedMs: now().getTime(),
    });
    return { verdict: null, usage: billed ? [billed] : [], error: describeFailure(error) };
  }
}
