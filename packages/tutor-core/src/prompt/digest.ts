// Plain-text digests of blocks and sections for the tutor's grounding. Only what a child may be taught goes in;
// the teacher's manual, the helper script, hints and explanations of withheld questions never do.
import { questionsOf, sectionsOf, stripInlineMarkup } from '@custar/content-schema';
import type { AnyBlock, Question, Section, UnitContent } from '@custar/content-schema';
import { promptText } from './answerText';

const MAX_SECTION_CHARS = 600;
const MAX_TABLE_ROWS = 6;

function plain(text: string): string {
  return stripInlineMarkup(text).replace(/\s+/g, ' ').trim();
}

export function blockDigest(block: AnyBlock, questions: Record<string, Question>): string | null {
  switch (block.type) {
    case 'paragraph':
    case 'callout':
      return plain(block.text);
    case 'bullets':
      return block.items
        .map((item) => plain(item.lead ? `${item.lead}: ${item.text}` : item.text))
        .join('; ');
    case 'definition':
      return `${plain(block.term)}: ${plain(block.meaning)}`;
    case 'example':
      return `${plain(block.label)}: ${plain(block.text)}`;
    case 'dialogue':
      return block.lines.map((line) => `${plain(line.character)}: ${plain(line.text)}`).join(' ');
    case 'illustration':
      return `Picture: ${plain(block.alt)}`;
    case 'activity_steps':
      return block.steps.map((step) => `${plain(step.label)} ${plain(step.text)}`).join('; ');
    case 'table':
      return [
        block.headers.join(' | '),
        ...block.rows.slice(0, MAX_TABLE_ROWS).map((r) => r.join(' | ')),
      ].join('; ');
    case 'question': {
      const question = questions[block.question_id];
      return question ? `Question: ${promptText(question)}` : null;
    }
    case 'unknown':
      return null;
  }
}

/** Block types a mastery-check section may contribute: its introduction and the question prompts, nothing else. */
const MASTERY_BLOCKS: ReadonlySet<string> = new Set(['paragraph', 'question']);

export function sectionDigest(section: Section, questions: Record<string, Question>): string {
  const mastery = section.type === 'mastery_check';
  const parts: string[] = [];
  for (const block of section.blocks) {
    if (mastery && !MASTERY_BLOCKS.has(block.type)) continue;
    const text = blockDigest(block, questions);
    if (text !== null && text !== '') parts.push(text);
  }
  const joined = parts.join(' ');
  return joined.length > MAX_SECTION_CHARS
    ? `${joined.slice(0, MAX_SECTION_CHARS - 3).trimEnd()}...`
    : joined;
}

/** Ids of the questions whose answers the tutor must not have: every question of a mastery check or an assessment. */
export function withheldQuestionIds(unit: UnitContent): Set<string> {
  const ids = new Set<string>();
  if (unit.kind === 'assessment') {
    for (const id of Object.keys(questionsOf(unit))) ids.add(id);
    return ids;
  }
  for (const section of sectionsOf(unit)) {
    if (section.type !== 'mastery_check') continue;
    for (const block of section.blocks) if (block.type === 'question') ids.add(block.question_id);
  }
  return ids;
}
