// The mutable record of one turn while it runs, and how it becomes the TutorTurnOutcome that is persisted.
import type { UsageRecord } from '@custar/authoring-core';
import type {
  ModerationVerdict,
  SafetyDecision,
  ShowActivity,
  TutorErrorCode,
  TutorEvidence,
  TutorTurnOutcome,
  TurnStatus,
} from '../contract';
import type { PreparedTurn } from './prepare';

export const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/** A verdict that rates nothing: the stand-in used to ask the router what the deterministic patterns alone force. */
export const NO_CONCERN: ModerationVerdict = {
  self_harm: 'none',
  abuse_disclosure: 'none',
  distress: 'none',
  sexual: 'none',
  violence: 'none',
  personal_info_shared: 'none',
  jailbreak: 'none',
  off_topic: 'none',
  summary: '',
};

export const ALLOW_DECISION: SafetyDecision = {
  action: 'allow',
  reply_key: null,
  categories: [],
  open_case: false,
  case_severity: null,
  withhold_from_guardian: false,
  from_patterns: false,
};

export interface TurnState {
  prepared: PreparedTurn;
  decision: SafetyDecision;
  verdict: ModerationVerdict | null;
  classifierUsage: UsageRecord[];
  tutorUsage: UsageRecord[];
  checkUsage: UsageRecord[];
  reply: string | null;
  status: TurnStatus;
  showActivity: ShowActivity | null;
  evidence: TutorEvidence[];
  model: string | null;
  errorCode: TutorErrorCode | null;
}

export function newState(prepared: PreparedTurn): TurnState {
  return {
    prepared,
    decision: ALLOW_DECISION,
    verdict: null,
    classifierUsage: [],
    tutorUsage: [],
    checkUsage: [],
    reply: null,
    status: 'failed',
    showActivity: null,
    evidence: [],
    model: null,
    errorCode: null,
  };
}

export function toOutcome(state: TurnState): TutorTurnOutcome {
  return {
    child_text_redacted: state.prepared.childText,
    redaction_count: state.prepared.redaction.count,
    reply_text: state.reply,
    status: state.status,
    safety: state.decision,
    verdict: state.verdict,
    show_activity: state.showActivity,
    evidence: state.evidence,
    usage: [...state.classifierUsage, ...state.tutorUsage, ...state.checkUsage],
    model: state.model,
    error_code: state.errorCode,
  };
}
