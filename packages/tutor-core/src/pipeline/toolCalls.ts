// Validation of the tutor's tool calls. The arguments come from a model and are untrusted: a call that does not
// fit is dropped silently (the child sees nothing), never repaired.
//   show_activity   the question must be a PRACTICE question of this unit and never one of the mastery check
//   record_evidence kind from the allowed list; the note is redacted and cut to 200 characters; a question id
//                   that is not in the grounding is dropped from the note
// At most one activity and a few notes per turn.
import { Id } from '@custar/content-schema';
import { ShowActivity, TutorEvidence } from '../contract';
import type { TutorGrounding } from '../contract';
import { redactPii } from '../redact';

export const MAX_EVIDENCE_PER_TURN = 3;

export interface ToolCallInput {
  name: string;
  input: unknown;
}

export interface ValidatedTools {
  show_activity: ShowActivity | null;
  evidence: TutorEvidence[];
}

function cut(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3).trimEnd()}...` : flat;
}

export function validateToolCalls(
  calls: readonly ToolCallInput[],
  grounding: TutorGrounding,
  knownNames: readonly string[] = [],
): ValidatedTools {
  const practice = new Set(grounding.practice.map((q) => q.id));
  const mastery = new Set(grounding.mastery_prompts.map((q) => q.id));
  const result: ValidatedTools = { show_activity: null, evidence: [] };

  for (const call of calls) {
    if (call.name === 'show_activity') {
      const parsed = ShowActivity.safeParse(call.input);
      if (!parsed.success || result.show_activity !== null) continue;
      const id = parsed.data.question_id;
      if (practice.has(id) && !mastery.has(id)) result.show_activity = { question_id: id };
    } else if (call.name === 'record_evidence') {
      if (result.evidence.length >= MAX_EVIDENCE_PER_TURN) continue;
      const raw =
        typeof call.input === 'object' && call.input !== null
          ? (call.input as Record<string, unknown>)
          : null;
      if (raw === null || typeof raw['note'] !== 'string') continue;
      const note = cut(redactPii(raw['note'], { knownNames }).text, 200);
      const question = Id.safeParse(raw['question_id']);
      const known = question.success && (practice.has(question.data) || mastery.has(question.data));
      const parsed = TutorEvidence.safeParse({
        kind: raw['kind'],
        note,
        ...(known && question.success ? { question_id: question.data } : {}),
      });
      if (parsed.success && note !== '') result.evidence.push(parsed.data);
    }
  }
  return result;
}
