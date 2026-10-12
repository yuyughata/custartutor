import { LlmError } from '@custar/authoring-core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFE_REPLIES } from '../contract';
import {
  SCRIPTED_USAGE,
  doneStep,
  refusalTurn,
  replyTurn,
  textSteps,
} from '../fakes/scriptedTutorLlm';
import { OUTPUT_CHECK_LABEL } from './outputCheck';
import { collect, makeInput, makeRig, script, types, verdict } from '../../test-support/testKit';
import { runTutorTurn } from './runTurn';

const REDIRECT = DEFAULT_SAFE_REPLIES.redirect;

async function run(
  turn: ReturnType<typeof replyTurn>,
  check: { ok: boolean } | Error = { ok: true },
  settings = {},
) {
  const rig = makeRig({ tutorScript: [turn], settings });
  script(rig, verdict(), check);
  return { rig, ...(await collect(runTutorTurn(rig.deps, makeInput()))) };
}

describe('the sanitiser rejects a reply', () => {
  it('after the first sentence was shown: replace', async () => {
    const { events, outcome } = await run(replyTurn('Well done. Now, what is your name? Tell me.'));
    expect(
      events
        .filter((e) => e.type === 'delta')
        .map((e) => (e as { text: string }).text)
        .join(''),
    ).toBe('Well done.');
    expect(events.at(-2)).toEqual({ type: 'replace', text: REDIRECT, reason: 'filter' });
    expect(types(events).at(-1)).toBe('done');
    expect(outcome).toMatchObject({ status: 'replaced', reply_text: REDIRECT });
  });

  it('on the first sentence: nothing was shown, still replace', async () => {
    const { events, outcome } = await run(replyTurn('I am a real person, not a robot. Hello.'));
    expect(types(events)).toEqual(['meta', 'replace', 'done']);
    expect(outcome.status).toBe('replaced');
  });

  it('a contact detail', async () => {
    const { outcome } = await run(replyTurn('Call me on 0800 000 0000 please. Thanks.'));
    expect(outcome).toMatchObject({ status: 'replaced', reply_text: REDIRECT });
  });

  it('a mastery-check answer given as an answer', async () => {
    const { outcome } = await run(replyTurn('The classroom goes in At school. Good luck.'));
    expect(outcome.status).toBe('replaced');
  });

  it('a long reply is cut at a sentence, not rejected', async () => {
    const long = 'We cook in the kitchen and we sleep in the bedroom. '.repeat(20);
    const { outcome } = await run(replyTurn(long));
    expect(outcome.status).toBe('complete');
    expect((outcome.reply_text ?? '').length).toBeLessThanOrEqual(480);
    expect(outcome.reply_text?.endsWith('.')).toBe(true);
  });

  it('markdown, links and emoji are tidied, not rejected', async () => {
    const { outcome } = await run(
      replyTurn('**Good** try! See https://example.com. Where do we sleep? \u{1F600}'),
    );
    expect(outcome.status).toBe('complete');
    expect(outcome.reply_text).toBe('Good try! See. Where do we sleep?');
  });

  it('an empty reply is replaced', async () => {
    const { outcome } = await run({ steps: [doneStep()] });
    expect(outcome).toMatchObject({ status: 'replaced', reply_text: REDIRECT });
  });
});

describe('the output check', () => {
  it('replaces a reply the check does not approve (reason safety)', async () => {
    const { events, outcome } = await run(replyTurn('We cook in the kitchen.'), { ok: false });
    expect(events.at(-2)).toEqual({ type: 'replace', text: REDIRECT, reason: 'safety' });
    expect(outcome.status).toBe('replaced');
    expect(outcome.usage.at(-1)?.label).toBe('tutor:output_check');
  });

  it('fails closed when the check itself fails', async () => {
    const { outcome } = await run(
      replyTurn('We cook in the kitchen.'),
      new LlmError('transport', 'down', { retryable: true }),
    );
    expect(outcome).toMatchObject({ status: 'replaced', reply_text: REDIRECT });
  });

  it('is skipped when switched off and the classifier worked', async () => {
    const { rig, outcome } = await run(
      replyTurn('We cook in the kitchen.'),
      { ok: false },
      { output_check: false },
    );
    expect(outcome.status).toBe('complete');
    expect(rig.llm.calls.filter((c) => c.label === OUTPUT_CHECK_LABEL)).toHaveLength(0);
  });

  it('is shown the mastery prompts but never an answer', async () => {
    const { rig } = await run(replyTurn('We cook in the kitchen.'));
    const call = rig.llm.calls.find((c) => c.label === OUTPUT_CHECK_LABEL);
    const text = JSON.stringify(call?.messages);
    expect(text).toContain('Put each place where it belongs');
    expect(text).not.toContain('At school');
    expect(text).toContain('We cook in the kitchen.');
  });
});

describe('model failures', () => {
  it('a refusal becomes the redirect reply, and the billed call is counted', async () => {
    const { events, outcome } = await run(refusalTurn());
    expect(events.at(-2)).toEqual({ type: 'replace', text: REDIRECT, reason: 'safety' });
    expect(outcome.status).toBe('replaced');
    expect(outcome.error_code).toBeNull();
    const tutor = outcome.usage.find((u) => u.label === 'tutor:turn');
    expect(tutor).toMatchObject({
      input_tokens: SCRIPTED_USAGE.input_tokens,
      stop_reason: 'refusal',
    });
  });

  it('an error before any text is a calm failure with a retryable error event', async () => {
    const { events, outcome } = await run({
      steps: [{ type: 'fail', error: new LlmError('transport', 'x', { retryable: true }) }],
    });
    expect(events.at(-1)).toEqual({ type: 'error', code: 'upstream', retryable: true });
    expect(types(events)).not.toContain('done');
    expect(outcome).toMatchObject({
      status: 'failed',
      error_code: 'upstream',
      reply_text: null,
      model: null,
    });
  });

  it('an error after a whole sentence keeps what the child already read', async () => {
    const { outcome, events } = await run({
      steps: [
        ...textSteps('We cook in the kitchen. And then'),
        { type: 'fail', error: new LlmError('transport', 'cut', { retryable: true }) },
      ],
    });
    expect(outcome).toMatchObject({ status: 'complete', reply_text: 'We cook in the kitchen.' });
    expect(types(events).at(-1)).toBe('done');
  });

  it('a reply cut off by the token limit ends at its last whole sentence', async () => {
    const { outcome } = await run(
      replyTurn('We cook in the kitchen. Then we go to the', { stopReason: 'max_tokens' }),
    );
    expect(outcome).toMatchObject({ status: 'complete', reply_text: 'We cook in the kitchen.' });
  });

  it('a throwing TutorLlm cannot make the pipeline throw', async () => {
    const rig = makeRig({
      tutorScript: () => {
        throw new Error('boom');
      },
    });
    script(rig, verdict());
    const { outcome } = await collect(runTutorTurn(rig.deps, makeInput()));
    expect(['failed', 'replaced']).toContain(outcome.status);
  });
});
