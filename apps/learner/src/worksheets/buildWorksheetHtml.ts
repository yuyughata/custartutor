import { BLANK_PATTERN, normalizeText } from '@custar/content-schema';
import type { LessonUnit, Question } from '@custar/content-schema';
import { WORKSHEET_CSS } from './css';
import { escapeHtml, richHtml } from './escape';

/**
 * Printable worksheets, built from a lesson's workbook and questions. PURE: a lesson in, one HTML string out (A4
 * portrait, black on white, print CSS with page breaks). No network, no storage, no platform code, so it is tested
 * without a screen and runs the same on a phone, in a browser and in a test.
 *
 * WHAT IT USES: only the LEARNER pack's content (`workbook`, `questions`, `header`): the learner pack holds the answer
 * specs that offline grading needs, so the answers sheet needs no grown-up pack and nothing from the network. The
 * teacher's manual is not used.
 *
 * SAFETY: every piece of lesson text is escaped before it enters the page (`escape.ts`); no lesson text is ever placed
 * in a tag, an attribute name or a script. `**bold**` becomes `<strong>`.
 *
 * ANSWERS: the answers sheet is derived from the same answer specs the grader uses (`gradeQuestion`), and numbers and
 * letters match the worksheet: the choices of a multiple-choice question are lettered A, B, C ... in the order shown,
 * and a match question's right-hand items are lettered in alphabetical order (the order the app shows them), so
 * "2-C" means the same on the child's page and on the grown-up's.
 */

export type WorksheetKind = 'worksheet' | 'answers';

export interface WorksheetOptions {
  kind: WorksheetKind;
  /** Printed after "Name:". Pass the child's nickname if you like; nothing else about the child is ever printed. */
  childAlias?: string;
  /** Print this reviewed pool (an id from `workbook.practice_variants`) instead of the workbook. */
  variantId?: string;
}

export interface WorksheetDocument {
  html: string;
  /** For the page title and a file name, for example "Exploring Our Environment: Worksheet". */
  title: string;
  /** How many questions are on the sheet (numbered ones plus the drill and the home task). */
  questionCount: number;
}

export interface WorksheetListing {
  /** The workbook worksheet is always available for a lesson. */
  variants: { id: string; label: string; questionCount: number }[];
}

/** The worksheets a lesson offers beyond its workbook: its reviewed practice-variant pools, never generated. */
export function listWorksheets(unit: LessonUnit): WorksheetListing {
  return {
    variants: unit.workbook.practice_variants.map((variant, index) => ({
      id: variant.id,
      label: `More practice ${index + 1}`,
      questionCount: variant.question_ids.filter((id) => unit.questions[id] !== undefined).length,
    })),
  };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const letter = (index: number): string => LETTERS[index] ?? String(index + 1);

function subjectName(slug: string): string {
  return slug
    .split('-')
    .map((word) => (word ? word.charAt(0).toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** The right-hand items of a match question, in the fixed alphabetical order the app shows them. */
export function matchRights(question: Extract<Question, { kind: 'match' }>): string[] {
  return [...question.answer.pairs.map((pair) => pair.right), ...(question.distractors ?? [])].sort(
    (a, b) => a.localeCompare(b),
  );
}

// ---------------------------------------------------------------------------------------------
// One question, as something a child writes on
// ---------------------------------------------------------------------------------------------

const BOX = '<span class="box"></span>';

function lines(count: number): string {
  return `<div class="lines">${'<div class="line"></div>'.repeat(count)}</div>`;
}

function opt(label: string, mark: string | null = null): string {
  return `<div class="opt">${BOX}${mark ? `<span class="letter">${mark}</span>` : ''}<span>${richHtml(label)}</span></div>`;
}

/** The prompt of a fill-in-the-blank question with each blank drawn as a line to write on. */
function promptWithBlanks(prompt: string): string {
  return prompt
    .split(BLANK_PATTERN)
    .map((part) => richHtml(part))
    .join('<span class="blank"></span>');
}

function pictureBox(brief: string, alt: string): string {
  const what = brief.trim() !== '' ? brief : alt;
  return `<div class="picture"><div class="label">Picture</div><div class="what">${richHtml(what)}</div></div>`;
}

interface BodyOptions {
  /** A short body, for the cells of the drill grid. */
  compact?: boolean;
}

/** The part of a question below its prompt: the thing the child fills in. Every question kind has one. */
function questionBody(question: Question, options: BodyOptions = {}): string {
  const compact = options.compact === true;
  switch (question.kind) {
    case 'mcq':
      return question.options.map((option, index) => opt(option, letter(index))).join('');
    case 'fill_blank':
      return ''; // the blanks are drawn inside the prompt
    case 'match': {
      const rights = matchRights(question);
      return (
        `<div class="qhelp">Write the letter of the match in the box.</div>` +
        `<div class="match"><div class="col">${question.answer.pairs
          .map(
            (pair, index) =>
              `<div class="row"><span class="num">${index + 1}.</span><span>${richHtml(pair.left)}</span><span class="box write"></span></div>`,
          )
          .join('')}</div><div class="col">${rights
          .map(
            (right, index) =>
              `<div class="row"><span class="letter">${letter(index)}.</span><span>${richHtml(right)}</span></div>`,
          )
          .join('')}</div></div>`
      );
    }
    case 'circle':
      return `<div class="circles">${question.options
        .map((option) => `<span class="circle-opt">${richHtml(option)}</span>`)
        .join('')}</div>`;
    case 'sort':
      return (
        `<div class="wordbox"><strong>Words:</strong> ${question.items.map((item) => richHtml(item)).join(' &nbsp;&middot;&nbsp; ')}</div>` +
        `<table class="sort"><thead><tr>${question.categories
          .map((category) => `<th>${richHtml(category)}</th>`)
          .join('')}</tr></thead><tbody>${question.items
          .map(() => `<tr>${question.categories.map(() => '<td></td>').join('')}</tr>`)
          .join('')}</tbody></table>`
      );
    case 'tap_image':
      return (
        pictureBox(question.brief ?? '', question.alt) +
        `<div class="qhelp">Look at the picture. Tick the ones that are right.</div>` +
        question.answer.hotspots.map((hotspot) => opt(hotspot.label)).join('')
      );
    case 'speak':
    case 'spoken':
      return `<div class="say">${BOX}<span>Say it out loud, then tick the box.</span></div>`;
    case 'draw':
      return (
        `<div class="draw-box"></div>` +
        (question.self_check && question.self_check.length > 0
          ? `<div class="qhelp">Tick the ones you did:</div>${question.self_check.map((item) => opt(item)).join('')}`
          : '')
      );
    case 'free_text':
      return lines(compact ? 2 : 3);
  }
}

/** A question block for the worksheet. `number` null prints it without one (the Take It Home task). */
function questionHtml(question: Question, number: number | null): string {
  const head =
    question.kind === 'fill_blank' ? promptWithBlanks(question.prompt) : richHtml(question.prompt);
  const num = number === null ? '' : `<span class="qnum">${number}.</span>`;
  return (
    `<div class="q q-${question.kind}${number === null ? ' unnumbered' : ''}" data-kind="${question.kind}">` +
    `<div class="qhead">${num}<span class="qprompt">${head}</span></div>` +
    `${questionBodyBlock(question)}</div>`
  );
}

function questionBodyBlock(question: Question): string {
  const body = questionBody(question);
  return body === '' ? '' : `<div class="qbody">${body}</div>`;
}

// ---------------------------------------------------------------------------------------------
// The answer to a question, as a grown-up marks it
// ---------------------------------------------------------------------------------------------

/** The answer lines of one question, as HTML fragments (already escaped). Uses the same answer specs as the grader. */
export function answerLines(question: Question): string[] {
  switch (question.kind) {
    case 'mcq': {
      const index = question.answer.correct_index;
      const option = question.options[index];
      return [`<strong>${letter(index)}.</strong> ${richHtml(option ?? '')}`];
    }
    case 'fill_blank':
      return question.answer.blanks.map((blank, index, all) => {
        const [first = '', ...others] = blank.accepted;
        const label = all.length > 1 ? `Blank ${index + 1}: ` : '';
        const alsoOk =
          others.length > 0
            ? ` <span class="why">(also right: ${others.map((value) => richHtml(value)).join(', ')})</span>`
            : '';
        return `${label}<strong>${richHtml(first)}</strong>${alsoOk}`;
      });
    case 'match': {
      const rights = matchRights(question);
      return question.answer.pairs.map((pair, index) => {
        const at = rights.indexOf(pair.right);
        return `<strong>${index + 1}&ndash;${letter(at)}</strong> &nbsp;${richHtml(pair.left)} &rarr; ${richHtml(pair.right)}`;
      });
    }
    case 'circle':
      return [question.answer.correct.map((value) => richHtml(value)).join(', ')];
    case 'sort': {
      const mapping = new Map(
        Object.entries(question.answer.mapping).map(([item, category]) => [
          normalizeText(item),
          normalizeText(category),
        ]),
      );
      return question.categories.map((category) => {
        const items = question.items.filter(
          (item) => mapping.get(normalizeText(item)) === normalizeText(category),
        );
        return `<strong>${richHtml(category)}:</strong> ${items.map((item) => richHtml(item)).join(', ')}`;
      });
    }
    case 'tap_image':
      return [
        question.answer.hotspots
          .filter((hotspot) => hotspot.correct)
          .map((hotspot) => richHtml(hotspot.label))
          .join(', '),
      ];
    case 'speak':
      return [question.answer.expected.map((value) => richHtml(value)).join(' / ')];
    case 'draw':
      return question.self_check && question.self_check.length > 0
        ? ['Look for:', ...question.self_check.map((item) => `&bull; ${richHtml(item)}`)]
        : ['Check that the child has drawn it and can say what it shows.'];
    case 'free_text':
    case 'spoken':
      return [
        question.rubric.exemplar
          ? `For example: ${richHtml(question.rubric.exemplar)}`
          : `Any answer that ${question.rubric.criteria.map((value) => richHtml(value)).join(', ')}.`,
      ];
  }
}

function answerHtml(question: Question, number: number | null): string {
  const [first, ...rest] = answerLines(question);
  const lines = [first ?? '', ...rest];
  const why = question.explanation
    ? `<div class="why">${richHtml(question.explanation)}</div>`
    : '';
  const num = number === null ? '' : `<span class="qnum">${number}.</span>`;
  return (
    `<div class="a" data-kind="${question.kind}">${num}` +
    `<div class="atext">${lines.map((line) => `<div>${line}</div>`).join('')}${why}</div></div>`
  );
}

// ---------------------------------------------------------------------------------------------
// The document
// ---------------------------------------------------------------------------------------------

interface Numbered {
  number: number;
  question: Question;
}

interface Part {
  heading: string;
  items: Numbered[];
}

/** Tier questions are numbered 1, 2, 3 ... straight through the tiers, as in the app's workbook. */
function tierParts(unit: LessonUnit): Part[] {
  let counter = 0;
  return unit.workbook.tiers.map((tier) => ({
    heading: `Tier ${tier.tier} — ${tier.title}`,
    items: tier.question_ids.flatMap((id) => {
      const question = unit.questions[id];
      if (!question) return [];
      counter += 1;
      return [{ number: counter, question }];
    }),
  }));
}

function drillItems(unit: LessonUnit): Numbered[] {
  return unit.workbook.quick_answer_drill.question_ids.flatMap((id, index) => {
    const question = unit.questions[id];
    return question ? [{ number: index + 1, question }] : [];
  });
}

/** Questions of a variant pool, numbered from 1. */
function variantItems(unit: LessonUnit, variantId: string): Numbered[] | null {
  const variant = unit.workbook.practice_variants.find((candidate) => candidate.id === variantId);
  if (!variant) return null;
  return variant.question_ids
    .flatMap((id) => (unit.questions[id] ? [unit.questions[id] as Question] : []))
    .map((question, index) => ({ number: index + 1, question }));
}

function section(heading: string, body: string, cls = ''): string {
  return `<section class="section ${cls}"><h2>${richHtml(heading)}</h2>${body}</section>`;
}

/** The drill as a grid of boxes: number, prompt (blanks drawn), and room to answer. */
function drillGrid(items: Numbered[]): string {
  return `<div class="drill-grid">${items
    .map(({ number, question }) => {
      const prompt =
        question.kind === 'fill_blank'
          ? promptWithBlanks(question.prompt)
          : richHtml(question.prompt);
      const body = question.kind === 'fill_blank' ? '' : questionBody(question, { compact: true });
      return `<div class="cell" data-kind="${question.kind}"><span class="n">${number}.</span><span>${prompt}</span>${body}</div>`;
    })
    .join('')}</div>`;
}

const HEAD_KIND: Record<WorksheetKind, string> = {
  worksheet: 'Worksheet',
  answers: 'Answers (for the grown-up)',
};

/**
 * A LONG worksheet (more than this many tier questions) puts Take It Home on a page of its own, so that page can go
 * home on its own. A normal one lets the page break fall where the content needs it (questions are never split across
 * pages, see `break-inside` in the stylesheet) rather than spend a page on a forced break.
 */
const TAKE_HOME_OWN_PAGE_AFTER = 8;

/**
 * Builds one printable page set. Without `variantId` it is the unit's workbook (intro, tiers, drill, Take It Home);
 * with it, the named reviewed practice pool. `kind: 'answers'` gives the grown-up's answers instead of the blanks.
 * Throws only for an unknown `variantId` (a programming error: offer only `listWorksheets` ids).
 */
export function buildWorksheet(unit: LessonUnit, options: WorksheetOptions): WorksheetDocument {
  const { header, workbook } = unit;
  const answers = options.kind === 'answers';
  const variant = options.variantId !== undefined ? variantItems(unit, options.variantId) : null;
  if (options.variantId !== undefined && variant === null) {
    throw new Error(`This lesson has no practice set "${options.variantId}".`);
  }

  const variantIndex =
    options.variantId !== undefined
      ? workbook.practice_variants.findIndex((candidate) => candidate.id === options.variantId)
      : -1;
  const kindLabel = variant !== null ? `More practice ${variantIndex + 1}` : 'Workbook';
  const unitName = `Unit ${header.unit_no}: ${header.title}`;
  const sheetLabel = answers ? `${kindLabel}: answers` : kindLabel;
  const title = `${header.title}: ${answers ? 'Answers' : 'Worksheet'}${variant !== null ? ` (${kindLabel})` : ''}`;

  const meta = [
    subjectName(header.subject_slug),
    `Primary ${header.level_code.slice(1)}`,
    `Term ${header.term}`,
  ].join(' · ');

  const parts: string[] = [];
  let questionCount = 0;

  parts.push(
    `<header class="head"><div class="brand">CUSTAR</div><div class="meta">${escapeHtml(meta)}</div>` +
      `<h1>${richHtml(unitName)}</h1><div class="kind">${escapeHtml(HEAD_KIND[options.kind])}${variant !== null ? ` &middot; ${escapeHtml(kindLabel)}` : ''}</div></header>`,
  );

  if (!answers) {
    parts.push(
      `<div class="name-line"><div class="field name"><span>Name:</span><span class="fill">${escapeHtml(options.childAlias ?? '')}</span></div>` +
        `<div class="field date"><span>Date:</span><span class="fill"></span></div></div>`,
    );
  } else {
    parts.push(
      `<p class="note"><strong>For the grown-up.</strong> Please do not show this page to the child before they have tried the worksheet.</p>`,
    );
  }

  parts.push(
    `<section class="objective"><strong>Objective (NERDC):</strong> ${richHtml(header.objective)}</section>`,
  );

  if (variant !== null) {
    // A reviewed practice pool: just its questions, numbered from 1.
    questionCount = variant.length;
    if (answers) {
      parts.push(
        section(
          sheetLabel,
          `<div class="answers">${variant.map(({ number, question }) => answerHtml(question, number)).join('')}</div>`,
        ),
      );
    } else {
      parts.push(
        section(
          kindLabel,
          variant.map(({ number, question }) => questionHtml(question, number)).join(''),
        ),
      );
    }
  } else {
    const tiers = tierParts(unit);
    const drill = drillItems(unit);
    const home = unit.questions[workbook.application_task_id];
    const tierQuestionCount = tiers.reduce((sum, tier) => sum + tier.items.length, 0);
    // The home task's own prompt often repeats the Take It Home text word for word: print it once.
    const tipHtml =
      home && normalizeText(home.prompt).includes(normalizeText(workbook.take_it_home))
        ? ''
        : `<div class="tip">${richHtml(workbook.take_it_home)}</div>`;
    questionCount = tierQuestionCount + drill.length + (home ? 1 : 0);

    if (!answers) {
      if (workbook.intro) {
        parts.push(
          `<p class="intro"><strong>How this works:</strong> ${richHtml(workbook.intro)}</p>`,
        );
      }
      for (const tier of tiers) {
        parts.push(
          section(
            tier.heading,
            tier.items.map(({ number, question }) => questionHtml(question, number)).join(''),
            'tier',
          ),
        );
      }
      parts.push(
        section(
          `Quick-Answer Drill (${workbook.quick_answer_drill.seconds} seconds)`,
          `<p class="note">Ask a grown-up to time you. Answer out loud, fast!</p>${drillGrid(drill)}`,
          'drill',
        ),
      );
      if (tierQuestionCount > TAKE_HOME_OWN_PAGE_AFTER)
        parts.push('<div class="page-break"></div>');
      parts.push(
        section('Take It Home', `${tipHtml}${home ? questionHtml(home, null) : ''}`, 'take-home'),
      );
    } else {
      if (workbook.answers_note) {
        parts.push(
          `<div class="callout"><strong>Answer note:</strong> ${richHtml(workbook.answers_note)}</div>`,
        );
      }
      for (const tier of tiers) {
        parts.push(
          section(
            tier.heading,
            `<div class="answers">${tier.items.map(({ number, question }) => answerHtml(question, number)).join('')}</div>`,
          ),
        );
      }
      parts.push(
        section(
          `Quick-Answer Drill (${workbook.quick_answer_drill.seconds} seconds)`,
          `<div class="answers">${drill.map(({ number, question }) => answerHtml(question, number)).join('')}</div>`,
        ),
      );
      if (home) {
        parts.push(section('Take It Home', `<div class="answers">${answerHtml(home, null)}</div>`));
      }
      if (workbook.not_yet) {
        parts.push(
          `<div class="callout"><strong>If a child has not got it yet:</strong> ${richHtml(workbook.not_yet)}</div>`,
        );
      }
    }
  }

  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title><style>${WORKSHEET_CSS}</style></head>` +
    `<body><main class="sheet kind-${options.kind}">${parts.join('')}</main></body></html>`;

  return { html, title, questionCount };
}

/** Convenience: just the HTML of `buildWorksheet`. */
export function buildWorksheetHtml(unit: LessonUnit, options: WorksheetOptions): string {
  return buildWorksheet(unit, options).html;
}
