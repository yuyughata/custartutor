// The safety router: classifier verdict + deterministic pattern hits -> one SafetyDecision. Pure, no I/O.
// It implements the table of ADR 0008 exactly, and it FAILS CLOSED when the classifier gave no verdict.
//
//   signal                              action      reply        case   guardian sees the turn
//   self_harm (any severity)            safe_reply  self_harm    high   withheld
//   abuse_disclosure (any severity)     safe_reply  abuse        high   withheld
//   distress medium or high             safe_reply  distress     medium withheld
//   sexual or violence, medium/high     blocked     blocked      low    visible
//   jailbreak medium or high            redirect    redirect     none   visible
//   personal_info_shared                allow       (model)      none   visible
//   off_topic                           steer       (model)      none   visible
//   none                                allow       (model)      none   visible
//
// Either source can trigger: for every category the HIGHER severity of the classifier and the patterns counts.
// Among actions the order is safe_reply > blocked > redirect > steer > allow, and among the safe replies the
// highest severity wins (ties: self_harm, then abuse_disclosure, then distress).
//
// With no verdict (the classifier failed): the patterns decide; a distress hit counts as at least medium (a
// person should look when the second opinion is missing); a jailbreak-list hit redirects; and a message that is
// long, odd or unclear (`unclear`) is redirected instead of being answered freely.
import { MODERATION_CATEGORIES } from '../contract';
import type {
  ModerationCategory,
  ModerationVerdict,
  SafeReplyKey,
  SafetyDecision,
  Severity,
  TutorSettings,
} from '../contract';
import { SEVERITY_RANK } from './patterns';
import type { SafetyHit } from './patterns';

export interface RouteInput {
  /** The classifier's verdict, or null when the call failed (the router then fails closed). */
  verdict: ModerationVerdict | null;
  patternHits: readonly SafetyHit[];
  settings: Pick<TutorSettings, 'guardian_visible_categories'>;
  /** The message is long, odd or unclear (isUnclearMessage). Only matters when `verdict` is null. */
  unclear?: boolean;
}

const rank = (severity: Severity): number => SEVERITY_RANK[severity];
const max = (a: Severity, b: Severity): Severity => (rank(a) >= rank(b) ? a : b);

/** Lowest severity at which a category acts at all. */
const THRESHOLD: Record<ModerationCategory, Severity> = {
  self_harm: 'low',
  abuse_disclosure: 'low',
  distress: 'medium',
  sexual: 'medium',
  violence: 'medium',
  jailbreak: 'medium',
  personal_info_shared: 'high',
  off_topic: 'low',
};

const SAFE_REPLY_ORDER: ModerationCategory[] = ['self_harm', 'abuse_disclosure', 'distress'];
const REPLY_KEY: Record<string, SafeReplyKey> = {
  self_harm: 'self_harm',
  abuse_disclosure: 'abuse',
  distress: 'distress',
};
const CASE_SEVERITY: Record<string, 'low' | 'medium' | 'high'> = {
  self_harm: 'high',
  abuse_disclosure: 'high',
  distress: 'medium',
  sexual: 'low',
  violence: 'low',
};

function meets(category: ModerationCategory, severity: Severity): boolean {
  return severity !== 'none' && rank(severity) >= rank(THRESHOLD[category]);
}

export function routeSafety(input: RouteInput): SafetyDecision {
  const { verdict, patternHits, settings } = input;
  const fromVerdict = new Map<ModerationCategory, Severity>();
  const fromPatterns = new Map<ModerationCategory, Severity>();

  if (verdict !== null) {
    for (const category of MODERATION_CATEGORIES) fromVerdict.set(category, verdict[category]);
  }
  for (const hit of patternHits) {
    // With a verdict the classifier judges jailbreaks; the guard list only matters when it is missing.
    if (hit.category === 'jailbreak' && verdict !== null) continue;
    let severity: Severity = hit.severity;
    if (hit.category === 'distress' && verdict === null) severity = max(severity, 'medium');
    fromPatterns.set(hit.category, max(fromPatterns.get(hit.category) ?? 'none', severity));
  }

  const merged = new Map<ModerationCategory, Severity>();
  for (const category of MODERATION_CATEGORIES) {
    const value = max(fromVerdict.get(category) ?? 'none', fromPatterns.get(category) ?? 'none');
    if (value !== 'none') merged.set(category, value);
  }
  const triggered = (category: ModerationCategory): boolean =>
    meets(category, merged.get(category) ?? 'none');
  const onlyPatterns = (category: ModerationCategory): boolean =>
    meets(category, fromPatterns.get(category) ?? 'none') &&
    !meets(category, fromVerdict.get(category) ?? 'none');

  const safeReplies = SAFE_REPLY_ORDER.filter(triggered);
  const blocked = (['sexual', 'violence'] as const).filter(triggered);
  const redirect = triggered('jailbreak');
  const steer = triggered('off_topic');

  let action: SafetyDecision['action'] = 'allow';
  let driving: ModerationCategory[] = [];
  if (safeReplies.length > 0) {
    action = 'safe_reply';
    driving = [...safeReplies, ...blocked];
  } else if (blocked.length > 0) {
    action = 'blocked';
    driving = [...blocked];
  } else if (redirect) {
    action = 'redirect';
    driving = ['jailbreak'];
  } else if (verdict === null && input.unclear === true) {
    action = 'redirect';
  } else if (steer) {
    action = 'steer';
  }

  let replyKey: SafeReplyKey | null = null;
  if (action === 'safe_reply') {
    let best = safeReplies[0] as ModerationCategory;
    for (const category of safeReplies) {
      if (rank(merged.get(category) ?? 'none') > rank(merged.get(best) ?? 'none')) best = category;
    }
    replyKey = REPLY_KEY[best] as SafeReplyKey;
  }

  const openCase = action === 'safe_reply' || action === 'blocked';
  let caseSeverity: SafetyDecision['case_severity'] = null;
  if (openCase) {
    const order = ['low', 'medium', 'high'] as const;
    let level = 0;
    for (const category of driving) {
      const value = CASE_SEVERITY[category];
      if (value !== undefined) level = Math.max(level, order.indexOf(value));
    }
    caseSeverity = order[level] as 'low' | 'medium' | 'high';
  }
  const visible = new Set(settings.guardian_visible_categories);
  const withhold = openCase && driving.some((category) => !visible.has(category));

  return {
    action,
    reply_key: replyKey,
    categories: MODERATION_CATEGORIES.flatMap((category) => {
      const severity = merged.get(category);
      return severity === undefined ? [] : [{ category, severity }];
    }),
    open_case: openCase,
    case_severity: caseSeverity,
    withhold_from_guardian: withhold,
    from_patterns: driving.some(onlyPatterns),
  };
}

/** The fixed reply key an action needs: `safe_reply` uses its own key, `blocked` and `redirect` use theirs. */
export function fixedReplyKey(decision: SafetyDecision): SafeReplyKey | null {
  switch (decision.action) {
    case 'safe_reply':
      return decision.reply_key ?? 'distress';
    case 'blocked':
      return 'blocked';
    case 'redirect':
      return 'redirect';
    default:
      return null;
  }
}

