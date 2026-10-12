// Maps a child's typed reply onto the response shape of a question, so the content-schema grader can mark it.
// Only where that is sensible: choices (mcq, circle), blanks, simple "left - right" lists (match, sort), spoken
// words and image labels. Everything else (drawings, free text) cannot be graded from a typed line; the engine
// then treats the reply as a self-report.
import { normalizeText } from '@custar/content-schema';
import type { Question, QuestionResponse } from '@custar/content-schema';
import { splitList } from './match';

const PAIR_SPLIT =
  /\s*(?:->|→|=>|=|:|–|—|-|\bgoes (?:with|in|to)\b|\bmatches\b|\bwith\b|\bin\b|\bto\b)\s*/i;

function parsePairs(text: string): Array<[string, string]> {
  const pairs: Array<[string, string]> = [];
  for (const part of text.split(/\s*[,;\n]\s*/)) {
    const pieces = part.split(PAIR_SPLIT).filter((piece) => piece.trim() !== '');
    if (pieces.length === 2)
      pairs.push([(pieces[0] as string).trim(), (pieces[1] as string).trim()]);
  }
  return pairs;
}

function optionIndex(options: readonly string[], text: string): number {
  const wanted = normalizeText(text);
  const exact = options.findIndex((option) => normalizeText(option) === wanted);
  if (exact !== -1) return exact;
  const letter = /^(?:option\s+)?([a-f])[.)]?$/.exec(wanted);
  if (letter) return (letter[1] as string).charCodeAt(0) - 97;
  const number = /^(?:number\s+)?(\d)[.)]?$/.exec(wanted);
  if (number) return Number(number[1]) - 1;
  return -1;
}

/** The response for `question`, or null when a typed line cannot answer it. */
export function toResponse(question: Question, reply: string): QuestionResponse | null {
  switch (question.kind) {
    case 'mcq': {
      const index = optionIndex(question.options, reply);
      return { kind: 'mcq', selected_index: index >= question.options.length ? -1 : index };
    }
    case 'fill_blank': {
      const blanks = question.answer.blanks.length;
      if (blanks === 1) return { kind: 'fill_blank', answers: [reply] };
      const parts = splitList(reply);
      return {
        kind: 'fill_blank',
        answers: Array.from({ length: blanks }, (_, i) => parts[i] ?? ''),
      };
    }
    case 'circle': {
      const selected = splitList(reply).map((part) => {
        const index = optionIndex(question.options, part);
        return index === -1 ? part : (question.options[index] as string);
      });
      return { kind: 'circle', selected };
    }
    case 'match': {
      const pairs = parsePairs(reply).map(([left, right]) => ({ left, right }));
      return pairs.length === 0 ? null : { kind: 'match', pairs };
    }
    case 'sort': {
      const placements: Record<string, string> = {};
      for (const [item, category] of parsePairs(reply)) placements[item] = category;
      return Object.keys(placements).length === 0 ? null : { kind: 'sort', placements };
    }
    case 'tap_image': {
      const wanted = new Set(splitList(reply).map(normalizeText));
      const hotspot_ids = question.answer.hotspots
        .filter((hotspot) => wanted.has(normalizeText(hotspot.label)))
        .map((hotspot) => hotspot.id);
      return { kind: 'tap_image', hotspot_ids };
    }
    case 'speak':
      return { kind: 'speak', transcript: reply };
    default:
      return null;
  }
}
