// Fixed, human-approved replies (settings.safe_replies) and how they are streamed: a few `delta` events, never a
// model call. If the owner left a reply blank or the setting is missing, the draft default is used rather than
// sending the child nothing.
import { DEFAULT_SAFE_REPLIES } from '../contract';
import type { SafeReplyKey, TutorSettings } from '../contract';

export function fixedReplyText(settings: Pick<TutorSettings, 'safe_replies'>, key: SafeReplyKey): string {
  const configured = settings.safe_replies[key];
  return configured !== undefined && configured.trim() !== '' ? configured : DEFAULT_SAFE_REPLIES[key];
}

/** Splits a reply into at most `parts` chunks at sentence ends, so the stream looks like a short typed reply. */
export function chunkReply(text: string, parts = 3): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*\s*/g) ?? [text];
  if (sentences.length <= 1) {
    const words = text.split(' ');
    if (words.length < 6) return [text];
    const half = Math.ceil(words.length / 2);
    return [`${words.slice(0, half).join(' ')} `, words.slice(half).join(' ')];
  }
  const size = Math.ceil(sentences.length / parts);
  const chunks: string[] = [];
  for (let i = 0; i < sentences.length; i += size) chunks.push(sentences.slice(i, i + size).join(''));
  return chunks.map((chunk) => chunk).filter((chunk) => chunk !== '');
}
