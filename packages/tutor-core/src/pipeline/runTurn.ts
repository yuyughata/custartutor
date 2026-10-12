// The tutor turn pipeline (ADR 0008). `runTutorTurn` NEVER throws and never rejects: every failure becomes a
// status and an `error` event. Order of work:
//
//   1. redact the child's message (the only text any model or store may see)
//   2. if the deterministic patterns already force a fixed safe reply: send it, call NO model at all
//   3. otherwise start the moderation classifier AND the tutor stream together, and HOLD the tutor's tokens
//   4. when the verdict (or the classifier's failure) arrives, route it:
//        safe_reply / blocked / redirect -> abort the tutor stream, send the fixed reply
//        allow / steer                   -> release the held tokens through the stream sanitiser
//   5. after the stream: sanitise the whole reply, run the output check, validate the tools
//   6. a rejected or failed reply is REPLACED by the fixed redirect text
// Deterministic given its dependencies: the clock is `deps.now`, there is no randomness.
import { LlmError } from '@custar/authoring-core';
import type {
  SafetyDecision,
  TutorStreamEvent,
  TutorTurnDeps,
  TutorTurnOutcome,
  TutorTurnRun,
} from '../contract';
import { buildTutorRequest } from '../prompt/system';
import { TUTOR_RULES_TEXT, maxReplyChars } from '../prompt/rules';
import { classifyMessage } from '../safety/classifier';
import { sameText } from '../safety/cleanReply';
import { fixedReplyKey, routeSafety } from '../safety/router';
import { sanitizeReply } from '../safety/sanitize';
import type { SanitizeOptions } from '../safety/sanitize';
import { createStreamSanitizer } from '../safety/streamSanitizer';
import { createEventQueue } from './channel';
import { chunkReply, fixedReplyText } from './fixedReply';
import { checkOutput } from './outputCheck';
import { prepareTurn } from './prepare';
import type { TutorTurnRunInput } from './prepare';
import { NIL_UUID, NO_CONCERN, newState, toOutcome } from './state';
import type { TurnState } from './state';
import { validateToolCalls } from './toolCalls';
import type { ToolCallInput } from './toolCalls';
import { startTutorRun } from './tutorRun';
import type { TutorRun } from './tutorRun';

type Emit = (event: TutorStreamEvent) => void;

export function runTutorTurn(deps: TutorTurnDeps, input: TutorTurnRunInput): TutorTurnRun {
  const queue = createEventQueue<TutorStreamEvent>();
  const outcome = execute(deps, input, (event) => queue.push(event)).finally(() => queue.close());
  return { events: queue, outcome };
}

async function execute(
  deps: TutorTurnDeps,
  input: TutorTurnRunInput,
  emit: Emit,
): Promise<TutorTurnOutcome> {
  let state: TurnState | null = null;
  try {
    state = newState(prepareTurn(input));
    await drive(deps, input, state, emit);
  } catch {
    // a bug must not reach the child as an exception: it is a calm failure
    state ??= newState({
      redaction: { text: '', count: 0, kinds: [] },
      childText: '',
      history: [],
      child: input.child,
      knownNames: [],
      safetyHits: [],
      patternHits: [],
      unclear: false,
      remindPrivacy: false,
    });
    state.status = 'failed';
    state.errorCode = 'internal';
    state.reply = null;
    emit({ type: 'error', code: 'internal', retryable: false });
  }
  return toOutcome(state);
}

function isTruncation(stopReason: string | null): boolean {
  return stopReason === 'max_tokens' || stopReason === 'model_context_window_exceeded';
}

async function drive(
  deps: TutorTurnDeps,
  input: TutorTurnRunInput,
  state: TurnState,
  emit: Emit,
): Promise<void> {
  const { settings, now } = deps;
  const prepared = state.prepared;
  const messageId = input.ids?.message_id ?? NIL_UUID;
  if (input.ids)
    emit({ type: 'meta', session_id: input.ids.session_id, message_id: input.ids.message_id });
  const finish = (): void => emit({ type: 'done', message_id: messageId });

  const fail = (retryable: boolean): void => {
    state.status = 'failed';
    state.errorCode = 'upstream';
    state.reply = null;
    emit({ type: 'error', code: 'upstream', retryable });
  };
  const sendFixed = (decision: SafetyDecision): void => {
    const key = fixedReplyKey(decision);
    if (key === null) return;
    const text = fixedReplyText(settings, key);
    emit({ type: 'safety', action: decision.action });
    for (const chunk of chunkReply(text)) emit({ type: 'delta', text: chunk });
    state.reply = text;
    state.status = decision.action === 'safe_reply' ? 'safe_reply' : 'blocked';
    finish();
  };
  const replace = (
    reason: 'safety' | 'filter',
    text = fixedReplyText(settings, 'redirect'),
  ): void => {
    emit({ type: 'replace', text, reason });
    state.reply = text;
    state.status = 'replaced';
  };

  if (deps.signal?.aborted) return fail(true);

  // 2. the patterns alone force a fixed reply: the crisis path has no model in it
  const forced = routeSafety({ verdict: NO_CONCERN, patternHits: prepared.safetyHits, settings });
  if (forced.action === 'safe_reply') {
    state.decision = forced;
    return sendFixed(forced);
  }

  // 3. classifier and tutor stream together
  const classifying = classifyMessage(deps.llm, {
    redactedText: prepared.childText,
    recentTurns: prepared.history,
    stage: prepared.child.stage,
    knownNames: prepared.knownNames,
    now,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const startTutor = (steer: boolean, remindPrivacy: boolean): TutorRun =>
    startTutorRun(
      deps.tutorLlm,
      buildTutorRequest({
        turn: { ...input, child: prepared.child },
        childText: prepared.childText,
        history: prepared.history,
        settings,
        steer,
        remindPrivacy,
      }),
      { signal: deps.signal, now },
    );
  let remind = prepared.remindPrivacy;
  let run = startTutor(false, remind);
  const takeUsage = (finished: TutorRun): void => {
    const record = finished.usage();
    if (record) state.tutorUsage.push(record);
  };

  // 4. the verdict arrives; nothing of the tutor's reply has been shown yet
  const classified = await classifying;
  state.verdict = classified.verdict;
  state.classifierUsage = classified.usage;
  const decision = routeSafety({
    verdict: classified.verdict,
    patternHits: prepared.patternHits,
    settings,
    unclear: prepared.unclear,
  });
  state.decision = decision;

  if (
    decision.action === 'safe_reply' ||
    decision.action === 'blocked' ||
    decision.action === 'redirect'
  ) {
    run.abort();
    await run.settled;
    takeUsage(run);
    return sendFixed(decision);
  }
  if (decision.action !== 'allow') emit({ type: 'safety', action: decision.action });

  // The steer note and the privacy reminder are per-turn instructions the first call did not have: ask again.
  const verdictShared =
    classified.verdict !== null && classified.verdict.personal_info_shared !== 'none';
  const needSteer = decision.action === 'steer';
  const needRemind = !remind && verdictShared;
  if (needSteer || needRemind) {
    run.abort();
    await run.settled;
    takeUsage(run);
    remind = remind || needRemind;
    run = startTutor(needSteer, remind);
  }

  // 5. release the held tokens through the stream sanitiser
  const sanitizeOptions: SanitizeOptions = {
    maxChars: Math.min(
      maxReplyChars(prepared.child.stage, prepared.child.reading_mode),
      settings.max_reply_tokens * 4,
    ),
    knownNames: prepared.knownNames,
    castNames: input.cast.map((member) => member.name),
    protectedText: [TUTOR_RULES_TEXT],
    ...(input.mastery_guard ? { masteryGuard: input.mastery_guard } : {}),
  };
  const sanitizer = createStreamSanitizer(sanitizeOptions);
  const calls: ToolCallInput[] = [];
  let stopReason: string | null = null;
  let failure: unknown = null;
  try {
    for await (const event of run.events) {
      if (event.type === 'text') {
        const step = sanitizer.push(event.text);
        if (step.text !== '') emit({ type: 'delta', text: step.text });
        if (step.done) {
          run.abort();
          break;
        }
      } else if (event.type === 'tool') {
        calls.push({ name: event.name, input: event.input });
      } else {
        stopReason = event.stopReason;
      }
    }
  } catch (error) {
    failure = error;
  }
  if (!sanitizer.rejected && !sanitizer.done) {
    const last = sanitizer.end({ truncated: failure !== null || isTruncation(stopReason) });
    if (last.text !== '') emit({ type: 'delta', text: last.text });
  }
  await run.settled;
  takeUsage(run);
  state.model = run.model();

  if (sanitizer.rejected) {
    replace('filter');
    return finish();
  }
  if (failure instanceof LlmError && failure.code === 'refusal') {
    replace('safety');
    return finish();
  }
  if (failure !== null && sanitizer.released === '') {
    state.model = null;
    return fail(failure instanceof LlmError ? failure.retryable : false);
  }

  // 6. the whole reply, once more; then the output check
  state.status = 'complete';
  state.reply = sanitizer.released;
  const whole = sanitizeReply(sanitizer.released, sanitizeOptions);
  if (whole.rejected || whole.text === '') {
    replace('filter');
    return finish();
  }
  if (!sameText(whole.text, sanitizer.released)) {
    replace('filter', whole.text);
  }
  if (settings.output_check || classified.verdict === null) {
    const check = await checkOutput(deps.llm, {
      childText: prepared.childText,
      reply: whole.text,
      masteryPrompts: input.grounding.mastery_prompts,
      now,
      ...(deps.signal ? { signal: deps.signal } : {}),
    });
    state.checkUsage = check.usage;
    if (!check.ok) {
      replace('safety');
      return finish();
    }
  }

  // 7. advisory tools, after every check has passed
  const tools = validateToolCalls(calls, input.grounding, prepared.knownNames);
  state.showActivity = tools.show_activity;
  state.evidence = tools.evidence;
  if (tools.show_activity)
    emit({ type: 'tool', name: 'show_activity', input: tools.show_activity });
  finish();
}
