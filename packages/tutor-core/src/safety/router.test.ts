import { describe, expect, it } from 'vitest';
import { DEFAULT_TUTOR_SETTINGS } from '../contract';
import type { ModerationVerdict, Severity } from '../contract';
import type { SafetyHit } from './patterns';
import { fixedReplyKey, routeSafety } from './router';
import { isUnclearMessage } from './unclear';

const NONE: ModerationVerdict = {
  self_harm: 'none',
  abuse_disclosure: 'none',
  distress: 'none',
  sexual: 'none',
  violence: 'none',
  personal_info_shared: 'none',
  jailbreak: 'none',
  off_topic: 'none',
  summary: 'test',
};
const verdict = (patch: Partial<ModerationVerdict>): ModerationVerdict => ({ ...NONE, ...patch });
const hit = (category: SafetyHit['category'], severity: SafetyHit['severity']): SafetyHit => ({
  id: `${category}_${severity}`,
  category,
  severity,
});
const route = (v: ModerationVerdict | null, hits: SafetyHit[] = [], unclear = false) =>
  routeSafety({ verdict: v, patternHits: hits, settings: DEFAULT_TUTOR_SETTINGS, unclear });

describe('every row of the ADR 0008 table', () => {
  const severities: Severity[] = ['low', 'medium', 'high'];

  it.each(severities)(
    'self_harm %s -> safe_reply, self_harm text, high case, withheld',
    (level) => {
      const d = route(verdict({ self_harm: level }));
      expect(d).toMatchObject({
        action: 'safe_reply',
        reply_key: 'self_harm',
        open_case: true,
        case_severity: 'high',
        withhold_from_guardian: true,
        from_patterns: false,
      });
    },
  );

  it.each(severities)(
    'abuse_disclosure %s -> safe_reply, abuse text, high case, withheld',
    (level) => {
      const d = route(verdict({ abuse_disclosure: level }));
      expect(d).toMatchObject({
        action: 'safe_reply',
        reply_key: 'abuse',
        case_severity: 'high',
        withhold_from_guardian: true,
      });
    },
  );

  it.each(['medium', 'high'] as const)(
    'distress %s -> safe_reply, distress text, medium case',
    (level) => {
      const d = route(verdict({ distress: level }));
      expect(d).toMatchObject({
        action: 'safe_reply',
        reply_key: 'distress',
        case_severity: 'medium',
        withhold_from_guardian: true,
      });
    },
  );

  it('distress low alone is just a normal turn', () => {
    expect(route(verdict({ distress: 'low' }))).toMatchObject({
      action: 'allow',
      open_case: false,
    });
  });

  it.each(['sexual', 'violence'] as const)(
    '%s medium or high -> blocked, low case, guardian sees',
    (c) => {
      for (const level of ['medium', 'high'] as const) {
        const d = route(verdict({ [c]: level }));
        expect(d).toMatchObject({
          action: 'blocked',
          reply_key: null,
          open_case: true,
          case_severity: 'low',
          withhold_from_guardian: false,
        });
      }
      expect(route(verdict({ [c]: 'low' })).action).toBe('allow');
    },
  );

  it('jailbreak medium or high -> redirect, no case', () => {
    for (const level of ['medium', 'high'] as const) {
      expect(route(verdict({ jailbreak: level }))).toMatchObject({
        action: 'redirect',
        open_case: false,
        case_severity: null,
        withhold_from_guardian: false,
      });
    }
    expect(route(verdict({ jailbreak: 'low' })).action).toBe('allow');
  });

  it('personal_info_shared -> allow', () => {
    const d = route(verdict({ personal_info_shared: 'high' }));
    expect(d.action).toBe('allow');
    expect(d.categories).toEqual([{ category: 'personal_info_shared', severity: 'high' }]);
  });

  it.each(severities)('off_topic %s -> steer', (level) => {
    expect(route(verdict({ off_topic: level }))).toMatchObject({
      action: 'steer',
      open_case: false,
    });
  });

  it('nothing -> allow', () => {
    expect(route(NONE)).toEqual({
      action: 'allow',
      reply_key: null,
      categories: [],
      open_case: false,
      case_severity: null,
      withhold_from_guardian: false,
      from_patterns: false,
    });
  });
});

describe('combinations', () => {
  it('a safe reply beats blocked, redirect and steer', () => {
    const d = route(
      verdict({ self_harm: 'low', sexual: 'high', jailbreak: 'high', off_topic: 'high' }),
    );
    expect(d.action).toBe('safe_reply');
    expect(d.categories.map((c) => c.category)).toEqual([
      'self_harm',
      'sexual',
      'jailbreak',
      'off_topic',
    ]);
  });

  it('blocked beats redirect; redirect beats steer', () => {
    expect(route(verdict({ violence: 'medium', jailbreak: 'high' })).action).toBe('blocked');
    expect(route(verdict({ jailbreak: 'medium', off_topic: 'low' })).action).toBe('redirect');
  });

  it('the highest severity picks the safe reply; ties go self_harm, abuse, distress', () => {
    expect(route(verdict({ self_harm: 'low', abuse_disclosure: 'high' })).reply_key).toBe('abuse');
    expect(route(verdict({ self_harm: 'high', distress: 'high' })).reply_key).toBe('self_harm');
    expect(route(verdict({ abuse_disclosure: 'medium', distress: 'medium' })).reply_key).toBe(
      'abuse',
    );
    expect(route(verdict({ distress: 'high', abuse_disclosure: 'low' })).reply_key).toBe(
      'distress',
    );
  });

  it('the case severity is the highest of the triggered categories', () => {
    expect(route(verdict({ distress: 'high', sexual: 'high' })).case_severity).toBe('medium');
    expect(route(verdict({ distress: 'high', abuse_disclosure: 'low' })).case_severity).toBe(
      'high',
    );
  });
});

describe('the patterns are a second trigger', () => {
  it('a pattern hit alone triggers the safe reply when the classifier saw nothing', () => {
    const d = route(NONE, [hit('self_harm', 'high')]);
    expect(d).toMatchObject({ action: 'safe_reply', reply_key: 'self_harm', from_patterns: true });
  });

  it('classifier and patterns agreeing is not "from patterns"', () => {
    const d = route(verdict({ self_harm: 'high' }), [hit('self_harm', 'high')]);
    expect(d.from_patterns).toBe(false);
  });

  it('a low pattern hit of abuse still triggers; a low distress hit does not (with a verdict)', () => {
    expect(route(NONE, [hit('abuse_disclosure', 'low')]).action).toBe('safe_reply');
    expect(route(NONE, [hit('distress', 'low')]).action).toBe('allow');
  });

  it('merges the higher severity of the two sources', () => {
    const d = route(verdict({ distress: 'low' }), [hit('distress', 'medium')]);
    expect(d).toMatchObject({ action: 'safe_reply', reply_key: 'distress', from_patterns: true });
    expect(d.categories).toEqual([{ category: 'distress', severity: 'medium' }]);
  });

  it('ignores the jailbreak list when the classifier answered', () => {
    expect(route(NONE, [hit('jailbreak', 'high')]).action).toBe('allow');
  });
});

describe('a null verdict fails closed', () => {
  it('patterns decide', () => {
    expect(route(null, [hit('abuse_disclosure', 'low')])).toMatchObject({
      action: 'safe_reply',
      reply_key: 'abuse',
      from_patterns: true,
    });
  });

  it('a low distress hit is promoted to medium', () => {
    expect(route(null, [hit('distress', 'low')])).toMatchObject({
      action: 'safe_reply',
      reply_key: 'distress',
      case_severity: 'medium',
    });
  });

  it('a jailbreak-list hit redirects', () => {
    expect(route(null, [hit('jailbreak', 'medium')])).toMatchObject({
      action: 'redirect',
      from_patterns: true,
    });
    expect(route(null, [hit('jailbreak', 'low')]).action).toBe('allow');
  });

  it('an unclear message with no hit is redirected, a plain one is allowed', () => {
    expect(route(null, [], true)).toMatchObject({ action: 'redirect', from_patterns: false });
    expect(route(null, [], false).action).toBe('allow');
  });

  it('a safe reply still wins over the unclear redirect', () => {
    expect(route(null, [hit('self_harm', 'low')], true).action).toBe('safe_reply');
  });
});

describe('guardian visibility', () => {
  it('honours guardian_visible_categories', () => {
    const settings = { guardian_visible_categories: ['distress'] };
    const d = routeSafety({ verdict: verdict({ distress: 'high' }), patternHits: [], settings });
    expect(d.withhold_from_guardian).toBe(false);
    const blocked = routeSafety({
      verdict: verdict({ sexual: 'high' }),
      patternHits: [],
      settings,
    });
    expect(blocked.withhold_from_guardian).toBe(true);
  });

  it('never withholds a turn that opens no case', () => {
    const settings = { guardian_visible_categories: [] };
    const d = routeSafety({ verdict: verdict({ off_topic: 'high' }), patternHits: [], settings });
    expect(d.withhold_from_guardian).toBe(false);
  });
});

describe('fixedReplyKey and isUnclearMessage', () => {
  it('maps actions to the fixed reply they need', () => {
    expect(fixedReplyKey(route(verdict({ abuse_disclosure: 'low' })))).toBe('abuse');
    expect(fixedReplyKey(route(verdict({ sexual: 'high' })))).toBe('blocked');
    expect(fixedReplyKey(route(verdict({ jailbreak: 'high' })))).toBe('redirect');
    expect(fixedReplyKey(route(NONE))).toBeNull();
  });

  it.each([
    ['where do we cook', false],
    ['Can you help me with the kitchen?', false],
    ['a'.repeat(201), true],
    ['!!! ??? ###', true],
    ['你好你好你好你好', true],
    ['<script>alert(1)</script>', true],
    ['```code```', true],
  ])('"%s" unclear: %s', (text, expected) => {
    expect(isUnclearMessage(text)).toBe(expected);
  });

  it('treats a jailbreak-list hit as unclear', () => {
    expect(isUnclearMessage('hello', [hit('jailbreak', 'high')])).toBe(true);
    expect(isUnclearMessage('hello', [hit('jailbreak', 'low')])).toBe(false);
  });
});
