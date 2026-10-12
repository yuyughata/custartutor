import { describe, expect, it } from 'vitest';
import { replyTurn } from '../fakes/scriptedTutorLlm';
import { collect, makeInput, makeRig, script, verdict } from '../../test-support/testKit';
import { runTutorTurn } from './runTurn';

const RAW_NAME = 'Testa Sample';
const RAW_PHONE = '0800 000 0000';
const RAW = `my name is ${RAW_NAME} and call me on ${RAW_PHONE} where do we cook`;

describe('raw child text never leaves the pipeline', () => {
  it('is absent from every prompt, event and outcome field', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('We cook in the kitchen. Where do we sleep?')] });
    script(rig, verdict({ personal_info_shared: 'medium' }));
    const input = makeInput({
      message: { mode: 'text', text: RAW },
      known_names: [RAW_NAME],
      history: [
        { role: 'child', text: `i am ${RAW_NAME}` },
        { role: 'tutor', text: 'Hello! What do you want to learn?' },
      ],
    });
    const { events, outcome } = await collect(runTutorTurn(rig.deps, input));

    const everything = JSON.stringify({
      llm: rig.llm.calls.map((c) => ({ system: c.system, messages: c.messages })),
      tutor: rig.tutor.requests.map((r) => ({ system: r.system, messages: r.messages })),
      events,
      outcome,
    });
    for (const secret of ['Testa', 'Sample', '08000000000', '0800 000 0000', RAW]) {
      expect(everything, secret).not.toContain(secret);
    }
    expect(outcome.child_text_redacted).toBe('my name is [name] and call me on [phone] where do we cook');
    expect(outcome.redaction_count).toBe(2);
    expect(rig.tutor.requests[0]?.messages.at(-1)?.content).toBe(outcome.child_text_redacted);
  });

  it('removes a real name that the child (or the guardian) put in as the alias', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('Hello.')] });
    script(rig, verdict());
    const input = makeInput({
      child: { alias: 'Testa', level_code: 'P1', stage: 'connect', reading_mode: 'reader' },
      known_names: ['Testa Sample'],
    });
    await collect(runTutorTurn(rig.deps, input));
    const prefix = rig.tutor.requests[0]?.system[0]?.text ?? '';
    expect(prefix).not.toContain('Testa');
    expect(prefix).toContain('Name to use: friend');
  });

  it('keeps the pipeline from sending the redaction kinds anywhere but the count', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('Hello.')] });
    script(rig, verdict());
    const { events } = await collect(runTutorTurn(rig.deps, makeInput({ message: { mode: 'text', text: RAW } })));
    expect(JSON.stringify(events)).not.toContain('phone');
  });
});

describe('variants and history', () => {
  it('the helper variant tells the model a grown-up is typing', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('Hello.')] });
    script(rig, verdict());
    await collect(runTutorTurn(rig.deps, makeInput({ helper_present: true })));
    expect(rig.tutor.requests[0]?.system[1]?.text).toContain('typing for them');
  });

  it('windows the history by settings.max_history_turns', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('Hello.')], settings: { max_history_turns: 2 } });
    script(rig, verdict());
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ('child' as const) : ('tutor' as const),
      text: `message ${i}`,
    }));
    await collect(runTutorTurn(rig.deps, makeInput({ history })));
    const contents = rig.tutor.requests[0]?.messages.map((m) => m.content);
    expect(contents).toEqual(['message 6', 'message 7', 'where do we cook']);
  });

  it('gives the classifier a few earlier turns for context', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('Hello.')] });
    script(rig, verdict());
    const history = Array.from({ length: 8 }, (_, i) => ({
      role: i % 2 === 0 ? ('child' as const) : ('tutor' as const),
      text: `turn ${i}`,
    }));
    await collect(runTutorTurn(rig.deps, makeInput({ history })));
    const user = rig.llm.calls[0]?.messages[0]?.content as string;
    expect(user).toContain('turn 7');
    expect(user).not.toContain('turn 3');
  });

  it('records usage for every call, in order, with durations from the injected clock', async () => {
    const rig = makeRig({ tutorScript: [replyTurn('We cook in the kitchen.')] });
    script(rig, verdict());
    const { outcome } = await collect(runTutorTurn(rig.deps, makeInput()));
    expect(outcome.usage.map((u) => [u.label, u.task])).toEqual([
      ['tutor:moderation', 'moderation'],
      ['tutor:turn', 'tutor'],
      ['tutor:output_check', 'moderation'],
    ]);
    expect(outcome.usage.every((u) => u.duration_ms > 0)).toBe(true);
    expect(outcome.usage[1]).toMatchObject({ input_tokens: 200, cache_read_tokens: 150, stop_reason: 'end_turn' });
  });
});
