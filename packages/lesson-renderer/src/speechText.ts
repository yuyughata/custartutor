import type { AnyBlock, Question, Section } from '@custar/content-schema';
import { BLANK_PATTERN, stripInlineMarkup } from '@custar/content-schema';

/**
 * What a read-aloud button says for a block, a question or a whole section. Pure text, no markup: the
 * `**bold**` markers are removed and a blank in a fill-in-the-blank prompt is spoken as the word "blank".
 *
 * RULE: this never speaks anything the child must work out. Answers, hints and explanations are NOT read;
 * options are read in the order they are shown so a child who cannot read yet can still choose.
 */

const BLANK_WORD = 'blank';

/** Makes sure a spoken piece ends with a full stop (or ? ! :) so the voice pauses between pieces. */
function sentence(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return '';
  return /[.!?:;]$/.test(clean) ? clean : `${clean}.`;
}

function plain(text: string): string {
  return stripInlineMarkup(text).replace(BLANK_PATTERN, BLANK_WORD);
}

function list(items: readonly string[]): string {
  return items.map((item) => sentence(plain(item))).join(' ');
}

function join(pieces: readonly string[]): string {
  return pieces
    .map((piece) => piece.trim())
    .filter((piece) => piece !== '')
    .join(' ');
}

/** The question as it should be read to a child: the prompt, then what they can choose or do. */
export function questionSpeechText(question: Question): string {
  const prompt = sentence(plain(question.prompt));
  switch (question.kind) {
    case 'mcq':
      return join([prompt, 'Choose one.', list(question.options)]);
    case 'fill_blank':
      return prompt;
    case 'match': {
      const lefts = question.answer.pairs.map((pair) => pair.left);
      // The right-hand items in the same fixed order the screen shows them (alphabetical).
      const rights = [
        ...question.answer.pairs.map((pair) => pair.right),
        ...(question.distractors ?? []),
      ].sort((a, b) => a.localeCompare(b));
      return join([prompt, 'Match these.', list(lefts), 'With these.', list(rights)]);
    }
    case 'circle':
      return join([prompt, list(question.options)]);
    case 'sort':
      return join([
        prompt,
        'Sort these.',
        list(question.items),
        `Put each one with: ${question.categories.map(plain).join(', or ')}.`,
      ]);
    case 'tap_image':
      return join([
        prompt,
        sentence(`Look at the picture. ${plain(question.alt)}`),
        list(question.answer.hotspots.map((hotspot) => hotspot.label)),
      ]);
    case 'speak':
    case 'spoken':
      return join([prompt, 'Say it out loud.']);
    case 'draw':
      return join([prompt, 'Draw it, then check your drawing.', list(question.self_check ?? [])]);
    case 'free_text':
      return prompt;
  }
}

export interface SpeechTextContext {
  /** The unit's questions by id, to read the questions placed in a section. */
  questions: Readonly<Record<string, Question>>;
}

/** The text of one block. A block this build does not understand says nothing. */
export function blockSpeechText(block: AnyBlock, context: SpeechTextContext): string {
  switch (block.type) {
    case 'paragraph':
      return sentence(plain(block.text));
    case 'bullets':
      return join(
        block.items.map((item) =>
          sentence(plain(item.lead ? `${item.lead}: ${item.text}` : item.text)),
        ),
      );
    case 'definition':
      return join([sentence(plain(block.term)), sentence(plain(block.meaning))]);
    case 'example':
      return sentence(plain(`${block.label} ${block.text}`));
    case 'dialogue':
      return join(
        block.lines.map((line) => sentence(plain(`${line.character} says: ${line.text}`))),
      );
    case 'illustration':
      return sentence(`Picture: ${plain(block.alt)}`);
    case 'callout':
      return sentence(plain(block.text));
    case 'activity_steps':
      return join(block.steps.map((step) => sentence(plain(`${step.label}. ${step.text}`))));
    case 'table':
      return join(
        block.rows.map((row) =>
          sentence(
            row
              .map((cell, index) => `${plain(block.headers[index] ?? '')}: ${plain(cell)}`)
              .join(', '),
          ),
        ),
      );
    case 'question': {
      const question = Object.hasOwn(context.questions, block.question_id)
        ? context.questions[block.question_id]
        : undefined;
      return question ? questionSpeechText(question) : '';
    }
    case 'unknown':
      return '';
  }
}

/** The whole section, heading first. Used by the "Listen" button and by narration for pre-readers. */
export function sectionSpeechText(
  section: Section,
  questions: Readonly<Record<string, Question>>,
): string {
  const context: SpeechTextContext = { questions };
  return join([
    sentence(plain(section.heading)),
    ...section.blocks.map((block) => blockSpeechText(block, context)),
  ]);
}
