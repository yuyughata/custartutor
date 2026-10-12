import { CURRENT_TUTOR_CONSENT_VERSION } from '@custar/tutor-core/client';

/**
 * The AI tutor consent text, structured for the grown-ups screen. It mirrors docs/tutor-consent-draft.md
 * (`tutorConsentText.test.ts` fails when the two drift apart). It is a DRAFT: a child-protection professional
 * and Nigerian counsel must review it, and every [bracketed] claim must be confirmed before launch. Nothing here
 * may state how Anthropic handles data until that has been checked, so the brackets stay visible in the app.
 */

export const CHILD_ALIAS_TOKEN = '{child alias}';

export interface ConsentSection {
  id: string;
  heading: string;
  /** May contain [bracketed] placeholders and the {child alias} token. */
  body: string;
}

export const CONSENT_SECTIONS: readonly ConsentSection[] = [
  {
    id: 'what_it_is',
    heading: 'What it is.',
    body: 'The tutor is a computer program, not a person. It helps with the lesson by chatting in short messages. It can make mistakes. It is not for emergencies and it is not a counsellor.',
  },
  {
    id: 'what_it_can_do',
    heading: 'What it can do.',
    body: 'Explain the lesson, give hints, and ask questions about the unit. It does not give the answers to the end-of-lesson check. Lessons still work without it, on the phone, offline.',
  },
  {
    id: 'what_is_sent',
    heading: 'What is sent, and where.',
    body: "When your child sends a message, we remove names, phone numbers, email addresses and addresses that we can find, then send the message and a little of the lesson to an AI service run by Anthropic in [the United States]. We do not send your child's real name or photo: only the nickname you chose. [Confirm and state Anthropic's retention and training position here, after review.]",
  },
  {
    id: 'what_we_keep',
    heading: 'What we keep.',
    body: 'We keep the cleaned messages for [90 days] so you can read them. You can read them in the grown-ups area with your PIN.',
  },
  {
    id: 'who_else',
    heading: 'Who else may read them.',
    body: 'If a message suggests a child may be unsafe or very upset, the tutor replies with a fixed caring message and a trained CUSTAR reviewer may read a short, cleaned excerpt. In that case we may keep the messages from you until the reviewer has looked. [Describe exactly what the reviewer may do, from the approved protocol.]',
  },
  {
    id: 'your_choices',
    heading: 'Your choices.',
    body: 'You can turn the tutor off at any time in the grown-ups area. Turning it off stops new messages; [describe deletion of past messages].',
  },
  {
    id: 'limits',
    heading: 'Limits.',
    body: 'We set a daily number of messages. A grown-up should stay close when a young child uses the tutor.',
  },
];

const AGREEMENT = `I am this child's parent or guardian and I agree to the AI tutor for ${CHILD_ALIAS_TOKEN}.`;
const TITLE = `Turn on the AI tutor for ${CHILD_ALIAS_TOKEN}?`;

export interface TutorConsentText {
  version: string;
  /** True while the wording is a draft: the screen shows a "not final" banner. */
  isDraft: boolean;
  title: string;
  sections: ConsentSection[];
  /** The label of the required checkbox. */
  agreement: string;
}

/** A name that is blank falls back to "your child", so the sentences still read well. */
function fill(text: string, alias: string): string {
  const name = alias.trim() === '' ? 'your child' : alias.trim();
  return text.split(CHILD_ALIAS_TOKEN).join(name);
}

export function isDraftVersion(version: string): boolean {
  return version.toLowerCase().includes('draft');
}

/** The consent text for a child, with the alias in place of {child alias}. Never the real name. */
export function tutorConsentText(
  alias: string,
  version: string = CURRENT_TUTOR_CONSENT_VERSION,
): TutorConsentText {
  return {
    version,
    isDraft: isDraftVersion(version),
    title: fill(TITLE, alias),
    sections: CONSENT_SECTIONS.map((section) => ({ ...section, body: fill(section.body, alias) })),
    agreement: fill(AGREEMENT, alias),
  };
}

export interface TextPart {
  text: string;
  /** True for a [bracketed] placeholder that still has to be confirmed. */
  placeholder: boolean;
}

/** Splits text into plain parts and [bracketed] placeholders (brackets kept), so placeholders can be marked. */
export function splitPlaceholders(text: string): TextPart[] {
  const parts: TextPart[] = [];
  const pattern = /\[[^\]]*\]/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    if (start > last) parts.push({ text: text.slice(last, start), placeholder: false });
    parts.push({ text: match[0], placeholder: true });
    last = start + match[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), placeholder: false });
  return parts.length > 0 ? parts : [{ text, placeholder: false }];
}

export const DRAFT_BANNER_TITLE = 'DRAFT WORDING: not final';
export const DRAFT_BANNER_BODY =
  'This text has not been reviewed yet. The parts in [square brackets] still have to be confirmed before the tutor is used by real families.';
