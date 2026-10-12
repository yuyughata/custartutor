// The adversarial suite: cases, the deterministic reply checks, and the honest summary of what is proven offline.
import { CRISIS_ENGLISH_CASES, CRISIS_PIDGIN_CASES } from './casesCrisis';
import { MASTERY_REQUEST_CASES } from './casesMastery';
import { NOT_A_CRISIS_CASES, OFF_TOPIC_CASES } from './casesOffTopic';
import { JUNK_AND_LONG_CASES, NON_ENGLISH_CASES, REPEATED_HOSTILE_CASES } from './casesOther';
import {
  CONTACT_EXTRACTION_CASES,
  PERSONAL_INFO_REQUEST_CASES,
  PERSONAL_INFO_SHARED_CASES,
} from './casesPersonalInfo';
import {
  FAKE_URGENCY_CASES,
  INJECTION_CASES,
  JAILBREAK_CASES,
  PROMPT_EXTRACTION_CASES,
} from './casesRules';
import { BULLYING_HATE_POLITICS_CASES, SEXUAL_OR_VIOLENT_CASES } from './casesSensitive';
import type { AdversarialCase } from './types';

export const ADVERSARIAL_CASES: readonly AdversarialCase[] = [
  ...OFF_TOPIC_CASES,
  ...PERSONAL_INFO_REQUEST_CASES,
  ...PERSONAL_INFO_SHARED_CASES,
  ...CONTACT_EXTRACTION_CASES,
  ...PROMPT_EXTRACTION_CASES,
  ...JAILBREAK_CASES,
  ...INJECTION_CASES,
  ...FAKE_URGENCY_CASES,
  ...MASTERY_REQUEST_CASES,
  ...SEXUAL_OR_VIOLENT_CASES,
  ...BULLYING_HATE_POLITICS_CASES,
  ...CRISIS_ENGLISH_CASES,
  ...CRISIS_PIDGIN_CASES,
  ...NOT_A_CRISIS_CASES,
  ...NON_ENGLISH_CASES,
  ...JUNK_AND_LONG_CASES,
  ...REPEATED_HOSTILE_CASES,
];

export { CHECKABLE, breaches, violationsOf } from './checks';
export { CASE_CATEGORIES, make } from './types';
export type { AdversarialCase, CaseCategory, ReplyProperty } from './types';
