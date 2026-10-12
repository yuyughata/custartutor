// Authoring shapes <-> the final content-schema shapes.
//
// FORWARD (model -> unit): the model writes flat blocks, questions and tutor lines that point at each other with
// short `ref` names. This module assigns the real ids, builds the final shapes and validates them with the real
// Zod schemas, returning readable problems (with paths) that the engine feeds back to the model for one repair.
// BACKWARD (unit -> model): the same shapes rebuilt from a final unit, for the revise prompt and the demo model.
import {
  Question,
  Section,
  TutorScript,
  countBlanks,
  formatZodIssues,
  isDeterministic,
  normalizeText,
  stripInlineMarkup,
  type AnyBlock,
  type Block,
  type SectionType,
} from '@custar/content-schema';
import type {
  AuthorBlock,
  AuthorQuestion,
  AuthorSectionBody,
  AuthorTutorLine,
} from '../prompts/schemas';
import { layerFor, questionId } from './sections';
import { clean, cleanAll, toSkillTag, unique } from './util';

type Rec = Record<string, unknown>;

export interface Mapped<T> {
  value: T | null;
  issues: string[];
}

function norm(value: string): string {
  return normalizeText(value);
}

function distinct(values: readonly string[]): boolean {
  return new Set(values.map(norm)).size === values.length;
}

// ---------------------------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------------------------

/** Builds the final question for an authoring question. `where` prefixes every problem ("questions[2]"). */
export function mapQuestion(q: AuthorQuestion, id: string, where: string): Mapped<Question> {
  const issues: string[] = [];
  const bad = (message: string) => issues.push(`${where}: ${message}`);

  const prompt = clean(q.prompt);
  if (prompt === '') bad('prompt is empty');
  if (![1, 2, 3].includes(q.tier)) bad(`tier must be 1, 2 or 3 (got ${String(q.tier)})`);

  const common: Rec = { id, tier: q.tier, prompt };
  const hint = clean(q.hint);
  const explanation = clean(q.explanation);
  const skill = toSkillTag(q.skill_tag);
  if (hint !== '') common['hint'] = hint;
  if (explanation !== '') common['explanation'] = explanation;
  if (skill) common['skill_tag'] = skill;

  let built: Rec | null = null;
  switch (q.kind) {
    case 'mcq': {
      const options = cleanAll(q.options);
      const answers = cleanAll(q.answers);
      if (options.length < 2 || options.length > 6) bad('mcq needs 2 to 6 options');
      if (!distinct(options)) bad('mcq options must be distinct');
      if (answers.length !== 1) {
        bad('mcq `answers` must hold exactly one entry: the text of the correct option');
      } else {
        const index = options.findIndex((option) => norm(option) === norm(answers[0]!));
        if (index === -1) bad(`mcq answer "${answers[0]}" is not one of the options`);
        else built = { ...common, kind: 'mcq', options, answer: { correct_index: index } };
      }
      break;
    }
    case 'circle': {
      const options = cleanAll(q.options);
      const answers = cleanAll(q.answers);
      if (options.length < 2 || options.length > 12) bad('circle needs 2 to 12 options');
      if (!distinct(options)) bad('circle options must be distinct');
      if (answers.length < 1) bad('circle `answers` must list every correct option');
      const correct: string[] = [];
      for (const answer of answers) {
        const found = options.find((option) => norm(option) === norm(answer));
        if (found === undefined) bad(`circle answer "${answer}" is not one of the options`);
        else if (!correct.includes(found)) correct.push(found);
      }
      if (correct.length > 0 && correct.length === options.length) {
        bad('circle: every option is correct, so there is nothing to choose');
      }
      built = { ...common, kind: 'circle', options, answer: { correct } };
      break;
    }
    case 'fill_blank': {
      const blanks = q.blanks.map(cleanAll);
      const found = countBlanks(prompt);
      if (blanks.length === 0)
        bad('fill_blank needs `blanks`: the accepted answers for each blank');
      if (found !== blanks.length) {
        bad(
          `the prompt has ${found} blank(s) (a run of three underscores, ____) but \`blanks\` lists ${blanks.length}`,
        );
      }
      if (blanks.some((accepted) => accepted.length === 0))
        bad('every blank needs at least one accepted answer');
      const units = cleanAll(q.units);
      built = {
        ...common,
        kind: 'fill_blank',
        answer: {
          blanks: blanks.map((accepted) => ({
            accepted,
            ...(q.numeric ? { numeric: true } : {}),
            ...(q.numeric && units.length > 0 ? { units } : {}),
          })),
        },
      };
      break;
    }
    case 'match': {
      const pairs = q.pairs
        .map((pair) => ({ left: clean(pair.left), right: clean(pair.right) }))
        .filter((pair) => pair.left !== '' || pair.right !== '');
      if (pairs.length < 2) bad('match needs at least 2 pairs');
      if (pairs.some((pair) => pair.left === '' || pair.right === ''))
        bad('every pair needs a left and a right');
      if (!distinct(pairs.map((pair) => pair.left)))
        bad('the left items of a match must be distinct');
      built = { ...common, kind: 'match', answer: { pairs } };
      break;
    }
    case 'sort': {
      const pairs = q.pairs
        .map((pair) => ({ left: clean(pair.left), right: clean(pair.right) }))
        .filter((pair) => pair.left !== '' || pair.right !== '');
      const items = pairs.map((pair) => pair.left);
      const categories = unique(pairs.map((pair) => pair.right));
      if (items.length < 2) bad('sort needs at least 2 items');
      if (categories.length < 2)
        bad('sort needs at least 2 categories (the `right` side of the pairs)');
      if (pairs.some((pair) => pair.left === '' || pair.right === ''))
        bad('every sort pair needs an item and a category');
      if (!distinct(items)) bad('sort items must be distinct');
      if (!distinct(categories)) bad('sort categories must be distinct (watch capital letters)');
      built = {
        ...common,
        kind: 'sort',
        items,
        categories,
        answer: { mapping: Object.fromEntries(pairs.map((pair) => [pair.left, pair.right])) },
      };
      break;
    }
    case 'free_text': {
      const criteria = cleanAll(q.checks);
      if (criteria.length === 0) bad('free_text needs rubric criteria in `checks`');
      const exemplar = clean(q.exemplar);
      built = {
        ...common,
        kind: 'free_text',
        rubric: { criteria, ...(exemplar !== '' ? { exemplar } : {}) },
      };
      break;
    }
    case 'draw': {
      const selfCheck = cleanAll(q.checks);
      built = {
        ...common,
        kind: 'draw',
        ...(selfCheck.length > 0 ? { self_check: selfCheck } : {}),
      };
      break;
    }
  }

  if (issues.length > 0 || built === null) return { value: null, issues };
  const parsed = Question.safeParse(built);
  if (!parsed.success) {
    for (const issue of formatZodIssues(parsed.error)) {
      bad(`${issue.path === '' ? '' : `${issue.path}: `}${issue.message}`);
    }
    return { value: null, issues };
  }
  return { value: parsed.data, issues };
}

export interface MappedQuestions {
  questions: Question[];
  /** ref -> final id */
  refs: Map<string, string>;
  issues: string[];
}

/** Maps the questions a section owns. Ids are `q_<section>_<n>` by position. */
export function mapSectionQuestions(
  sectionId: string,
  authored: readonly AuthorQuestion[],
  firstIndex = 1,
): MappedQuestions {
  const questions: Question[] = [];
  const refs = new Map<string, string>();
  const issues: string[] = [];
  authored.forEach((q, index) => {
    const id = questionId(sectionId, firstIndex + index);
    const ref = clean(q.ref) || `q${index + 1}`;
    if (refs.has(ref))
      issues.push(`questions[${index}]: ref "${ref}" is used twice; refs must be unique`);
    refs.set(ref, id);
    const mapped = mapQuestion(q, id, `questions[${index}] (ref "${ref}")`);
    issues.push(...mapped.issues);
    if (mapped.value) questions.push(mapped.value);
  });
  return { questions, refs, issues };
}

// ---------------------------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------------------------

function refList(refs: ReadonlyMap<string, string>): string {
  return refs.size === 0 ? '(this section has no questions)' : [...refs.keys()].join(', ');
}

export function mapBlock(
  b: AuthorBlock,
  refs: ReadonlyMap<string, string>,
  where: string,
): Mapped<Block> {
  const issues: string[] = [];
  const bad = (message: string) => issues.push(`${where} (${b.type}): ${message}`);
  const text = clean(b.text);
  let block: Rec | null = null;

  switch (b.type) {
    case 'paragraph':
      if (text === '') bad('`text` is empty');
      else block = { type: 'paragraph', text };
      break;
    case 'bullets': {
      const items = b.items
        .map((item) => ({ head: clean(item.head), text: clean(item.text) }))
        .filter((item) => item.head !== '' || item.text !== '');
      if (items.length === 0) bad('`items` is empty');
      else if (items.some((item) => item.text === '')) bad('every bullet needs `text`');
      else
        block = {
          type: 'bullets',
          items: items.map((item) =>
            item.head !== '' ? { lead: item.head, text: item.text } : { text: item.text },
          ),
        };
      break;
    }
    case 'definition': {
      const term = clean(b.label);
      if (term === '' || text === '') bad('needs `label` (the word) and `text` (its meaning)');
      else block = { type: 'definition', term, meaning: text };
      break;
    }
    case 'example': {
      const label = clean(b.label);
      if (label === '' || text === '') bad('needs `label` and `text`');
      else block = { type: 'example', label, text };
      break;
    }
    case 'dialogue': {
      const lines = b.items
        .map((item) => ({ character: clean(item.head), text: clean(item.text) }))
        .filter((line) => line.character !== '' || line.text !== '');
      if (lines.length === 0) bad('`items` is empty');
      else if (lines.some((line) => line.character === '' || line.text === ''))
        bad('every line needs `head` (the speaker) and `text`');
      else block = { type: 'dialogue', lines };
      break;
    }
    case 'illustration': {
      const brief = clean(b.brief);
      const alt = clean(b.alt);
      if (brief === '' || alt === '')
        bad(
          'needs `brief` (what to draw) and `alt` (what a child who cannot see it needs to know)',
        );
      else block = { type: 'illustration', brief, alt };
      break;
    }
    case 'callout': {
      if (b.tone === 'none') bad('`tone` must be info, tip or not_yet');
      else if (text === '') bad('`text` is empty');
      else block = { type: 'callout', tone: b.tone, text };
      break;
    }
    case 'activity_steps': {
      const steps = b.items
        .map((item) => ({ label: clean(item.head), text: clean(item.text) }))
        .filter((step) => step.label !== '' || step.text !== '');
      if (steps.length === 0) bad('`items` is empty');
      else if (steps.some((step) => step.label === '' || step.text === ''))
        bad('every step needs `head` (a short LABEL) and `text`');
      else block = { type: 'activity_steps', steps };
      break;
    }
    case 'table': {
      const headers = cleanAll(b.headers);
      const rows = b.rows.map((row) => row.map(clean));
      if (headers.length === 0 || rows.length === 0) bad('needs `headers` and `rows`');
      else if (rows.some((row) => row.length !== headers.length))
        bad(`every row must have ${headers.length} cells, one per header`);
      else block = { type: 'table', headers, rows };
      break;
    }
    case 'question': {
      const ref = clean(b.question_ref);
      const id = refs.get(ref);
      if (id === undefined) {
        bad(
          `question_ref "${ref}" is not one of this section's questions (known refs: ${refList(refs)})`,
        );
      } else block = { type: 'question', question_id: id };
      break;
    }
  }
  return { value: block as Block | null, issues };
}

export interface MappedBlocks {
  blocks: Block[];
  issues: string[];
}

export function mapBlocks(
  authored: readonly AuthorBlock[],
  refs: ReadonlyMap<string, string>,
): MappedBlocks {
  const blocks: Block[] = [];
  const issues: string[] = [];
  authored.forEach((b, index) => {
    const mapped = mapBlock(b, refs, `blocks[${index}]`);
    issues.push(...mapped.issues);
    if (mapped.value) blocks.push(mapped.value);
  });
  return { blocks, issues };
}

/** Appends a `question` block for every owned question the blocks do not place yet (before a closing not_yet callout). */
export function placeUnplacedQuestions(blocks: Block[], questionIds: readonly string[]): Block[] {
  const placed = new Set(
    blocks.flatMap((block) => (block.type === 'question' ? [block.question_id] : [])),
  );
  const missing = questionIds.filter((id) => !placed.has(id));
  if (missing.length === 0) return blocks;
  const extra: Block[] = missing.map((id) => ({ type: 'question', question_id: id }));
  const last = blocks[blocks.length - 1];
  if (last && last.type === 'callout' && last.tone === 'not_yet') {
    return [...blocks.slice(0, -1), ...extra, last];
  }
  return [...blocks, ...extra];
}

// ---------------------------------------------------------------------------------------------
// Tutor script
// ---------------------------------------------------------------------------------------------

export function mapTutorScript(
  lines: readonly AuthorTutorLine[],
  refs: ReadonlyMap<string, string>,
): Mapped<TutorScript> {
  const issues: string[] = [];
  if (lines.length === 0) return { value: null, issues };
  const nodes: Rec[] = [];
  lines.forEach((line, index) => {
    const where = `tutor_script[${index}]`;
    const bad = (message: string) => issues.push(`${where}: ${message}`);
    const say = clean(line.say);
    if (say === '') {
      bad('`say` is empty');
      return;
    }
    const accepted = cleanAll(line.accepted);
    const ref = clean(line.question_ref);
    const node: Rec = { id: `n_${index + 1}`, say };
    if (accepted.length > 0 && ref !== '') {
      bad('use either `accepted` or `question_ref`, not both');
    } else if (ref !== '') {
      const id = refs.get(ref);
      if (id === undefined)
        bad(
          `question_ref "${ref}" is not one of this section's questions (known refs: ${refList(refs)})`,
        );
      else node['expect'] = { question_id: id };
    } else if (accepted.length > 0) {
      node['expect'] = { accepted };
    }
    const onCorrect = cleanAll(line.on_correct);
    const onIncorrect = cleanAll(line.on_incorrect);
    if (node['expect'] !== undefined && (onCorrect.length === 0 || onIncorrect.length === 0)) {
      bad(
        'a line that asks something needs at least one `on_correct` and one `on_incorrect` reply',
      );
    }
    node['on_correct'] = onCorrect;
    node['on_incorrect'] = onIncorrect;
    node['hint'] = cleanAll(line.hint);
    nodes.push(node);
  });
  if (issues.length > 0) return { value: null, issues };
  const parsed = TutorScript.safeParse({ nodes });
  if (!parsed.success) {
    return {
      value: null,
      issues: formatZodIssues(parsed.error).map(
        (issue) => `tutor_script.${issue.path}: ${issue.message}`,
      ),
    };
  }
  return { value: parsed.data, issues };
}

// ---------------------------------------------------------------------------------------------
// A whole section
// ---------------------------------------------------------------------------------------------

/** A built section and the questions it owns: what a `section:<id>` step stores. */
export interface SectionPart {
  section: Section;
  questions: Question[];
}

function thinkDeeperPromptCount(blocks: readonly Block[]): number {
  let count = 0;
  for (const block of blocks) {
    if (block.type === 'bullets') count += block.items.length;
    else if (block.type === 'paragraph')
      count += (stripInlineMarkup(block.text).match(/\?/g) ?? []).length;
    else if (block.type === 'activity_steps')
      count += block.steps.filter((s) => s.text.includes('?')).length;
    else if (block.type === 'question') count += 1;
  }
  return count;
}

export interface BuildSectionArgs {
  id: string;
  type: SectionType;
  heading: string;
  body: AuthorSectionBody;
}

/**
 * Turns a section step's reply into a section part, or into a list of problems. Applies the per-type rules
 * (practice covers all three tiers, the mastery check is auto-gradable, and so on).
 */
export function buildSectionPart(args: BuildSectionArgs): {
  part: SectionPart | null;
  issues: string[];
} {
  const { id, type, heading, body } = args;
  const mappedQuestions = mapSectionQuestions(id, body.questions);
  const mappedBlocks = mapBlocks(body.blocks, mappedQuestions.refs);
  const tutor = mapTutorScript(body.tutor_script, mappedQuestions.refs);
  const issues = [...mappedQuestions.issues, ...mappedBlocks.issues, ...tutor.issues];

  if (body.blocks.length === 0) issues.push('blocks: the section has no blocks');

  const questions = mappedQuestions.questions;
  const byTier = (tier: number) => questions.filter((q) => q.tier === tier).length;
  switch (type) {
    case 'practice':
      for (const tier of [1, 2, 3]) {
        if (byTier(tier) === 0)
          issues.push(`questions: practice needs at least one tier ${tier} question`);
      }
      if (questions.length < 5)
        issues.push('questions: practice needs 5 to 8 questions across the three tiers');
      break;
    case 'quick_fire':
      if (questions.length < 3) issues.push('questions: quick_fire needs about 5 short questions');
      if (questions.filter((q) => isDeterministic(q)).length < 3) {
        issues.push(
          'questions: quick_fire questions must be auto-gradable (mcq, fill_blank, circle, match, sort)',
        );
      }
      break;
    case 'mastery_check':
      if (questions.length < 2) issues.push('questions: mastery_check needs 3 questions');
      for (const q of questions) {
        if (!isDeterministic(q)) {
          issues.push(
            `questions: ${q.id} is ${q.kind}, which the app cannot grade; the mastery check may only use mcq, fill_blank, match, circle or sort`,
          );
        }
      }
      break;
    case 'think_deeper':
      if (thinkDeeperPromptCount(mappedBlocks.blocks) < 2) {
        issues.push(
          'blocks: think_deeper needs at least 2 prompts (a bullets block with one prompt per item)',
        );
      }
      break;
    default:
      break;
  }

  if (issues.length > 0) return { part: null, issues };

  const blocks = placeUnplacedQuestions(
    mappedBlocks.blocks,
    questions.map((q) => q.id),
  );
  const candidate: Rec = {
    id,
    type,
    layer: layerFor(type),
    heading: clean(heading),
    blocks,
    ...(tutor.value ? { tutor_script: tutor.value } : {}),
  };
  const parsed = Section.safeParse(candidate);
  if (!parsed.success) {
    return {
      part: null,
      issues: formatZodIssues(parsed.error).map(
        (issue) => `section.${issue.path}: ${issue.message}`,
      ),
    };
  }
  return { part: { section: parsed.data, questions }, issues: [] };
}

// ---------------------------------------------------------------------------------------------
// Backward: unit -> authoring shapes
// ---------------------------------------------------------------------------------------------

const EMPTY_BLOCK: AuthorBlock = {
  type: 'paragraph',
  text: '',
  label: '',
  brief: '',
  alt: '',
  tone: 'none',
  items: [],
  headers: [],
  rows: [],
  question_ref: '',
};

export function blockToAuthor(block: AnyBlock): AuthorBlock {
  const base = { ...EMPTY_BLOCK };
  switch (block.type) {
    case 'paragraph':
      return { ...base, type: 'paragraph', text: block.text };
    case 'bullets':
      return {
        ...base,
        type: 'bullets',
        items: block.items.map((item) => ({ head: item.lead ?? '', text: item.text })),
      };
    case 'definition':
      return { ...base, type: 'definition', label: block.term, text: block.meaning };
    case 'example':
      return { ...base, type: 'example', label: block.label, text: block.text };
    case 'dialogue':
      return {
        ...base,
        type: 'dialogue',
        items: block.lines.map((line) => ({ head: line.character, text: line.text })),
      };
    case 'illustration':
      return { ...base, type: 'illustration', brief: block.brief, alt: block.alt };
    case 'callout':
      return { ...base, type: 'callout', tone: block.tone, text: block.text };
    case 'activity_steps':
      return {
        ...base,
        type: 'activity_steps',
        items: block.steps.map((s) => ({ head: s.label, text: s.text })),
      };
    case 'table':
      return {
        ...base,
        type: 'table',
        headers: [...block.headers],
        rows: block.rows.map((row) => [...row]),
      };
    case 'question':
      return { ...base, type: 'question', question_ref: block.question_id };
    case 'unknown':
      return { ...base, type: 'paragraph', text: '' };
  }
}

const EMPTY_QUESTION: AuthorQuestion = {
  ref: '',
  kind: 'mcq',
  tier: 1,
  prompt: '',
  hint: '',
  explanation: '',
  skill_tag: '',
  options: [],
  answers: [],
  blanks: [],
  numeric: false,
  units: [],
  pairs: [],
  checks: [],
  exemplar: '',
};

/** The kinds the authoring format can express. The others (tap_image, speak, spoken) stay as they are in a revision. */
export function isAuthorable(question: Question): boolean {
  return ['mcq', 'fill_blank', 'match', 'circle', 'sort', 'free_text', 'draw'].includes(
    question.kind,
  );
}

/** Authoring form of a question; `ref` is the question's real id. Null for kinds the format cannot express. */
export function questionToAuthor(question: Question): AuthorQuestion | null {
  const base: AuthorQuestion = {
    ...EMPTY_QUESTION,
    ref: question.id,
    tier: question.tier,
    prompt: question.prompt,
    hint: question.hint ?? '',
    explanation: question.explanation ?? '',
    skill_tag: question.skill_tag ?? '',
  };
  switch (question.kind) {
    case 'mcq':
      return {
        ...base,
        kind: 'mcq',
        options: [...question.options],
        answers: [question.options[question.answer.correct_index] ?? ''],
      };
    case 'circle':
      return {
        ...base,
        kind: 'circle',
        options: [...question.options],
        answers: [...question.answer.correct],
      };
    case 'fill_blank': {
      const numeric = question.answer.blanks.some((blank) => blank.numeric === true);
      const units = unique(question.answer.blanks.flatMap((blank) => blank.units ?? []));
      return {
        ...base,
        kind: 'fill_blank',
        blanks: question.answer.blanks.map((blank) => [...blank.accepted]),
        numeric,
        units,
      };
    }
    case 'match':
      return {
        ...base,
        kind: 'match',
        pairs: question.answer.pairs.map((p) => ({ left: p.left, right: p.right })),
      };
    case 'sort':
      return {
        ...base,
        kind: 'sort',
        pairs: question.items.map((item) => ({
          left: item,
          right: question.answer.mapping[item] ?? '',
        })),
      };
    case 'free_text':
      return {
        ...base,
        kind: 'free_text',
        checks: [...question.rubric.criteria],
        exemplar: question.rubric.exemplar ?? '',
      };
    case 'draw':
      return { ...base, kind: 'draw', checks: [...(question.self_check ?? [])] };
    default:
      return null;
  }
}

export function tutorToAuthor(script: TutorScript | undefined): AuthorTutorLine[] {
  if (!script) return [];
  return script.nodes.map((node) => ({
    say: node.say,
    accepted: node.expect?.accepted ? [...node.expect.accepted] : [],
    question_ref: node.expect?.question_id ?? '',
    on_correct: [...node.on_correct],
    on_incorrect: [...node.on_incorrect],
    hint: [...node.hint],
  }));
}

/** Ids of the questions a section's blocks place. */
export function placedQuestionIds(blocks: readonly AnyBlock[]): string[] {
  return unique(blocks.flatMap((block) => (block.type === 'question' ? [block.question_id] : [])));
}

/** The id of the section whose blocks place a question, else the section whose `q_<id>_` prefix it carries, else null. */
export function ownerOfQuestion(
  sections: readonly { id: string; blocks: readonly { type: string; question_id?: string }[] }[],
  questionIdValue: string,
): string | null {
  for (const section of sections) {
    if (
      section.blocks.some(
        (block) => block.type === 'question' && block.question_id === questionIdValue,
      )
    ) {
      return section.id;
    }
  }
  return sections.find((section) => questionIdValue.startsWith(`q_${section.id}_`))?.id ?? null;
}
