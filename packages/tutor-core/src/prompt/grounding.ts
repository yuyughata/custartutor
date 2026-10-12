// buildGrounding: what the tutor model may know about the unit the child is playing, built from the PUBLISHED unit.
//
// Included: the NERDC objective verbatim, the key terms, a plain-text digest of every section, and the practice
// questions with their answers. The mastery check appears as PROMPTS ONLY: no answers, no options, no hints, no
// explanations, no remedial callouts (CLAUDE.md rule 4: only the deterministic grading of the mastery check
// grants mastery, so the tutor must not be able to hand over its answers). The teacher's manual, the helper
// script and the tutor scripts are not included either.
import { questionsOf, sectionsOf, stripInlineMarkup } from '@custar/content-schema';
import type { AnyBlock, Question, UnitContent } from '@custar/content-schema';
import type { TutorGrounding } from '../contract';
import { answerGroups, answerText, promptText } from './answerText';
import { sectionDigest, withheldQuestionIds } from './digest';

export interface GroundingOptions {
  versionNo: number;
  unitId: string;
  /** The subject's display name; defaults to the subject slug in capitals ("basic-science" -> "Basic Science"). */
  subjectName?: string;
}

const MAX_VOCABULARY = 40;
const MAX_PRACTICE = 60;

function humanise(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word === '' ? word : word[0]?.toUpperCase() + word.slice(1)))
    .join(' ');
}

/** `The **classroom** — where we learn` -> { term, meaning }. A short lead-in before the bold term is allowed. */
function boldDefinition(text: string): { term: string; meaning: string } | null {
  const match = /^(.{0,24}?)\*\*(.+?)\*\*\s*[\u2014\u2013:-]\s*(.+)$/.exec(text);
  if (!match || (match[1] as string).trim().split(/\s+/).filter(Boolean).length > 3) return null;
  const term = stripInlineMarkup(match[2] as string).trim();
  const meaning = stripInlineMarkup(match[3] as string).trim();
  return term === '' || meaning === '' ? null : { term, meaning };
}

function termsOf(block: AnyBlock): Array<{ term: string; meaning: string }> {
  if (block.type === 'definition') {
    return [{ term: stripInlineMarkup(block.term), meaning: stripInlineMarkup(block.meaning) }];
  }
  if (block.type === 'bullets') {
    return block.items.flatMap((item) => {
      if (item.lead) {
        return [{ term: stripInlineMarkup(item.lead), meaning: stripInlineMarkup(item.text) }];
      }
      const bold = boldDefinition(item.text);
      return bold ? [bold] : [];
    });
  }
  if (block.type === 'paragraph') {
    const bold = boldDefinition(block.text);
    return bold ? [bold] : [];
  }
  return [];
}

export function buildGrounding(unit: UnitContent, options: GroundingOptions): TutorGrounding {
  const questions = questionsOf(unit);
  const withheld = withheldQuestionIds(unit);
  const sections = sectionsOf(unit);

  const vocabulary: TutorGrounding['vocabulary'] = [];
  const seen = new Set<string>();
  for (const section of sections) {
    if (section.type === 'mastery_check') continue;
    for (const block of section.blocks) {
      for (const entry of termsOf(block)) {
        const key = entry.term.toLowerCase();
        if (seen.has(key) || vocabulary.length >= MAX_VOCABULARY) continue;
        seen.add(key);
        vocabulary.push(entry);
      }
    }
  }

  // practice: questions in the order a child meets them, then the rest of the unit's pool (workbook, variants)
  const order: string[] = [];
  for (const section of sections) {
    for (const block of section.blocks) {
      if (block.type === 'question' && !order.includes(block.question_id))
        order.push(block.question_id);
    }
  }
  for (const id of Object.keys(questions)) if (!order.includes(id)) order.push(id);
  const known = (id: string): id is string => questions[id] !== undefined;

  const practice = order
    .filter((id) => known(id) && !withheld.has(id))
    .slice(0, MAX_PRACTICE)
    .map((id) => {
      const question = questions[id] as Question;
      return { id, prompt: promptText(question), answer: answerText(question) };
    });
  const mastery_prompts = order
    .filter((id) => known(id) && withheld.has(id))
    .map((id) => ({ id, prompt: promptText(questions[id] as Question) }));

  return {
    unit_id: options.unitId,
    version_no: options.versionNo,
    title: stripInlineMarkup(unit.header.title),
    subject_name: options.subjectName ?? humanise(unit.header.subject_slug),
    level_code: unit.header.level_code,
    stage: unit.header.stage,
    objective: unit.header.objective,
    vocabulary,
    sections: sections.map((section) => ({
      id: section.id,
      heading: stripInlineMarkup(section.heading),
      type: section.type,
      digest: sectionDigest(section, questions),
    })),
    practice,
    mastery_prompts,
  };
}

/**
 * The mastery-check answers as groups of phrases that belong together, for the reply sanitiser ONLY. They are
 * matched against what the model writes; they are never put in a prompt. Pass the result as `mastery_guard`.
 */
export function buildMasteryGuard(unit: UnitContent): string[][] {
  const questions = questionsOf(unit);
  const groups: string[][] = [];
  for (const id of withheldQuestionIds(unit)) {
    const question = questions[id];
    if (!question) continue;
    for (const group of answerGroups(question)) {
      const cleaned = group
        .map((phrase) => stripInlineMarkup(phrase).trim())
        .filter((p) => p.length >= 3);
      if (cleaned.length > 0 && cleaned.length === group.length) groups.push(cleaned);
    }
  }
  return groups;
}
