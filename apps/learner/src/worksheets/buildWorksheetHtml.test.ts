import { describe, expect, it, vi } from 'vitest';
import { gradeQuestion, parseUnit } from '@custar/content-schema';
import type { LessonUnit, Question, QuestionResponse } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import { WORKSHEET_CSS } from './css';
import {
  answerLines,
  buildWorksheet,
  buildWorksheetHtml,
  listWorksheets,
  matchRights,
} from './buildWorksheetHtml';
import { escapeHtml, richHtml } from './escape';

// `answerSummary` lives in the lesson renderer, whose index loads react-native: stub that for Node.
vi.mock('react-native', async () => (await import('../testing/rnMock')).reactNativeMock);
const { answerSummary } = await import('@custar/lesson-renderer');

const golden = parseUnit(goldenUnit2) as LessonUnit;
const maths = parseUnit(marketDayMathsUnit) as LessonUnit;

// ---- a unit that has EVERY question kind, plus hostile text, to exercise the builder ----------------------------------

const XSS = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';

const extraQuestions: Record<string, Question> = {
  x_tap: {
    id: 'x_tap',
    kind: 'tap_image',
    tier: 3,
    prompt: 'Tap the **bin**.',
    brief: 'A classroom with a red bin by the door',
    alt: 'A classroom with a bin',
    answer: {
      hotspots: [
        { id: 'bin', label: 'The bin', x: 0.1, y: 0.1, w: 0.2, h: 0.2, correct: true },
        { id: 'desk', label: 'The desk', x: 0.5, y: 0.5, w: 0.2, h: 0.2, correct: false },
      ],
    },
  },
  x_speak: {
    id: 'x_speak',
    kind: 'speak',
    tier: 3,
    prompt: 'Say hello to your teacher.',
    answer: { expected: ['good morning', 'hello'] },
  },
  x_spoken: {
    id: 'x_spoken',
    kind: 'spoken',
    tier: 3,
    prompt: 'Tell me about your school.',
    rubric: { criteria: ['names one place'], exemplar: 'We have a playground.' },
  },
  x_draw: {
    id: 'x_draw',
    kind: 'draw',
    tier: 3,
    prompt: 'Draw your bedroom.',
    self_check: ['I drew a bed', 'I drew a window'],
  },
  x_mcq: {
    id: 'x_mcq',
    kind: 'mcq',
    tier: 3,
    prompt: `${XSS} Where do we cook?`,
    options: ['Bedroom', `${XSS} Kitchen`, 'Playground'],
    answer: { correct_index: 1 },
    explanation: `${XSS} because the kitchen has the stove.`,
  },
  x_fill: {
    id: 'x_fill',
    kind: 'fill_blank',
    tier: 3,
    prompt: 'The ____ is where we ____ food.',
    answer: { blanks: [{ accepted: ['kitchen'] }, { accepted: ['cook', 'prepare'] }] },
  },
};

function everyKind(): LessonUnit {
  const base = structuredClone(golden) as LessonUnit;
  return parseUnit({
    ...base,
    header: { ...base.header, title: `Every kind ${XSS}` },
    questions: { ...base.questions, ...extraQuestions },
    workbook: {
      ...base.workbook,
      intro: `Intro with **bold** and ${XSS}`,
      tiers: base.workbook.tiers.map((tier) =>
        tier.tier === 3
          ? {
              ...tier,
              question_ids: [
                ...tier.question_ids,
                'x_tap',
                'x_speak',
                'x_spoken',
                'x_draw',
                'x_mcq',
                'x_fill',
                'mc_places', // a sort question
              ],
            }
          : tier,
      ),
      practice_variants: [
        ...base.workbook.practice_variants,
        { id: 'variant_extra', question_ids: ['x_mcq', 'x_tap', 'x_speak'] },
      ],
    },
  }) as LessonUnit;
}

// ---- tiny HTML helpers -------------------------------------------------------------------------------------------------

const ALLOWED_TAGS = new Set([
  'html',
  'head',
  'meta',
  'title',
  'style',
  'body',
  'main',
  'header',
  'section',
  'div',
  'span',
  'h1',
  'h2',
  'p',
  'strong',
  'table',
  'thead',
  'tbody',
  'tr',
  'th',
  'td',
]);
const VOID = new Set(['meta']);

/** Splits html into tag tokens, skipping the contents of <style>. Returns the tag names and any problems found. */
function tagReport(html: string): { names: string[]; problems: string[] } {
  const withoutStyle = html.replace(/<style>[\s\S]*?<\/style>/, '<style></style>');
  const names: string[] = [];
  const problems: string[] = [];
  const stack: string[] = [];
  for (const match of withoutStyle.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)([^>]*)>/g)) {
    const [, closing, name, rest] = match as unknown as [string, string, string, string];
    const tag = name.toLowerCase();
    names.push(tag);
    if (/\son[a-z]+\s*=/i.test(rest)) problems.push(`event handler on <${tag}>`);
    if (closing) {
      if (stack.pop() !== tag) problems.push(`unbalanced </${tag}>`);
    } else if (!VOID.has(tag)) {
      stack.push(tag);
    }
  }
  if (stack.length > 0) problems.push(`unclosed: ${stack.join(',')}`);
  return { names, problems };
}

/** The visible text of a fragment, with tags removed and entities decoded (just the ones we emit). */
function textOf(html: string): string {
  return html
    .replace(/<style>[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&middot;/g, '·')
    .replace(/&rarr;/g, '→')
    .replace(/&ndash;/g, '–')
    .replace(/&bull;/g, '•')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The html of every question (`q`) or answer (`a`) block of a kind, each cut off where the next block starts. */
function block(html: string, className: 'q' | 'a', kind: string): string[] {
  const open =
    className === 'q'
      ? `<div class="q q-${kind}" data-kind="${kind}">`
      : `<div class="a" data-kind="${kind}">`;
  const anyOpen = className === 'q' ? '<div class="q q-' : '<div class="a" data-kind=';
  const blocks: string[] = [];
  let from = 0;
  for (;;) {
    const at = html.indexOf(open, from);
    if (at < 0) break;
    const next = html.indexOf(anyOpen, at + open.length);
    // a question block also ends where the next section starts
    const section = html.indexOf('</section>', at + open.length);
    const end = [next, section].filter((index) => index >= 0).sort((a, b) => a - b)[0];
    blocks.push(html.slice(at, end));
    from = at + open.length;
  }
  return blocks;
}

describe('escape', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      '&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;',
    );
  });

  it('turns **bold** into <strong> after escaping, and leaves unbalanced markers alone', () => {
    expect(richHtml('a **b** c')).toBe('a <strong>b</strong> c');
    expect(richHtml('**<b>x</b>**')).toBe('<strong>&lt;b&gt;x&lt;/b&gt;</strong>');
    expect(richHtml('one ** marker')).toBe('one ** marker');
    expect(richHtml('**a** and **b**')).toBe('<strong>a</strong> and <strong>b</strong>');
  });
});

describe('the worksheet document', () => {
  const unit = everyKind();
  const sheet = buildWorksheet(unit, { kind: 'worksheet', childAlias: 'Ada' });
  const html = sheet.html;

  it('is a complete, well-formed A4 page with only known tags and no event handlers', () => {
    expect(html.startsWith('<!doctype html><html lang="en"><head><meta charset="utf-8">')).toBe(
      true,
    );
    const { names, problems } = tagReport(html);
    expect(problems).toEqual([]);
    for (const name of names) expect(ALLOWED_TAGS.has(name), name).toBe(true);
  });

  it('prints black on white with A4 portrait page rules and keeps questions whole', () => {
    expect(WORKSHEET_CSS).toContain('size: A4 portrait');
    expect(WORKSHEET_CSS).toMatch(/body \{[^}]*background: #fff; color: #000/);
    expect(WORKSHEET_CSS).toMatch(/\.q \{[^}]*break-inside: avoid; page-break-inside: avoid/);
    expect(WORKSHEET_CSS).toMatch(/h2 \{[^}]*break-after: avoid/);
    expect(WORKSHEET_CSS).toMatch(
      /\.page-break \{[^}]*break-after: page; page-break-after: always/,
    );
    expect(html).toContain('<style>');
    // nothing is fetched: no links, scripts, images or url() in the page
    expect(html).not.toMatch(/<(link|script|img|iframe|object|embed|form|a)\b/i);
    expect(html).not.toMatch(/https?:|url\(/i);
  });

  it('has the CUSTAR header with subject, level, term and the unit title', () => {
    const head = html.slice(html.indexOf('<header'), html.indexOf('</header>'));
    expect(textOf(head)).toContain('CUSTAR');
    expect(textOf(head)).toContain('Basic Science · Primary 1 · Term 1');
    expect(textOf(head)).toContain('Unit 2: Every kind');
    expect(textOf(head)).toContain('Worksheet');
  });

  it('has a Name and Date line with the alias prefilled and nothing else about the child', () => {
    const line = html.slice(
      html.indexOf('<div class="name-line">'),
      html.indexOf('<section class="objective">'),
    );
    expect(textOf(line)).toBe('Name: Ada Date:');
    const blank = buildWorksheetHtml(unit, { kind: 'worksheet' });
    expect(
      textOf(
        blank.slice(
          blank.indexOf('<div class="name-line">'),
          blank.indexOf('<section class="objective">'),
        ),
      ),
    ).toBe('Name: Date:');
  });

  it('escapes an alias that tries to inject markup', () => {
    const hostile = buildWorksheetHtml(unit, {
      kind: 'worksheet',
      childAlias: '<b onclick=x>Ada</b>',
    });
    expect(hostile).toContain('&lt;b onclick=x&gt;Ada&lt;/b&gt;');
    expect(tagReport(hostile).problems).toEqual([]);
  });

  it('shows the NERDC objective in a box straight after the Name line', () => {
    const at = html.indexOf('<section class="objective">');
    expect(at).toBeGreaterThan(html.indexOf('name-line'));
    expect(textOf(html.slice(at, html.indexOf('</section>', at)))).toBe(
      `Objective (NERDC): ${unit.header.objective}`,
    );
  });

  it('prints the intro, the three tiers in order, the drill grid and Take It Home', () => {
    expect(html).toContain('<strong>How this works:</strong>');
    const t1 = html.indexOf('Tier 1 —');
    const t2 = html.indexOf('Tier 2 —');
    const t3 = html.indexOf('Tier 3 —');
    const drill = html.indexOf('Quick-Answer Drill (60 seconds)');
    const home = html.indexOf('Take It Home</h2>');
    expect(t1).toBeGreaterThan(0);
    expect(t2).toBeGreaterThan(t1);
    expect(t3).toBeGreaterThan(t2);
    expect(drill).toBeGreaterThan(t3);
    expect(home).toBeGreaterThan(drill);
    expect(textOf(html)).toContain(unit.workbook.take_it_home);
    // the drill is a grid with one cell per drill question
    expect(html).toContain('<div class="drill-grid">');
    expect((html.match(/<div class="cell"/g) ?? []).length).toBe(
      unit.workbook.quick_answer_drill.question_ids.length,
    );
  });

  it('numbers the tier questions straight through the tiers and the drill from 1', () => {
    const tierNumbers = [...html.matchAll(/<span class="qnum">(\d+)\.<\/span>/g)].map((m) =>
      Number(m[1]),
    );
    const tierCount = unit.workbook.tiers.reduce((n, tier) => n + tier.question_ids.length, 0);
    expect(tierNumbers.slice(0, tierCount)).toEqual(
      Array.from({ length: tierCount }, (_, i) => i + 1),
    );
    const drillNumbers = [...html.matchAll(/<div class="cell"[^>]*><span class="n">(\d+)\./g)].map(
      (m) => Number(m[1]),
    );
    expect(drillNumbers).toEqual(
      unit.workbook.quick_answer_drill.question_ids.map((_, i) => i + 1),
    );
  });

  it('gives a LONG worksheet a page of its own for Take It Home, and lets a normal one flow', () => {
    const marker = '<div class="page-break"></div>';
    // 13 tier questions: Take It Home starts a new page, after the drill
    expect(html).toContain(marker);
    expect(html.indexOf(marker)).toBeGreaterThan(html.indexOf('Quick-Answer Drill'));
    expect(html.indexOf(marker)).toBeLessThan(html.indexOf('Take It Home</h2>'));
    expect(html.split(marker)).toHaveLength(2);
    // the golden workbook (7 tier questions) flows: no forced break
    expect(buildWorksheetHtml(golden, { kind: 'worksheet' })).not.toContain(marker);
    // a short one too
    const short = parseUnit({
      ...golden,
      workbook: {
        ...golden.workbook,
        tiers: [
          { tier: 1, title: 'A', question_ids: ['wb_match_places'] },
          { tier: 2, title: 'B', question_ids: ['wb_fill_cook'] },
          { tier: 3, title: 'C', question_ids: ['wb_keep_clean'] },
        ],
      },
    }) as LessonUnit;
    expect(buildWorksheetHtml(short, { kind: 'worksheet' })).not.toContain(marker);
  });

  it('never splits a question, a drill cell or a heading from what follows it across pages', () => {
    expect(WORKSHEET_CSS).toMatch(/\.cell \{[^}]*break-inside: avoid/);
    expect(WORKSHEET_CSS).toMatch(/\.drill, \.take-home \{[^}]*break-inside: avoid/);
    expect(WORKSHEET_CSS).toMatch(/\.callout \{[^}]*break-inside: avoid/);
  });

  it('counts the questions on the sheet', () => {
    const tiers = unit.workbook.tiers.reduce((n, tier) => n + tier.question_ids.length, 0);
    expect(sheet.questionCount).toBe(
      tiers + unit.workbook.quick_answer_drill.question_ids.length + 1,
    );
  });
});

describe('every question kind is printable', () => {
  const unit = everyKind();
  const html = buildWorksheetHtml(unit, { kind: 'worksheet' });

  it('mcq: a lettered box for every option', () => {
    const [q] = block(html, 'q', 'mcq').filter((b) => b.includes('Where do we cook?'));
    expect(q).toBeDefined();
    const opts = [
      ...(q as string).matchAll(
        /<div class="opt"><span class="box"><\/span><span class="letter">([A-Z])<\/span>/g,
      ),
    ];
    expect(opts.map((m) => m[1])).toEqual(['A', 'B', 'C']);
  });

  it('fill_blank: each blank is a line to write on, the prompt text stays', () => {
    const [q] = block(html, 'q', 'fill_blank').filter((b) => b.includes('is where we'));
    expect((q as string).match(/<span class="blank"><\/span>/g)).toHaveLength(2);
    expect(textOf(q as string)).toContain('The is where we food.'.replace(/ +/g, ' '));
    expect(q).not.toContain('____');
  });

  it('match: two columns, numbers on the left with a box, letters on the right', () => {
    const q = block(html, 'q', 'match')[0] as string;
    expect(q).toContain('<div class="match"><div class="col">');
    const lefts = [
      ...q.matchAll(
        /<span class="num">(\d+)\.<\/span><span>([^<]*)<\/span><span class="box write">/g,
      ),
    ];
    const rights = [...q.matchAll(/<span class="letter">([A-Z])\.<\/span><span>([^<]*)<\/span>/g)];
    expect(lefts.map((m) => m[1])).toEqual(['1', '2', '3', '4', '5']);
    expect(rights.map((m) => m[1])).toEqual(['A', 'B', 'C', 'D', 'E']);
    // the right-hand items are in alphabetical order, as the app shows them
    expect(rights.map((m) => m[2])).toEqual(
      [...rights.map((m) => m[2] ?? '')].sort((a, b) => a.localeCompare(b)),
    );
  });

  it('circle: every option in an outline', () => {
    const q = block(html, 'q', 'circle')[0] as string;
    expect((q.match(/<span class="circle-opt">/g) ?? []).length).toBe(4);
    expect(q).toContain('astronaut');
  });

  it('sort: a word box and a table with a column per category and a row per word', () => {
    const q = block(html, 'q', 'sort')[0] as string;
    expect(q).toContain('<div class="wordbox"><strong>Words:</strong>');
    expect((q.match(/<th>/g) ?? []).length).toBe(2);
    expect((q.match(/<tr>/g) ?? []).length).toBe(1 + 6); // header row + one row per word
    expect((q.match(/<td><\/td>/g) ?? []).length).toBe(6 * 2);
  });

  it('tap_image: a bordered picture box with its description, and boxes to tick', () => {
    const q = block(html, 'q', 'tap_image')[0] as string;
    expect(q).toContain('<div class="picture"><div class="label">Picture</div>');
    expect(q).toContain('A classroom with a red bin by the door');
    expect(q).toContain('The bin');
    expect(q).toContain('The desk');
    expect(q).toContain('<strong>bin</strong>');
    expect((q.match(/<span class="box">/g) ?? []).length).toBe(2);
  });

  it('draw: a blank box to draw in, and the self-check list', () => {
    const q = block(html, 'q', 'draw').filter((b) => b.includes('Draw your bedroom'))[0] as string;
    expect(q).toContain('<div class="draw-box"></div>');
    expect(textOf(q)).toContain('I drew a bed');
    expect(textOf(q)).toContain('I drew a window');
  });

  it('free_text: ruled lines', () => {
    const q = block(html, 'q', 'free_text')[0] as string;
    expect((q.match(/<div class="line">/g) ?? []).length).toBe(3);
  });

  it('speak and spoken: "say it out loud" with a tick box', () => {
    for (const kind of ['speak', 'spoken']) {
      const q = block(html, 'q', kind)[0] as string;
      expect(q, kind).toContain('<div class="say"><span class="box"></span>');
      expect(textOf(q), kind).toContain('Say it out loud, then tick the box.');
    }
  });

  it('prints no answers on the worksheet', () => {
    const text = textOf(html);
    expect(text).not.toContain('also right');
    expect(text).not.toContain('We have a playground.'); // the rubric exemplar of x_spoken
    expect(html).not.toContain('class="answers"');
  });

  it('the maths fixture (money, change, numeric blanks) prints too', () => {
    const out = buildWorksheet(maths, { kind: 'worksheet', childAlias: 'Tobi' });
    expect(tagReport(out.html).problems).toEqual([]);
    expect(out.questionCount).toBeGreaterThan(5);
    expect(textOf(out.html)).toContain('Mathematics · Primary 1');
    expect(out.html).toContain('class="blank"');
  });
});

describe('hostile content stays inert', () => {
  const unit = everyKind();
  const sheet = buildWorksheetHtml(unit, { kind: 'worksheet', childAlias: XSS });
  const key = buildWorksheetHtml(unit, { kind: 'answers' });

  it('never produces a script, an image or an event handler, on either sheet', () => {
    for (const html of [sheet, key]) {
      const { names, problems } = tagReport(html);
      expect(problems).toEqual([]);
      for (const name of names) expect(ALLOWED_TAGS.has(name), name).toBe(true);
      expect(html).not.toMatch(/<script|<img/i);
    }
  });

  it('shows the hostile text as plain text', () => {
    expect(textOf(sheet)).toContain(XSS);
    expect(textOf(key)).toContain(XSS);
    expect(sheet).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sheet).toContain('&lt;img src=x onerror=alert(2)&gt;');
  });

  it('escapes the title and the unit name', () => {
    const doc = buildWorksheet(unit, { kind: 'worksheet' });
    expect(doc.html).toContain(`<title>${escapeHtml(doc.title)}</title>`);
    expect(doc.html).not.toContain('<title><script>');
  });
});

describe('the answers sheet', () => {
  const unit = everyKind();
  const html = buildWorksheetHtml(unit, { kind: 'answers' });

  it('says it is for the grown-up, with no Name line and no blanks to fill', () => {
    expect(textOf(html.slice(html.indexOf('<header'), html.indexOf('</header>')))).toContain(
      'Answers (for the grown-up)',
    );
    expect(html).not.toContain('class="name-line"');
    expect(html).not.toContain('class="blank"');
    expect(html).not.toContain('class="draw-box"');
  });

  it('prints the answer note, then the answers, then the not-yet text', () => {
    const note = html.indexOf('Answer note:');
    const tier1 = html.indexOf('Tier 1 —');
    const drill = html.indexOf('Quick-Answer Drill');
    const notYet = html.indexOf('If a child has not got it yet:');
    expect(note).toBeGreaterThan(0);
    expect(tier1).toBeGreaterThan(note);
    expect(drill).toBeGreaterThan(tier1);
    expect(notYet).toBeGreaterThan(drill);
    expect(textOf(html)).toContain(unit.workbook.answers_note ?? 'x');
    expect(textOf(html)).toContain(unit.workbook.not_yet ?? 'x');
  });

  it('numbers its answers exactly like the worksheet', () => {
    const numbers = [
      ...html.matchAll(/<div class="a" data-kind="[a-z_]+"><span class="qnum">(\d+)\./g),
    ].map((m) => Number(m[1]));
    const tierCount = unit.workbook.tiers.reduce((n, tier) => n + tier.question_ids.length, 0);
    expect(numbers.slice(0, tierCount)).toEqual(Array.from({ length: tierCount }, (_, i) => i + 1));
    // the Take It Home task carries no number; its answer sits under the Take It Home heading
    const home = html.slice(html.indexOf('Take It Home</h2>'));
    expect(home).toContain('data-kind="draw"');
    expect(home).not.toContain('class="qnum"');
  });

  it('gives the right answer for every kind, from the same data the grader uses', () => {
    const text = (kind: string, snippet?: string) => {
      const blocks = block(html, 'a', kind).filter((b) => !snippet || b.includes(snippet));
      return textOf(blocks[0] ?? '');
    };
    expect(text('mcq', 'Kitchen')).toContain(`B. ${XSS} Kitchen`);
    expect(text('fill_blank', 'Blank 1')).toContain('Blank 1: kitchen');
    expect(text('fill_blank', 'Blank 2')).toContain('Blank 2: cook (also right: prepare)');
    expect(text('circle')).toContain('teacher, friend, classmate');
    expect(text('speak')).toContain('good morning / hello');
    expect(text('spoken')).toContain('For example: We have a playground.');
    expect(text('draw', 'I drew a bed')).toContain(
      'Look for: \u2022 I drew a bed \u2022 I drew a window',
    );
    expect(text('tap_image')).toContain('The bin');
    expect(text('tap_image')).not.toContain('The desk');
    expect(text('sort')).toContain('At school: classroom, playground, staff room');
    expect(text('sort')).toContain('At home: kitchen, bedroom, living room');
  });

  it('prints the explanation of a question as "why" text', () => {
    expect(textOf(html)).toContain('Kitchen-Cook, Bedroom-Sleep, Playground-Play');
  });

  it('match answers use the same numbers and letters as the worksheet', () => {
    const sheet = buildWorksheetHtml(unit, { kind: 'worksheet' });
    const q = block(sheet, 'q', 'match')[0] as string;
    const lefts = new Map(
      [...q.matchAll(/<span class="num">(\d+)\.<\/span><span>([^<]*)<\/span>/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const rights = new Map(
      [...q.matchAll(/<span class="letter">([A-Z])\.<\/span><span>([^<]*)<\/span>/g)].map((m) => [
        m[1],
        m[2],
      ]),
    );
    const a = block(html, 'a', 'match')[0] as string;
    const pairs = [...a.matchAll(/<strong>(\d+)&ndash;([A-Z])<\/strong>/g)];
    expect(pairs).toHaveLength(5);
    const match = unit.questions['wb_match_places'];
    if (!match || match.kind !== 'match') throw new Error('fixture');
    for (const [, n, l] of pairs) {
      const left = lefts.get(n ?? '');
      const right = rights.get(l ?? '');
      expect(match.answer.pairs.some((pair) => pair.left === left && pair.right === right)).toBe(
        true,
      );
    }
  });

  it('mcq answer letters point at the correct option of the worksheet', () => {
    const sheet = buildWorksheetHtml(unit, { kind: 'worksheet' });
    const q = block(sheet, 'q', 'mcq').filter((b) => b.includes('Where do we cook?'))[0] as string;
    const options = [...q.matchAll(/<span class="letter">([A-Z])<\/span><span>([^<]*)<\/span>/g)];
    const printed = [
      ...(block(html, 'a', 'mcq').filter((b) => b.includes('Kitchen'))[0] as string).matchAll(
        /<strong>([A-Z])\.<\/strong>/g,
      ),
    ];
    expect(printed[0]?.[1]).toBe('B');
    expect(options[1]?.[2]).toContain('Kitchen');
  });
});

describe('answers agree with the grader and with the app', () => {
  /** The response a perfect child would give, built only from the question's answer spec. */
  function perfect(question: Question): QuestionResponse | null {
    switch (question.kind) {
      case 'mcq':
        return { kind: 'mcq', selected_index: question.answer.correct_index };
      case 'fill_blank':
        return {
          kind: 'fill_blank',
          answers: question.answer.blanks.map((b) => b.accepted[0] ?? ''),
        };
      case 'match':
        return { kind: 'match', pairs: question.answer.pairs };
      case 'circle':
        return { kind: 'circle', selected: question.answer.correct };
      case 'sort':
        return { kind: 'sort', placements: question.answer.mapping };
      case 'tap_image':
        return {
          kind: 'tap_image',
          hotspot_ids: question.answer.hotspots.filter((h) => h.correct).map((h) => h.id),
        };
      case 'speak':
        return { kind: 'speak', transcript: question.answer.expected[0] ?? '' };
      default:
        return null;
    }
  }

  const units = [golden, maths, everyKind()];

  it('every printed answer, taken from the same spec, grades as correct', () => {
    let graded = 0;
    for (const unit of units) {
      for (const question of Object.values(unit.questions)) {
        const response = perfect(question);
        if (!response) continue;
        expect(gradeQuestion(question, response).result, question.id).toBe('correct');
        graded += 1;
      }
    }
    expect(graded).toBeGreaterThan(20);
  });

  it('every question of every unit has a non-empty printed answer', () => {
    for (const unit of units) {
      for (const question of Object.values(unit.questions)) {
        const lines = answerLines(question);
        expect(lines.length, question.id).toBeGreaterThan(0);
        expect(textOf(lines.join(' ')).length, question.id).toBeGreaterThan(0);
      }
    }
  });

  it("the printed answer contains what the app's answer summary shows for that question", () => {
    for (const unit of units) {
      for (const question of Object.values(unit.questions)) {
        const printed = textOf(answerLines(question).join(' '));
        switch (question.kind) {
          case 'mcq':
            expect(printed, question.id).toContain(
              question.options[question.answer.correct_index] ?? '?',
            );
            break;
          case 'fill_blank':
            for (const blank of question.answer.blanks)
              expect(printed, question.id).toContain(blank.accepted[0] ?? '?');
            break;
          case 'match':
            for (const pair of question.answer.pairs) {
              expect(printed, question.id).toContain(pair.left);
              expect(printed, question.id).toContain(pair.right);
            }
            break;
          case 'circle':
            for (const value of question.answer.correct)
              expect(printed, question.id).toContain(value);
            break;
          case 'sort':
            for (const [item, category] of Object.entries(question.answer.mapping)) {
              expect(printed, question.id).toContain(item);
              expect(printed, question.id).toContain(category);
            }
            break;
          case 'tap_image':
            for (const h of question.answer.hotspots.filter((x) => x.correct))
              expect(printed, question.id).toContain(h.label);
            break;
          case 'speak':
            expect(printed, question.id).toContain(question.answer.expected[0] ?? '?');
            break;
          case 'draw':
          case 'free_text':
          case 'spoken':
            break; // open answers: checked in the test of the answers sheet above
        }
        // and the app's own summary text is built from the same fields: it must not mention anything we left out
        const summary = answerSummary(question);
        if (question.kind === 'mcq' || question.kind === 'circle') {
          expect(printed, question.id).toContain(summary ?? '?');
        }
      }
    }
  });

  it('matchRights is the order the worksheet letters follow', () => {
    const q = golden.questions['wb_match_places'];
    if (!q || q.kind !== 'match') throw new Error('fixture');
    expect(matchRights(q)).toEqual(['Bath', 'Cook', 'Learn', 'Play', 'Sleep']);
  });
});

describe('more practice (the reviewed variant pools)', () => {
  const unit = everyKind();

  it('lists a pool per reviewed variant, labelled in order, with its question count', () => {
    expect(listWorksheets(unit).variants).toEqual([
      { id: 'variant_places', label: 'More practice 1', questionCount: 3 },
      { id: 'variant_safe_clean', label: 'More practice 2', questionCount: 3 },
      { id: 'variant_extra', label: 'More practice 3', questionCount: 3 },
    ]);
  });

  it('prints a pool as its own worksheet with the same header, name line and objective', () => {
    const doc = buildWorksheet(unit, {
      kind: 'worksheet',
      variantId: 'variant_extra',
      childAlias: 'Ada',
    });
    expect(doc.questionCount).toBe(3);
    expect(doc.title).toContain('More practice 3');
    const text = textOf(doc.html);
    expect(text).toContain('Name: Ada');
    expect(text).toContain('More practice 3');
    expect(text).toContain(`Objective (NERDC): ${unit.header.objective}`);
    expect(doc.html).not.toContain('Tier 1');
    expect(doc.html).not.toContain('Quick-Answer Drill');
    expect(tagReport(doc.html).problems).toEqual([]);
    expect((doc.html.match(/<div class="q q-/g) ?? []).length).toBe(3);
  });

  it('prints the answers of a pool, numbered from 1', () => {
    const html = buildWorksheetHtml(unit, { kind: 'answers', variantId: 'variant_extra' });
    expect(textOf(html)).toContain('More practice 3: answers');
    const numbers = [...html.matchAll(/<span class="qnum">(\d+)\./g)].map((m) => Number(m[1]));
    expect(numbers).toEqual([1, 2, 3]);
    expect(html).not.toContain('If a child has not got it yet');
  });

  it('every pool of both fixtures builds', () => {
    for (const lesson of [golden, maths]) {
      for (const variant of listWorksheets(lesson).variants) {
        for (const kind of ['worksheet', 'answers'] as const) {
          const doc = buildWorksheet(lesson, { kind, variantId: variant.id });
          expect(doc.questionCount).toBeGreaterThan(0);
          expect(tagReport(doc.html).problems).toEqual([]);
        }
      }
    }
  });

  it('refuses a pool the lesson does not have (nothing is generated on demand)', () => {
    expect(() => buildWorksheet(unit, { kind: 'worksheet', variantId: 'made_up' })).toThrow(
      /no practice set/,
    );
  });
});
