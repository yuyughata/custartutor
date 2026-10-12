// Decides whether a (cleaned) model reply must be REJECTED. Pure. See rejectionRules.ts for the phrase rules; this
// file adds the checks that need context: contact details (through the redactor), the child's real names, the
// story characters' names, the mastery-check answers, and verbatim copies of the tutor's own rules.
import { mentionsKnownName, redactPii } from '../redact';
import { normalizeViews } from './normalize';
import { compileTemplate } from './patterns';
import { REJECTION_RULES } from './rejectionRules';

export type RejectionReason =
  | 'asks_personal_data'
  | 'meet_someone'
  | 'keep_secret'
  | 'claims_human'
  | 'reveals_instructions'
  | 'contact_details'
  | 'known_name'
  | 'claims_character'
  | 'mastery_answer'
  | 'empty';

export interface RejectionOptions {
  /** The child's real names: a reply that contains one is rejected. */
  knownNames?: readonly string[];
  /** Names of the story characters: "I am Zari" is rejected, "Zari went to market" is not. */
  castNames?: readonly string[];
  /**
   * Mastery-check answers as groups of phrases that belong together (an item and its category; a single correct
   * option). Built by `buildMasteryGuard`, never sent to a model.
   */
  masteryGuard?: readonly (readonly string[])[];
  /** Text of the tutor's own rules: a reply that repeats a long stretch of it is rejected. */
  protectedText?: readonly string[];
}

const COMPILED = REJECTION_RULES.map((rule) => ({ rule, regex: compileTemplate(rule.template) }));
const ANSWER_FRAME =
  /(?:^| )(?:(?:the |correct |right )?answers? (?:is|are|for)|correct one|right one|it is option|option [a-e]|is the answer|the correct)(?= |$)/;
const MAPPING_FRAME = /(?:^| )(?:goes (?:in|to|with|under|into)|go (?:in|to|with|under|into)|belongs?|matches|is paired)(?= |$)/;
const PROTECTED_WINDOW = 7;

function sentencesOf(text: string): string[] {
  return (text.match(/[^.!?]+[.!?]*\s*/g) ?? []).filter((sentence) => sentence.trim() !== '');
}

function words(text: string): string[] {
  return (normalizeViews(text)[0] ?? '').split(' ').filter((word) => word !== '');
}

function containsPhrase(haystack: string, phrase: string): boolean {
  const needle = (normalizeViews(phrase)[0] ?? '').trim();
  if (needle.length < 3) return false;
  return ` ${haystack} `.includes(` ${needle} `);
}

function sharesLongRun(reply: string, source: string): boolean {
  const replyWords = words(reply);
  const sourceText = ` ${words(source).join(' ')} `;
  for (let i = 0; i + PROTECTED_WINDOW <= replyWords.length; i += 1) {
    const window = replyWords.slice(i, i + PROTECTED_WINDOW).join(' ');
    if (sourceText.includes(` ${window} `)) return true;
  }
  return false;
}

export function findRejections(reply: string, options: RejectionOptions = {}): RejectionReason[] {
  const reasons = new Set<RejectionReason>();
  if (reply.trim() === '') return ['empty'];
  const views = normalizeViews(reply);

  for (const { rule, regex } of COMPILED) {
    for (const view of views) {
      regex.lastIndex = 0;
      if (regex.test(view)) reasons.add(rule.reason);
    }
  }

  const contact = redactPii(reply, {
    kinds: ['phone', 'email', 'link', 'handle', 'address', 'number'],
    ...(options.knownNames ? { knownNames: options.knownNames } : {}),
  });
  if (contact.count > 0) reasons.add('contact_details');

  if (options.knownNames && mentionsKnownName(reply, options.knownNames)) reasons.add('known_name');

  const spoken = views[0] ?? '';
  for (const name of options.castNames ?? []) {
    const cast = (normalizeViews(name)[0] ?? '').trim();
    if (cast === '') continue;
    const claim = new RegExp(`(?:^| )(?:i am|my name is|this is|call me|im) ${cast}(?= |$)`);
    if (claim.test(spoken)) reasons.add('claims_character');
  }

  const guard = options.masteryGuard ?? [];
  if (guard.length > 0) {
    for (const sentence of sentencesOf(reply)) {
      const view = (normalizeViews(sentence)[0] ?? '').trim();
      const framed = ANSWER_FRAME.test(view);
      const mapped = MAPPING_FRAME.test(view);
      if (!framed && !mapped) continue;
      for (const group of guard) {
        if (group.length === 0) continue;
        if (group.length === 1 && !framed) continue;
        if (group.every((phrase) => containsPhrase(view, phrase))) reasons.add('mastery_answer');
      }
    }
  }

  for (const source of options.protectedText ?? []) {
    if (sharesLongRun(reply, source)) reasons.add('reveals_instructions');
  }
  return [...reasons];
}
