// Everything the pipeline decides BEFORE any model is called: redaction, the history in redacted form, a safe
// alias, and the deterministic safety hits. This is the only place raw child text is read; nothing here returns it.
import type { TutorTurnInput } from '../contract';
import type { HistoryItem } from '../prompt/history';
import { safeAlias } from '../prompt/system';
import { mentionsKnownName, redactPii } from '../redact';
import type { RedactionResult } from '../redact';
import { detectGuardPatterns, detectSafetyPatterns } from '../safety/patterns';
import type { SafetyHit } from '../safety/patterns';
import { isUnclearMessage } from '../safety/unclear';

export interface TutorTurnExtras {
  /**
   * The ids of the session and of the tutor message being written. When present the pipeline emits `meta` first
   * and puts the message id on `done`; when absent it emits `done` with the nil UUID and no `meta`.
   */
  ids?: { session_id: string; message_id: string };
  /** Mastery-check answers for the reply sanitiser (`buildMasteryGuard`). Never sent to a model. */
  mastery_guard?: readonly (readonly string[])[];
}

export type TutorTurnRunInput = TutorTurnInput & TutorTurnExtras;

export interface PreparedTurn {
  redaction: RedactionResult;
  /** The child's message after redaction: the only text any model or store may see. */
  childText: string;
  history: HistoryItem[];
  child: TutorTurnInput['child'];
  knownNames: string[];
  /** Self-harm, abuse and distress hits (raw and redacted text). */
  safetyHits: SafetyHit[];
  /** Safety hits plus the jailbreak list. */
  patternHits: SafetyHit[];
  unclear: boolean;
  /** Personal details were found and removed: the tutor reminds the child gently. */
  remindPrivacy: boolean;
}

function unique(hits: SafetyHit[]): SafetyHit[] {
  const seen = new Set<string>();
  return hits.filter((hit) => (seen.has(hit.id) ? false : (seen.add(hit.id), true)));
}

/** The server limits a message to 500 characters; this cap only protects the prompt (and the cost) if it forgot. */
export const MAX_RAW_CHARS = 1000;

export function prepareTurn(input: TutorTurnRunInput): PreparedTurn {
  const knownNames = [...(input.known_names ?? [])];
  const raw = input.message.text.slice(0, MAX_RAW_CHARS);
  const redaction = redactPii(raw, { knownNames });

  // Patterns look at the raw text too: redaction could swallow the very words that matter ("I live at ... and he
  // hits me"). The raw text never leaves this function.
  const safetyHits = unique([
    ...detectSafetyPatterns(raw),
    ...detectSafetyPatterns(redaction.text),
  ]);
  const guardHits = unique([...detectGuardPatterns(raw), ...detectGuardPatterns(redaction.text)]);

  const history: HistoryItem[] = input.history.map((item) => ({
    role: item.role,
    text: item.role === 'child' ? redactPii(item.text, { knownNames }).text : item.text,
  }));

  let alias = safeAlias(input.child.alias);
  if (mentionsKnownName(alias, knownNames) || redactPii(alias).count > 0) alias = 'friend';

  return {
    redaction,
    childText: redaction.text,
    history,
    child: { ...input.child, alias },
    knownNames,
    safetyHits,
    patternHits: [...safetyHits, ...guardHits],
    unclear: isUnclearMessage(redaction.text, guardHits),
    remindPrivacy: redaction.kinds.some((kind) => kind !== 'number'),
  };
}
