import { DEFAULT_MODELS } from '@custar/authoring-core';
import { describe, expect, it } from 'vitest';
import { DEFAULT_SAFE_REPLIES } from '../contract';
import type { ModerationVerdict, SafeReplyKey, Severity, TurnStatus } from '../contract';
import { replyTurn } from '../fakes/scriptedTutorLlm';
import {
  IDS,
  collect,
  makeInput,
  makeRig,
  script,
  types,
  verdict,
} from '../../test-support/testKit';
import { runTutorTurn } from './runTurn';

const MODEL_TEXT = 'We cook in the kitchen. Where do we sleep?';

async function runWith(v: ModerationVerdict) {
  const rig = makeRig({ tutorScript: [replyTurn(MODEL_TEXT), replyTurn(MODEL_TEXT)] });
  script(rig, v);
  const result = await collect(runTutorTurn(rig.deps, makeInput()));
  return { rig, ...result };
}

describe('the rows of ADR 0008, end to end', () => {
  const crisis: Array<[string, Partial<ModerationVerdict>, SafeReplyKey, 'high' | 'medium']> = [
    ['self_harm low', { self_harm: 'low' }, 'self_harm', 'high'],
    ['self_harm medium', { self_harm: 'medium' }, 'self_harm', 'high'],
    ['self_harm high', { self_harm: 'high' }, 'self_harm', 'high'],
    ['abuse_disclosure low', { abuse_disclosure: 'low' }, 'abuse', 'high'],
    ['abuse_disclosure high', { abuse_disclosure: 'high' }, 'abuse', 'high'],
    ['distress medium', { distress: 'medium' }, 'distress', 'medium'],
    ['distress high', { distress: 'high' }, 'distress', 'medium'],
  ];

  it.each(crisis)(
    '%s -> the fixed safe reply, a case, withheld',
    async (_name, patch, key, severity) => {
      const { events, outcome, text, rig } = await runWith(verdict(patch));
      expect(types(events)).toEqual([
        'meta',
        'safety',
        ...events.slice(2, -1).map(() => 'delta'),
        'done',
      ]);
      expect(events[1]).toEqual({ type: 'safety', action: 'safe_reply' });
      expect(text).toBe(DEFAULT_SAFE_REPLIES[key]);
      expect(outcome).toMatchObject({
        status: 'safe_reply',
        reply_text: DEFAULT_SAFE_REPLIES[key],
        model: null,
        error_code: null,
        safety: {
          action: 'safe_reply',
          reply_key: key,
          open_case: true,
          case_severity: severity,
          withhold_from_guardian: true,
        },
      });
      expect(text).not.toContain(MODEL_TEXT);
      expect(rig.tutor.requests).toHaveLength(1);
      expect(rig.tutor.completed + rig.tutor.aborted).toBeGreaterThanOrEqual(1);
    },
  );

  it.each([
    ['sexual medium', { sexual: 'medium' }],
    ['sexual high', { sexual: 'high' }],
    ['violence medium', { violence: 'medium' }],
    ['violence high', { violence: 'high' }],
  ] as Array<[string, Partial<ModerationVerdict>]>)(
    '%s -> the fixed blocked reply, a low case, visible',
    async (_n, patch) => {
      const { events, outcome, text } = await runWith(verdict(patch));
      expect(events[1]).toEqual({ type: 'safety', action: 'blocked' });
      expect(text).toBe(DEFAULT_SAFE_REPLIES.blocked);
      expect(outcome).toMatchObject({
        status: 'blocked',
        safety: {
          action: 'blocked',
          open_case: true,
          case_severity: 'low',
          withhold_from_guardian: false,
        },
      });
    },
  );

  it.each(['medium', 'high'] as Severity[])(
    'jailbreak %s -> the fixed redirect reply, no case',
    async (level) => {
      const { events, outcome, text } = await runWith(verdict({ jailbreak: level }));
      expect(events[1]).toEqual({ type: 'safety', action: 'redirect' });
      expect(text).toBe(DEFAULT_SAFE_REPLIES.redirect);
      expect(outcome).toMatchObject({
        status: 'blocked',
        safety: { action: 'redirect', open_case: false },
      });
    },
  );

  it('personal_info_shared -> the model answers, told to remind the child', async () => {
    const { rig, outcome, text } = await runWith(verdict({ personal_info_shared: 'medium' }));
    expect(outcome.status).toBe('complete');
    expect(text).toBe(MODEL_TEXT);
    expect(rig.tutor.requests).toHaveLength(2);
    expect(rig.tutor.requests[0]?.system[1]?.text ?? '').not.toContain('not to share names');
    expect(rig.tutor.requests[1]?.system[1]?.text).toContain('not to share names');
  });

  it.each(['low', 'medium'] as Severity[])(
    'off_topic %s -> the model answers, told to steer back',
    async (level) => {
      const { rig, events, outcome, text } = await runWith(verdict({ off_topic: level }));
      expect(outcome).toMatchObject({
        status: 'complete',
        safety: { action: 'steer', open_case: false },
      });
      expect(text).toBe(MODEL_TEXT);
      expect(events[1]).toEqual({ type: 'safety', action: 'steer' });
      expect(rig.tutor.requests[1]?.system[1]?.text).toContain('not about the lesson');
      expect(rig.tutor.requests[0]?.system[1]?.text ?? '').not.toContain('not about the lesson');
    },
  );

  it('nothing -> the model answers normally', async () => {
    const { rig, events, outcome, text } = await runWith(verdict());
    expect(rig.tutor.requests).toHaveLength(1);
    expect(types(events)[0]).toBe('meta');
    expect(types(events).at(-1)).toBe('done');
    expect(types(events)).not.toContain('safety');
    expect(events.at(-1)).toEqual({ type: 'done', message_id: IDS.message_id });
    expect(text).toBe(MODEL_TEXT);
    const status: TurnStatus = 'complete';
    expect(outcome).toMatchObject({
      status,
      reply_text: MODEL_TEXT,
      error_code: null,
      verdict: verdict(),
    });
    expect(outcome.model).toBe(DEFAULT_MODELS.tutor);
    expect(outcome.usage.map((u) => u.label)).toEqual([
      'tutor:moderation',
      'tutor:turn',
      'tutor:output_check',
    ]);
  });
});
