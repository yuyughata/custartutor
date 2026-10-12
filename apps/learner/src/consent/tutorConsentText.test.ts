import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURRENT_TUTOR_CONSENT_VERSION } from '@custar/tutor-core/client';
import {
  CONSENT_SECTIONS,
  isDraftVersion,
  splitPlaceholders,
  tutorConsentText,
} from './tutorConsentText';

const DOC = resolve(__dirname, '../../../../docs/tutor-consent-draft.md');

/** Reads the owner's draft: "**Heading.** body" paragraphs after the rule, the title and the checkbox line.
 * The doc wraps long paragraphs over several lines, so lines are joined back before comparing. */
function readDraftJoined() {
  const text = readFileSync(DOC, 'utf8').split('\n---\n')[1] ?? '';
  const blocks = text.split(/\n\s*\n/).map((block) => block.replace(/\s*\n\s*/g, ' ').trim());
  const sections: { heading: string; body: string }[] = [];
  let agreement = '';
  let title = '';
  for (const block of blocks) {
    const match = /^\*\*(.+?)\*\*\s+([\s\S]*)$/.exec(block);
    if (match) sections.push({ heading: match[1] ?? '', body: match[2] ?? '' });
    else if (block.startsWith('[ ]')) agreement = block.replace(/^\[ \]\s+/, '');
    else if (block.startsWith('## ')) title = block.replace(/^##\s+/, '');
  }
  return { sections, agreement, title };
}

describe('tutorConsentText', () => {
  it('matches docs/tutor-consent-draft.md word for word (update both together)', () => {
    const draft = readDraftJoined();
    expect(CONSENT_SECTIONS.map(({ heading, body }) => ({ heading, body }))).toEqual(
      draft.sections,
    );
    const text = tutorConsentText('{child alias}');
    expect(text.title).toBe(draft.title);
    expect(text.agreement).toBe(draft.agreement);
  });

  it('puts the child alias in place of {child alias} everywhere, and never leaves the token', () => {
    const text = tutorConsentText('Ada');
    expect(text.title).toBe('Turn on the AI tutor for Ada?');
    expect(text.agreement).toBe(
      "I am this child's parent or guardian and I agree to the AI tutor for Ada.",
    );
    const everything = [text.title, text.agreement, ...text.sections.map((s) => s.body)].join(' ');
    expect(everything).not.toContain('{child alias}');
  });

  it('falls back to "your child" when the alias is blank', () => {
    expect(tutorConsentText('   ').title).toBe('Turn on the AI tutor for your child?');
  });

  it('is a draft while the version says draft, and says what the limits are', () => {
    expect(CURRENT_TUTOR_CONSENT_VERSION).toContain('draft');
    const text = tutorConsentText('Ada');
    expect(text.isDraft).toBe(true);
    expect(isDraftVersion('tutor-v1')).toBe(false);
    expect(tutorConsentText('Ada', 'tutor-v1').isDraft).toBe(false);
    const limits = text.sections.map((s) => s.heading);
    expect(limits).toContain('Limits.');
    expect(limits).toContain('Your choices.');
    expect(limits).toContain('Who else may read them.');
  });

  it('keeps every [bracketed] placeholder from the draft so none can be shown as fact', () => {
    const placeholders = CONSENT_SECTIONS.flatMap((s) => splitPlaceholders(s.body))
      .filter((part) => part.placeholder)
      .map((part) => part.text);
    expect(placeholders).toEqual([
      '[the United States]',
      "[Confirm and state Anthropic's retention and training position here, after review.]",
      '[90 days]',
      '[Describe exactly what the reviewer may do, from the approved protocol.]',
      '[describe deletion of past messages]',
    ]);
  });
});

describe('splitPlaceholders', () => {
  it('splits plain text and placeholders and loses nothing', () => {
    const parts = splitPlaceholders('in [the United States] for [90 days].');
    expect(parts).toEqual([
      { text: 'in ', placeholder: false },
      { text: '[the United States]', placeholder: true },
      { text: ' for ', placeholder: false },
      { text: '[90 days]', placeholder: true },
      { text: '.', placeholder: false },
    ]);
    expect(parts.map((p) => p.text).join('')).toBe('in [the United States] for [90 days].');
    expect(splitPlaceholders('plain')).toEqual([{ text: 'plain', placeholder: false }]);
  });
});
