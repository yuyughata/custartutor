// Skeletons for the things a person adds by hand. They are deliberately EMPTY of words: every text field starts
// blank, which the schema refuses, so nothing can be saved with a placeholder nobody wrote. Structure that must
// exist (two options for a multiple-choice question, one blank for a fill-in) is already there.
import {
  LAYER_FOR_TYPE,
  LESSON_SECTION_TYPES,
  OTHER_SECTION_TYPES,
  type BlockType,
  type Question,
  type QuestionKind,
  type Section,
  type SectionType,
  type TutorNode,
  type UnitKind,
} from '@custar/content-schema';

export function newTutorNode(id: string): TutorNode {
  return { id, say: '', on_correct: [], on_incorrect: [], hint: [] };
}

export function newBlock(type: BlockType): Record<string, unknown> {
  switch (type) {
    case 'paragraph':
      return { type, text: '' };
    case 'bullets':
      return { type, items: [{ text: '' }] };
    case 'definition':
      return { type, term: '', meaning: '' };
    case 'example':
      return { type, label: 'Example', text: '' };
    case 'dialogue':
      return { type, lines: [{ character: '', text: '' }] };
    case 'illustration':
      return { type, brief: '', alt: '' };
    case 'callout':
      return { type, tone: 'info', text: '' };
    case 'activity_steps':
      return { type, steps: [{ label: 'Step 1', text: '' }] };
    case 'table':
      return { type, headers: ['', ''], rows: [['', '']] };
    case 'question':
      return { type, question_id: '' };
  }
}

export const BLOCK_LABELS: Record<BlockType, string> = {
  paragraph: 'Paragraph',
  bullets: 'Bullet list',
  definition: 'Definition',
  example: 'Example',
  dialogue: 'Dialogue',
  illustration: 'Illustration',
  callout: 'Callout',
  activity_steps: 'Activity steps',
  table: 'Table',
  question: 'Question',
};

export function newSection(type: SectionType, id: string): Section {
  return {
    id,
    type,
    layer: LAYER_FOR_TYPE[type],
    heading: '',
    blocks: [newBlock('paragraph')],
  } as Section;
}

export const SECTION_TYPE_LABELS: Record<SectionType, string> = {
  story_opener: 'Story opener (Come and Explore)',
  concept: 'Concept',
  worked_examples: 'Worked examples',
  across_subjects: 'Across subjects',
  window_to_world: 'Window to the World',
  practice: 'Practice',
  do_and_discover: 'Do and Discover',
  tell_it_back: 'Tell It Back',
  remember: 'Remember',
  think_deeper: 'Think Deeper',
  quick_fire: 'Quick-Fire',
  character_values: 'Character values',
  mastery_check: 'Mastery check',
  revision_topic: 'Revision topic',
  assessment_part: 'Assessment part',
  project_part: 'Project part',
};

/** The section types that make sense for each kind of unit. */
export function sectionTypesFor(kind: UnitKind): readonly SectionType[] {
  switch (kind) {
    case 'lesson':
      return LESSON_SECTION_TYPES;
    case 'revision':
      return ['revision_topic'];
    case 'assessment':
      return ['assessment_part'];
    default:
      return ['project_part'];
  }
}

export const ALL_SECTION_TYPES: readonly SectionType[] = [
  ...LESSON_SECTION_TYPES,
  ...OTHER_SECTION_TYPES,
];

export function newQuestion(kind: QuestionKind, id: string, tier: 1 | 2 | 3 = 1): Question {
  const base = { id, tier, prompt: '' };
  switch (kind) {
    case 'mcq':
      return { ...base, kind, options: ['', ''], answer: { correct_index: 0 } };
    case 'fill_blank':
      return {
        ...base,
        kind,
        prompt: 'Fill in the blank: ____',
        answer: { blanks: [{ accepted: [''] }] },
      };
    case 'match':
      return {
        ...base,
        kind,
        answer: {
          pairs: [
            { left: '', right: '' },
            { left: '', right: '' },
          ],
        },
      };
    case 'circle':
      return { ...base, kind, options: ['', ''], answer: { correct: [] } };
    case 'sort':
      return { ...base, kind, items: ['', ''], categories: ['', ''], answer: { mapping: {} } };
    case 'tap_image':
      return {
        ...base,
        kind,
        brief: '',
        alt: '',
        answer: {
          hotspots: [{ id: 'hs_1', label: '', x: 0.1, y: 0.1, w: 0.3, h: 0.3, correct: true }],
        },
      };
    case 'speak':
      return { ...base, kind, answer: { expected: [''] } };
    case 'draw':
      return { ...base, kind, self_check: [] };
    case 'free_text':
      return { ...base, kind, rubric: { criteria: [''] } };
    case 'spoken':
      return { ...base, kind, rubric: { criteria: [''] } };
  }
}

export const QUESTION_KIND_LABELS: Record<QuestionKind, string> = {
  mcq: 'Multiple choice',
  fill_blank: 'Fill in the blank',
  match: 'Match',
  circle: 'Circle the right ones',
  sort: 'Sort into groups',
  tap_image: 'Tap the picture',
  speak: 'Say it (checked on the transcript)',
  draw: 'Draw (self-check)',
  free_text: 'Write (graded online)',
  spoken: 'Say it (graded online)',
};

/** Which kinds grant mastery when answered correctly: only deterministic ones, graded offline (CLAUDE.md rule 4). */
export const GRADED_OFFLINE: readonly QuestionKind[] = [
  'mcq',
  'fill_blank',
  'match',
  'circle',
  'sort',
  'tap_image',
  'speak',
];
