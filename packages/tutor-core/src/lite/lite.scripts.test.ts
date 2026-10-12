import { describe, expect, it } from 'vitest';
import type { TutorLiteState, TutorLiteStep } from '../contract';
import { LITE_WRAP_TEXT, hintLite, replyLite, skipLite, startLite } from './engine';
import { FIXTURE_SCRIPTS, rightReply } from '../../test-support/liteKit';
import type { NamedScript } from '../../test-support/liteKit';

/** The state survives being written to storage and read back between every call. */
const persist = (state: TutorLiteState): TutorLiteState =>
  JSON.parse(JSON.stringify(state)) as TutorLiteState;

function runToEnd(
  named: NamedScript,
  replyFor: (nodeId: string, miss: number) => string,
): TutorLiteStep[] {
  const ctx = { script: named.script, questions: named.questions };
  const steps: TutorLiteStep[] = [startLite(named.script, ctx)];
  const misses = new Map<string, number>();
  for (let guard = 0; guard < 200; guard += 1) {
    const last = steps[steps.length - 1] as TutorLiteStep;
    if (!last.expecting) return steps;
    const nodeId = last.state.node_id as string;
    const miss = misses.get(nodeId) ?? 0;
    misses.set(nodeId, miss + 1);
    steps.push(replyLite(persist(last.state), replyFor(nodeId, miss), ctx));
  }
  throw new Error('the script did not end');
}

describe('the fixtures have scripts to run', () => {
  it('finds scripts in the golden unit, the maths unit and the project', () => {
    expect(FIXTURE_SCRIPTS.length).toBeGreaterThanOrEqual(7);
    expect(FIXTURE_SCRIPTS.some((s) => s.name.endsWith(':unit'))).toBe(true);
  });
});

describe.each(FIXTURE_SCRIPTS.map((named) => [named.name, named] as const))(
  '%s',
  (_name, named) => {
    const nodes = new Map(named.script.nodes.map((node) => [node.id, node]));

    it('runs to the end with right replies, every one graded correct', () => {
      const steps = runToEnd(named, (id) => rightReply(nodes.get(id)!, named.questions));
      const last = steps[steps.length - 1] as TutorLiteStep;
      expect(last.state.finished).toBe(true);
      expect(last.expecting).toBe(false);
      expect(last.lines.at(-1)).toMatchObject({ kind: 'wrap', text: LITE_WRAP_TEXT });
      for (const step of steps.slice(1)) {
        if (step.graded !== null) expect(step.graded.correct).toBe(true);
      }
      expect(steps.some((step) => step.lines.some((line) => line.kind === 'incorrect'))).toBe(
        false,
      );
    });

    it('runs to the end with wrong replies: hint on the second miss, on after the third', () => {
      const steps = runToEnd(named, () => 'zzz not it');
      const last = steps[steps.length - 1] as TutorLiteStep;
      expect(last.state.finished).toBe(true);
      for (const node of named.script.nodes.filter((n) => n.expect !== undefined)) {
        const shown = steps.flatMap((step) => step.lines).filter((l) => l.node_id === node.id);
        if (node.hint.length > 0 && shown.some((l) => l.kind === 'incorrect' || l.kind === 'say')) {
          // a node that was reached and missed offers its hint
          const missed = steps.filter((s) =>
            s.lines.some((l) => l.node_id === node.id && l.kind === 'incorrect'),
          );
          if (missed.length >= 2) expect(shown.some((l) => l.kind === 'hint')).toBe(true);
        }
      }
    });

    it('is deterministic: the same replies give the same steps', () => {
      const run = () => runToEnd(named, (id) => rightReply(nodes.get(id)!, named.questions));
      expect(run()).toEqual(run());
      const wrong = () => runToEnd(named, () => 'zzz');
      expect(wrong()).toEqual(wrong());
    });

    it('can be skipped through to the end', () => {
      const ctx = { script: named.script, questions: named.questions };
      let step = startLite(named.script, ctx);
      for (let i = 0; i < 100 && step.expecting; i += 1) step = skipLite(persist(step.state), ctx);
      expect(step.state.finished).toBe(true);
      expect(step.graded).toBeNull();
    });

    it('answers a hint request without moving on', () => {
      const ctx = { script: named.script, questions: named.questions };
      const first = startLite(named.script, ctx);
      if (!first.expecting) return;
      const hinted = hintLite(persist(first.state), ctx);
      expect(hinted.state.node_id).toBe(first.state.node_id);
      expect(hinted.expecting).toBe(true);
      expect(hinted.lines).toHaveLength(1);
    });
  },
);
