import { describe, expect, it } from 'vitest';
import { replyTurn } from '../fakes/scriptedTutorLlm';
import {
  GROUNDING,
  collect,
  makeInput,
  makeRig,
  script,
  types,
  verdict,
} from '../../test-support/testKit';
import { runTutorTurn } from './runTurn';
import { validateToolCalls } from './toolCalls';

const TEXT = 'Let us try one. Ready?';

async function withTools(tools: Array<{ name: string; input: unknown }>, text = TEXT) {
  const rig = makeRig({ tutorScript: [replyTurn(text, { tools })] });
  script(rig, verdict());
  return collect(runTutorTurn(rig.deps, makeInput()));
}

describe('show_activity', () => {
  it('is passed on for a practice question, after the text and before done', async () => {
    const { events, outcome } = await withTools([
      { name: 'show_activity', input: { question_id: 'qf_gutter' } },
    ]);
    expect(types(events).slice(-3)).toEqual(['delta', 'tool', 'done']);
    expect(events.at(-2)).toEqual({
      type: 'tool',
      name: 'show_activity',
      input: { question_id: 'qf_gutter' },
    });
    expect(outcome.show_activity).toEqual({ question_id: 'qf_gutter' });
  });

  it.each([
    ['a mastery-check question', 'mc_places'],
    ['an unknown question', 'nope_not_here'],
    ['a malformed id', 'Not A Slug!'],
  ])('is dropped for %s', async (_name, id) => {
    const { events, outcome } = await withTools([
      { name: 'show_activity', input: { question_id: id } },
    ]);
    expect(types(events)).not.toContain('tool');
    expect(outcome.show_activity).toBeNull();
  });

  it('is dropped when the arguments are not an object, and only the first valid call counts', async () => {
    const dropped = await withTools([
      { name: 'show_activity', input: 'qf_gutter' },
      { name: 'show_activity', input: null },
    ]);
    expect(dropped.outcome.show_activity).toBeNull();
    const first = await withTools([
      { name: 'show_activity', input: { question_id: 'qf_learn' } },
      { name: 'show_activity', input: { question_id: 'qf_cook' } },
    ]);
    expect(first.outcome.show_activity).toEqual({ question_id: 'qf_learn' });
    expect(first.events.filter((e) => e.type === 'tool')).toHaveLength(1);
  });

  it('is dropped when the reply itself is replaced', async () => {
    const { events, outcome } = await withTools(
      [{ name: 'show_activity', input: { question_id: 'qf_gutter' } }],
      'What is your name? Tell me.',
    );
    expect(types(events)).not.toContain('tool');
    expect(outcome).toMatchObject({ status: 'replaced', show_activity: null, evidence: [] });
  });
});

describe('record_evidence', () => {
  it('is stored on the outcome only, redacted and cut', async () => {
    const long = `Finds it hard, said it to Testa Sample at 08000000000. ${'x'.repeat(300)}`;
    const rig = makeRig({
      tutorScript: [
        replyTurn(TEXT, {
          tools: [
            {
              name: 'record_evidence',
              input: { kind: 'struggling', question_id: 'qf_learn', note: long },
            },
          ],
        }),
      ],
    });
    script(rig, verdict());
    const { events, outcome } = await collect(
      runTutorTurn(rig.deps, makeInput({ known_names: ['Testa Sample'] })),
    );
    expect(types(events)).not.toContain('tool');
    expect(outcome.evidence).toHaveLength(1);
    const [item] = outcome.evidence;
    expect(item?.kind).toBe('struggling');
    expect(item?.question_id).toBe('qf_learn');
    expect(item?.note.length).toBeLessThanOrEqual(200);
    expect(item?.note).toContain('[name]');
    expect(item?.note).toContain('[phone]');
    expect(item?.note).not.toContain('Testa');
  });

  it('drops a bad kind, a missing note and an unknown tool; unknown question ids lose the id only', () => {
    const result = validateToolCalls(
      [
        { name: 'record_evidence', input: { kind: 'brilliant', note: 'x' } },
        { name: 'record_evidence', input: { kind: 'understood' } },
        { name: 'give_marks', input: { score: 10 } },
        {
          name: 'record_evidence',
          input: { kind: 'understood', question_id: 'nope_nope', note: 'Got it.' },
        },
      ],
      GROUNDING,
    );
    expect(result.evidence).toEqual([{ kind: 'understood', note: 'Got it.' }]);
    expect(result.show_activity).toBeNull();
  });

  it('keeps at most three notes per turn', () => {
    const calls = Array.from({ length: 6 }, (_, i) => ({
      name: 'record_evidence',
      input: { kind: 'understood', note: `note ${i}` },
    }));
    expect(validateToolCalls(calls, GROUNDING).evidence).toHaveLength(3);
  });
});
