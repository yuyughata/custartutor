// The shape of an adversarial case. The suite exists to be honest about what is PROVEN OFFLINE and what is not:
//   - `blind`    the router's action when the classifier gave no verdict (patterns and heuristics only): offline proof;
//   - `redacts`  text that must not survive redaction: offline proof;
//   - `bad_outputs`  what a misbehaving model might write; the sanitiser and the pipeline must stop each: offline proof;
//   - `verdict` + `action`  the router's action GIVEN a classifier verdict we scripted. This proves the router, NOT
//     the classifier: whether the live classifier really rates the input that way is only measured by the live run;
//   - a case with none of these depends on the tutor model's own behaviour and is listed as NOT proven offline.
// Sexual and graphic-violence inputs are NOT written out here: they are represented by a neutral description and a
// scripted verdict. Real text for those categories is left to human red-teaming and to the owner's private case
// list, which is deliberately not committed.
import type { ModerationVerdict, SafeReplyKey, SafetyAction } from '../../contract';

export const CASE_CATEGORIES = [
  'off_topic',
  'personal_info_request',
  'personal_info_shared',
  'prompt_extraction',
  'jailbreak',
  'injection',
  'mastery_request',
  'sexual_or_violent',
  'bullying_hate_politics',
  'crisis_english',
  'crisis_pidgin',
  'not_a_crisis',
  'fake_urgency',
  'contact_extraction',
  'non_english',
  'junk_and_long',
  'repeated_hostile',
] as const;
export type CaseCategory = (typeof CASE_CATEGORIES)[number];

/** Things a reply to a child must never have. Only some can be checked by a program (see checks.ts). */
export type ReplyProperty =
  | 'link'
  | 'phone'
  | 'email'
  | 'mastery_answer'
  | 'personal_data_request'
  | 'claims_human'
  | 'reveals_prompt'
  | 'follows_injection'
  | 'meeting_or_secret'
  | 'unsafe_content';

export interface AdversarialCase {
  id: string;
  category: CaseCategory;
  /** What the child types. For sexual and violent categories: a neutral description in square brackets. */
  input: string;
  /** Earlier turns, oldest first. */
  history?: Array<{ role: 'child' | 'tutor'; text: string }>;
  /** A scripted classifier verdict: an ASSUMPTION about the live classifier. */
  verdict?: Partial<ModerationVerdict>;
  /** The action the router must choose given `verdict` and the patterns. */
  action?: SafetyAction;
  /** The action the router must choose when the classifier failed. */
  blind?: SafetyAction;
  /** The fixed reply a crisis input must get. */
  fixed_reply?: SafeReplyKey;
  must_not: ReplyProperty[];
  bad_outputs?: string[];
  redacts?: string[];
  /** A known hole in the offline layers (a language the patterns do not read, for example). */
  gap?: string;
}

export function make(
  id: string,
  category: CaseCategory,
  input: string,
  rest: Partial<Omit<AdversarialCase, 'id' | 'category' | 'input'>> = {},
): AdversarialCase {
  return { id, category, input, must_not: [], ...rest };
}
