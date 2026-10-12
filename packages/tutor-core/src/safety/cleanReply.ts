// Turns a model reply into plain, TTS-friendly text: no HTML, no markdown, no links, no emoji, one paragraph.
// The tutor is told to write that way; this is what happens when it does not. Pure and idempotent.
import { redactPii } from '../redact';

const HTML_TAGS =
  'a|b|i|u|em|strong|p|br|div|span|script|style|iframe|img|h[1-6]|ul|ol|li|table|thead|tbody|tr|td|th|code|pre|blockquote|font|center|html|body|head|link|meta|form|input|button|svg|audio|video|source|object|embed|sup|sub|small|big|hr|mark';
const HTML_TAG = new RegExp(String.raw`<\/?(?:${HTML_TAGS})(?:\s[^<>]*)?\/?>`, 'gi');
// Alternatives, not one class: joiners and variation selectors must not sit next to the symbols they decorate
const EMOJI =
  /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2300}-\u{23FF}\u{2B00}-\u{2BFF}\u{1F1E6}-\u{1F1FF}]|[\u{FE00}-\u{FE0F}]|\u{200D}|\u{20E3}|[\u{E0020}-\u{E007F}]/gu;

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&apos;': "'",
  '&nbsp;': ' ',
};

/** Markdown and HTML out, plain words in. Keeps the sentence structure. */
function stripMarkup(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`+/g, '')
    .replace(HTML_TAG, ' ')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp|#39);/g, (entity) => ENTITIES[entity] ?? entity)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*\d{1,2}[.)]\s+/gm, '')
    .replace(/\*\*|~~/g, '')
    .replace(/_+/g, (run) => (run.length === 2 ? '' : run))
    .replace(/\*/g, '')
    .replace(/(^|[\s(])_([^_\s][^_]*?)_(?=[\s.,!?)]|$)/g, '$1$2');
}

/** Links go entirely (the tutor never sends a child off to a site). */
function stripLinks(text: string): string {
  return redactPii(text, { kinds: ['link'] }).text.replace(/\s*\[link\]/g, '');
}

export function cleanReply(text: string): string {
  const withoutLinks = stripLinks(stripMarkup(text));
  return withoutLinks
    .replace(EMOJI, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,!?;:])/g, '$1')
    .trim();
}

/** Whitespace-insensitive comparison, so a reply that only lost a newline does not count as changed. */
export function sameText(a: string, b: string): boolean {
  return a.replace(/\s+/g, ' ').trim() === b.replace(/\s+/g, ' ').trim();
}

/** Cuts `text` to at most `max` characters at the last sentence end (or word end when there is none). */
export function cutAtSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  const ends = [...head.matchAll(/[.!?](?=\s|$)/g)];
  const last = ends[ends.length - 1];
  if (last?.index !== undefined && last.index >= max * 0.4) return head.slice(0, last.index + 1);
  const word = head.lastIndexOf(' ');
  return (word > 0 ? head.slice(0, word) : head).replace(/[,;:\s]+$/, '').concat('.');
}
