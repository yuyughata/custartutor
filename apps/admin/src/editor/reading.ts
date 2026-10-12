// The reading-level meter shown for each section: the average sentence length against the stage limit. It reuses the
// content-schema numbers (`averageSentenceLength`, `MAX_AVERAGE_SENTENCE_WORDS`), which are what the `reading_level`
// lint rule uses, so the meter and the lint warning can never disagree. The longest sentence is found here (the rule
// itself only needs the average) to tell the author where to cut.
import {
  MAX_AVERAGE_SENTENCE_WORDS,
  averageSentenceLength,
  stripInlineMarkup,
  type AnyBlock,
  type Stage,
} from '@custar/content-schema';

export type ReadingStatus = 'ok' | 'over' | 'no_text' | 'no_limit';

export interface ReadingMeter {
  /** Words per sentence over the prose of the section; null when it has no prose. */
  average: number | null;
  /** The limit for the unit's stage; null at the express stage (the rule does not apply). */
  limit: number | null;
  status: ReadingStatus;
  sentences: number;
  words: number;
  longest: { words: number; text: string } | null;
}

function wordsIn(sentence: string): number {
  return sentence.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

type Piece = { text: string; whole: boolean };

/** The prose pieces of a block, split the way the lint rule splits them (see lint.ts `proseOf`). */
function piecesOf(block: AnyBlock): Piece[] {
  switch (block.type) {
    case 'paragraph':
    case 'callout':
      return [{ text: block.text, whole: false }];
    case 'bullets':
      return block.items.map((item) => ({
        text: item.lead ? `${item.lead} ${item.text}` : item.text,
        whole: true,
      }));
    case 'definition':
      return [{ text: `${block.term} ${block.meaning}`, whole: true }];
    case 'example':
      return [{ text: `${block.label} ${block.text}`, whole: false }];
    case 'dialogue':
      return block.lines.map((line) => ({ text: line.text, whole: false }));
    case 'activity_steps':
      return block.steps.map((step) => ({ text: `${step.label} ${step.text}`, whole: true }));
    default:
      return [];
  }
}

export function readingMeter(blocks: readonly AnyBlock[], stage: Stage): ReadingMeter {
  const limit = stage === 'express' ? null : MAX_AVERAGE_SENTENCE_WORDS;
  let sentences = 0;
  let words = 0;
  let longest: ReadingMeter['longest'] = null;
  for (const block of blocks) {
    for (const piece of piecesOf(block)) {
      const text = stripInlineMarkup(piece.text).trim();
      if (text === '') continue;
      const parts = piece.whole ? [text] : text.split(/(?<=[.!?])\s+/);
      for (const part of parts) {
        const count = wordsIn(part);
        if (count === 0) continue;
        sentences += 1;
        words += count;
        if (longest === null || count > longest.words) longest = { words: count, text: part.trim() };
      }
    }
  }
  const average = averageSentenceLength(blocks);
  const status: ReadingStatus =
    average === null ? 'no_text' : limit === null ? 'no_limit' : average > limit ? 'over' : 'ok';
  return { average, limit, status, sentences, words, longest };
}

export function readingLabel(meter: ReadingMeter): string {
  if (meter.average === null) return 'No sentences yet';
  const average = `${meter.average.toFixed(1)} words per sentence`;
  if (meter.limit === null) return `${average} (no limit at this stage)`;
  return meter.status === 'over'
    ? `${average}: over the limit of ${meter.limit}`
    : `${average}: within the limit of ${meter.limit}`;
}
