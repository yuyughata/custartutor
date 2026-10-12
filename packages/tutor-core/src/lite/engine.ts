// Tutor Lite: the reviewed `tutor_script` of a section, run on the device with no model and no network.
//
// Pure and deterministic: the same state and reply always give the same step; line variety comes from cursors
// kept in the (JSON-serialisable) state, never from randomness, so a restart resumes exactly. Nodes run in order
// unless `next` jumps. A node that `expect`s a reply grades it with the referenced question (offline grader of
// content-schema) or against the accepted answers (same matching as fill-in-the-blank). A child is never stuck:
// the second miss offers the hint, the third moves on. Lite never grants mastery: it only reports `graded`.
import { gradeQuestion } from '@custar/content-schema';
import type { Question, TutorNode, TutorScript } from '@custar/content-schema';
import type { TutorLiteLine, TutorLiteState, TutorLiteStep } from '../contract';
import { isNegativeSelfReport, matchesAccepted } from './match';
import { toResponse } from './response';

/** The only line Lite writes itself: the script has run out. */
export const LITE_WRAP_TEXT = 'Well done! That is the end of our chat for now.';
export const MAX_REPLY_CHARS = 500;
const MAX_AUTO_STEPS = 60;

export interface TutorLiteOptions {
  /** The unit's questions, for nodes that grade with `expect.question_id`. */
  questions: Readonly<Record<string, Question>>;
  /** A miss at which the hint is offered (default 2). */
  hintAfterMisses?: number;
  /** A miss at which the script moves on (default 3). */
  moveOnAfterMisses?: number;
}

export interface TutorLiteContext extends TutorLiteOptions {
  script: TutorScript;
}

export function initialLiteState(): TutorLiteState {
  return { node_id: null, attempts: 0, hints_used: 0, cursors: {}, finished: false };
}

const clone = (state: TutorLiteState): TutorLiteState => ({
  ...state,
  cursors: { ...state.cursors },
});

function nodeById(script: TutorScript, id: string | null): TutorNode | undefined {
  return id === null ? undefined : script.nodes.find((node) => node.id === id);
}

function nodeAfter(script: TutorScript, node: TutorNode): TutorNode | undefined {
  if (node.next !== undefined) return nodeById(script, node.next);
  const index = script.nodes.indexOf(node);
  return index === -1 ? undefined : script.nodes[index + 1];
}

/** The next line of a list, by cursor: the cursor moves on every use and wraps around. */
function pick(
  state: TutorLiteState,
  node: TutorNode,
  list: readonly string[],
  kind: 'correct' | 'incorrect' | 'hint',
): string | null {
  if (list.length === 0) return null;
  const key = `${node.id}:${kind}`;
  const index = state.cursors[key] ?? 0;
  state.cursors[key] = index + 1;
  return list[index % list.length] as string;
}

function line(node: TutorNode, text: string, kind: TutorLiteLine['kind']): TutorLiteLine {
  return { node_id: node.id, text, kind };
}

/** Says `first` and every node after it that waits for nothing, until a node waits for a reply or the script ends. */
function enter(
  ctx: TutorLiteContext,
  state: TutorLiteState,
  first: TutorNode | undefined,
  lines: TutorLiteLine[],
): boolean {
  const seen = new Set<string>();
  let node = first;
  while (node !== undefined && seen.size < MAX_AUTO_STEPS && !seen.has(node.id)) {
    seen.add(node.id);
    lines.push(line(node, node.say, 'say'));
    if (node.expect !== undefined) {
      state.node_id = node.id;
      state.attempts = 0;
      state.hints_used = 0;
      return true;
    }
    node = nodeAfter(ctx.script, node);
  }
  state.node_id = null;
  state.finished = true;
  lines.push({
    node_id: lines[lines.length - 1]?.node_id ?? '',
    text: LITE_WRAP_TEXT,
    kind: 'wrap',
  });
  return false;
}

type Verdict = { kind: 'graded'; correct: boolean } | { kind: 'self'; positive: boolean };

function evaluate(node: TutorNode, reply: string, ctx: TutorLiteContext): Verdict {
  const expect = node.expect;
  if (expect?.accepted !== undefined) {
    return { kind: 'graded', correct: matchesAccepted(reply, expect.accepted) };
  }
  const question =
    expect?.question_id === undefined ? undefined : ctx.questions[expect.question_id];
  if (question !== undefined) {
    const response = toResponse(question, reply);
    if (response !== null) {
      const graded = gradeQuestion(question, response);
      if (graded.result !== 'ungraded')
        return { kind: 'graded', correct: graded.result === 'correct' };
    }
  }
  // not gradable from a typed line (a drawing, free text, a missing question): the child's own word counts
  return { kind: 'self', positive: !isNegativeSelfReport(reply) };
}

const step = (
  state: TutorLiteState,
  lines: TutorLiteLine[],
  expecting: boolean,
  graded: TutorLiteStep['graded'],
): TutorLiteStep => ({
  state,
  lines,
  expecting,
  graded,
});

export function startLite(script: TutorScript, options: TutorLiteOptions): TutorLiteStep {
  const ctx: TutorLiteContext = { ...options, script };
  const state = initialLiteState();
  const lines: TutorLiteLine[] = [];
  const expecting = enter(ctx, state, script.nodes[0], lines);
  return step(state, lines, expecting, null);
}

export function replyLite(
  previous: TutorLiteState,
  text: string,
  ctx: TutorLiteContext,
): TutorLiteStep {
  const node = previous.finished ? undefined : nodeById(ctx.script, previous.node_id);
  if (node === undefined || node.expect === undefined)
    return step(clone(previous), [], false, null);
  if (text.trim() === '') return step(clone(previous), [], true, null);

  const state = clone(previous);
  const lines: TutorLiteLine[] = [];
  const verdict = evaluate(node, text.slice(0, MAX_REPLY_CHARS), ctx);
  const good = verdict.kind === 'graded' ? verdict.correct : verdict.positive;
  const graded = verdict.kind === 'graded' ? { correct: verdict.correct } : null;

  if (good) {
    const said = pick(state, node, node.on_correct, 'correct');
    if (said !== null) lines.push(line(node, said, 'correct'));
    const expecting = enter(ctx, state, nodeAfter(ctx.script, node), lines);
    return step(state, lines, expecting, graded);
  }

  state.attempts += 1;
  const hintAt = ctx.hintAfterMisses ?? 2;
  const moveAt = ctx.moveOnAfterMisses ?? 3;
  const said = pick(state, node, node.on_incorrect, 'incorrect');
  if (said !== null) lines.push(line(node, said, 'incorrect'));
  if (state.attempts >= moveAt) {
    const expecting = enter(ctx, state, nodeAfter(ctx.script, node), lines);
    return step(state, lines, expecting, graded);
  }
  if (state.attempts >= hintAt) {
    const hint = pick(state, node, node.hint, 'hint');
    if (hint !== null) {
      lines.push(line(node, hint, 'hint'));
      state.hints_used += 1;
    }
  }
  return step(state, lines, true, graded);
}

export function hintLite(previous: TutorLiteState, ctx: TutorLiteContext): TutorLiteStep {
  const node = previous.finished ? undefined : nodeById(ctx.script, previous.node_id);
  if (node === undefined || node.expect === undefined)
    return step(clone(previous), [], false, null);
  const state = clone(previous);
  const hint = pick(state, node, node.hint, 'hint');
  state.hints_used += 1;
  // no authored hint: say the question again rather than make something up
  const said = hint === null ? line(node, node.say, 'say') : line(node, hint, 'hint');
  return step(state, [said], true, null);
}

export function skipLite(previous: TutorLiteState, ctx: TutorLiteContext): TutorLiteStep {
  const node = previous.finished ? undefined : nodeById(ctx.script, previous.node_id);
  if (node === undefined) return step(clone(previous), [], false, null);
  const state = clone(previous);
  const lines: TutorLiteLine[] = [];
  const expecting = enter(ctx, state, nodeAfter(ctx.script, node), lines);
  return step(state, lines, expecting, null);
}
