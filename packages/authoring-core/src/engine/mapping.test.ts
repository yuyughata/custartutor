import { describe, expect, it } from 'vitest';
import { Question, parseUnit, type Block, type Question as Q } from '@custar/content-schema';
import type {
  AuthorBlock,
  AuthorQuestion,
  AuthorSectionBody,
  AuthorTutorLine,
} from '../prompts/schemas';
import {
  blockToAuthor,
  buildSectionPart,
  mapBlocks,
  mapQuestion,
  mapSectionQuestions,
  mapTutorScript,
  placeUnplacedQuestions,
  questionToAuthor,
  tutorToAuthor,
} from './mapping';
import { goldenUnit2, marketDayMathsUnit } from '../../test-support/testKit';

const blk = (partial: Partial<AuthorBlock> & Pick<AuthorBlock, 'type'>): AuthorBlock => ({
  text: '',
  label: '',
  brief: '',
  alt: '',
  tone: 'none',
  items: [],
  headers: [],
  rows: [],
  question_ref: '',
  ...partial,
});
const q = (
  partial: Partial<AuthorQuestion> & Pick<AuthorQuestion, 'ref' | 'kind' | 'prompt'>,
): AuthorQuestion => ({
  tier: 1,
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
  ...partial,
});
const line = (
  partial: Partial<AuthorTutorLine> & Pick<AuthorTutorLine, 'say'>,
): AuthorTutorLine => ({
  accepted: [],
  question_ref: '',
  on_correct: [],
  on_incorrect: [],
  hint: [],
  ...partial,
});

describe('mapQuestion', () => {
  it('builds every kind the authoring format has, and the result passes the real schema', () => {
    const cases: AuthorQuestion[] = [
      q({
        ref: 'a',
        kind: 'mcq',
        prompt: 'Which is red?',
        options: ['sky', 'blood'],
        answers: ['blood'],
      }),
      q({
        ref: 'b',
        kind: 'circle',
        prompt: 'Circle the fruit.',
        options: ['mango', 'chair', 'orange'],
        answers: ['mango', 'orange'],
      }),
      q({
        ref: 'c',
        kind: 'fill_blank',
        prompt: '2 + 3 = ____',
        blanks: [['5', 'five']],
        numeric: true,
      }),
      q({ ref: 'd', kind: 'fill_blank', prompt: 'A ____ and a ____.', blanks: [['cat'], ['dog']] }),
      q({
        ref: 'e',
        kind: 'match',
        prompt: 'Match.',
        pairs: [
          { left: 'a', right: '1' },
          { left: 'b', right: '2' },
        ],
      }),
      q({
        ref: 'f',
        kind: 'sort',
        prompt: 'Sort.',
        pairs: [
          { left: 'dog', right: 'animal' },
          { left: 'rose', right: 'plant' },
        ],
      }),
      q({
        ref: 'g',
        kind: 'free_text',
        prompt: 'Say why.',
        checks: ['A reason'],
        exemplar: 'Because.',
      }),
      q({ ref: 'h', kind: 'draw', prompt: 'Draw it.', checks: ['I drew it'] }),
    ];
    for (const authored of cases) {
      const mapped = mapQuestion(authored, `q_x_${authored.ref}`, authored.ref);
      expect(mapped.issues, authored.ref).toEqual([]);
      expect(Question.safeParse(mapped.value).success).toBe(true);
    }
  });

  it('turns the correct option text into an index and rejects answers that are not options', () => {
    const ok = mapQuestion(
      q({ ref: 'a', kind: 'mcq', prompt: 'x?', options: ['No', 'Yes'], answers: ['Yes'] }),
      'q_a',
      'a',
    );
    expect(ok.value).toMatchObject({ kind: 'mcq', answer: { correct_index: 1 } });
    const bad = mapQuestion(
      q({ ref: 'a', kind: 'mcq', prompt: 'x?', options: ['No', 'Yes'], answers: ['Maybe'] }),
      'q_a',
      'a',
    );
    expect(bad.value).toBeNull();
    expect(bad.issues.join(' ')).toMatch(/"Maybe" is not one of the options/);
  });

  it('checks the blank count against the prompt, so a miscounted fill_blank is sent back', () => {
    const bad = mapQuestion(
      q({ ref: 'c', kind: 'fill_blank', prompt: 'Two blanks ____ and ____.', blanks: [['a']] }),
      'q_c',
      'c',
    );
    expect(bad.issues.join(' ')).toMatch(/2 blank\(s\)/);
  });

  it('rejects a sort with one category, a circle where everything is correct, duplicate options and an empty prompt', () => {
    expect(
      mapQuestion(
        q({
          ref: 'a',
          kind: 'sort',
          prompt: 'x',
          pairs: [
            { left: 'a', right: 'A' },
            { left: 'b', right: 'A' },
          ],
        }),
        'q_a',
        'a',
      ).issues.join(' '),
    ).toMatch(/2 categories/);
    expect(
      mapQuestion(
        q({ ref: 'a', kind: 'circle', prompt: 'x', options: ['a', 'b'], answers: ['a', 'b'] }),
        'q_a',
        'a',
      ).issues.join(' '),
    ).toMatch(/every option is correct/);
    expect(
      mapQuestion(
        q({ ref: 'a', kind: 'mcq', prompt: 'x', options: ['a', 'A'], answers: ['a'] }),
        'q_a',
        'a',
      ).issues.join(' '),
    ).toMatch(/distinct/);
    expect(
      mapQuestion(
        q({ ref: 'a', kind: 'mcq', prompt: '  ', options: ['a', 'b'], answers: ['a'] }),
        'q_a',
        'a',
      ).issues.join(' '),
    ).toMatch(/prompt is empty/);
  });

  it('cleans a skill tag into a valid one, or drops it', () => {
    const tagged = mapQuestion(
      q({ ref: 'a', kind: 'draw', prompt: 'x', skill_tag: 'Places & Uses!' }),
      'q_a',
      'a',
    );
    expect((tagged.value as Q).skill_tag).toBe('places_uses');
    expect(
      (
        mapQuestion(q({ ref: 'a', kind: 'draw', prompt: 'x', skill_tag: '!' }), 'q_a', 'a')
          .value as Q
      ).skill_tag,
    ).toBeUndefined();
  });

  it('round-trips every authorable question of the golden and the maths units', () => {
    for (const unit of [goldenUnit2, marketDayMathsUnit]) {
      for (const original of Object.values(unit.questions)) {
        const authored = questionToAuthor(original);
        expect(authored, original.id).not.toBeNull();
        const back = mapQuestion(authored!, original.id, original.id);
        expect(back.issues, original.id).toEqual([]);
        expect(back.value, original.id).toEqual(original);
      }
    }
  });

  it('numbers ids by position and rejects a repeated ref', () => {
    const mapped = mapSectionQuestions('practice', [
      q({ ref: 'one', kind: 'draw', prompt: 'a' }),
      q({ ref: 'one', kind: 'draw', prompt: 'b' }),
    ]);
    expect(mapped.questions.map((x) => x.id)).toEqual(['q_practice_1', 'q_practice_2']);
    expect(mapped.issues.join(' ')).toMatch(/used twice/);
  });
});

describe('mapBlocks, mapTutorScript', () => {
  const refs = new Map([['a', 'q_s_1']]);

  it('maps every block type and resolves question refs to ids', () => {
    const { blocks, issues } = mapBlocks(
      [
        blk({ type: 'paragraph', text: 'Hi' }),
        blk({
          type: 'bullets',
          items: [
            { head: 'Lead', text: 'x' },
            { head: '', text: 'y' },
          ],
        }),
        blk({ type: 'definition', label: 'env', text: 'everything around us' }),
        blk({ type: 'example', label: 'Example 1', text: 't' }),
        blk({ type: 'dialogue', items: [{ head: 'Zari', text: 'Hello' }] }),
        blk({ type: 'illustration', brief: 'draw', alt: 'a picture' }),
        blk({ type: 'callout', tone: 'tip', text: 'Try it' }),
        blk({ type: 'activity_steps', items: [{ head: 'NAME', text: 'a place' }] }),
        blk({ type: 'table', headers: ['a', 'b'], rows: [['1', '2']] }),
        blk({ type: 'question', question_ref: 'a' }),
      ],
      refs,
    );
    expect(issues).toEqual([]);
    expect(blocks.map((b) => b.type)).toEqual([
      'paragraph',
      'bullets',
      'definition',
      'example',
      'dialogue',
      'illustration',
      'callout',
      'activity_steps',
      'table',
      'question',
    ]);
    expect(blocks[9]).toEqual({ type: 'question', question_id: 'q_s_1' });
    expect((blocks[1] as Extract<Block, { type: 'bullets' }>).items[1]).toEqual({ text: 'y' });
  });

  it('reports the field a block is missing, and names the known refs for a dangling question_ref', () => {
    const { issues } = mapBlocks(
      [
        blk({ type: 'paragraph' }),
        blk({ type: 'callout', text: 'x' }),
        blk({ type: 'illustration', brief: 'x' }),
        blk({ type: 'table', headers: ['a'], rows: [['1', '2']] }),
        blk({ type: 'question', question_ref: 'zz' }),
      ],
      refs,
    );
    expect(issues).toHaveLength(5);
    expect(issues[1]).toMatch(/tone/);
    expect(issues[2]).toMatch(/alt/);
    expect(issues[4]).toMatch(/known refs: a/);
  });

  it('builds tutor nodes with code-assigned ids and checks the expectation rules', () => {
    const ok = mapTutorScript(
      [
        line({ say: 'Hello.' }),
        line({
          say: 'Where?',
          accepted: ['school'],
          on_correct: ['Yes'],
          on_incorrect: ['No'],
          hint: ['Think'],
        }),
        line({ say: 'Graded', question_ref: 'a', on_correct: ['Yes'], on_incorrect: ['No'] }),
      ],
      refs,
    );
    expect(ok.issues).toEqual([]);
    expect(ok.value!.nodes.map((n) => n.id)).toEqual(['n_1', 'n_2', 'n_3']);
    expect(
      mapTutorScript([line({ say: 'Where?', accepted: ['x'] })], refs).issues.join(' '),
    ).toMatch(/on_correct/);
    expect(
      mapTutorScript(
        [
          line({
            say: 'x',
            accepted: ['x'],
            question_ref: 'a',
            on_correct: ['y'],
            on_incorrect: ['z'],
          }),
        ],
        refs,
      ).issues.join(' '),
    ).toMatch(/not both/);
    expect(mapTutorScript([], refs)).toEqual({ value: null, issues: [] });
  });
});

describe('buildSectionPart per-type rules', () => {
  const body = (over: Partial<AuthorSectionBody>): AuthorSectionBody => ({
    blocks: [blk({ type: 'paragraph', text: 'x' })],
    questions: [],
    tutor_script: [],
    ...over,
  });
  const mc = (ref: string, tier: 1 | 2 | 3 = 2, kind: AuthorQuestion['kind'] = 'mcq') =>
    kind === 'mcq'
      ? q({ ref, kind, tier, prompt: `${ref}?`, options: ['a', 'b'], answers: ['a'] })
      : q({ ref, kind, tier, prompt: `${ref}?`, checks: ['c'] });

  it('practice needs all three tiers and five questions', () => {
    const missing = buildSectionPart({
      id: 'practice',
      type: 'practice',
      heading: 'P',
      body: body({ questions: [mc('a', 1), mc('b', 1), mc('c', 2)] }),
    });
    expect(missing.part).toBeNull();
    expect(missing.issues.join(' ')).toMatch(/tier 3/);
    const ok = buildSectionPart({
      id: 'practice',
      type: 'practice',
      heading: 'P',
      body: body({
        questions: [mc('a', 1), mc('b', 1), mc('c', 2), mc('d', 2), mc('e', 3, 'free_text')],
      }),
    });
    expect(ok.issues).toEqual([]);
    // unplaced questions are appended as blocks
    expect(ok.part!.section.blocks.filter((b) => b.type === 'question')).toHaveLength(5);
  });

  it('the mastery check may only hold auto-gradable questions', () => {
    const bad = buildSectionPart({
      id: 'mastery_check',
      type: 'mastery_check',
      heading: 'M',
      body: body({ questions: [mc('a'), mc('b'), mc('c', 2, 'free_text')] }),
    });
    expect(bad.issues.join(' ')).toMatch(/q_mastery_check_3 is free_text/);
    expect(
      buildSectionPart({
        id: 'mastery_check',
        type: 'mastery_check',
        heading: 'M',
        body: body({ questions: [mc('a'), mc('b')] }),
      }).issues,
    ).toEqual([]);
  });

  it('think_deeper needs prompts, quick_fire needs gradable questions, and every section needs blocks', () => {
    expect(
      buildSectionPart({
        id: 'think_deeper',
        type: 'think_deeper',
        heading: 'T',
        body: body({}),
      }).issues.join(' '),
    ).toMatch(/at least 2 prompts/);
    expect(
      buildSectionPart({
        id: 'quick_fire',
        type: 'quick_fire',
        heading: 'Q',
        body: body({
          questions: [mc('a', 1, 'free_text'), mc('b', 1, 'free_text'), mc('c', 1, 'free_text')],
        }),
      }).issues.join(' '),
    ).toMatch(/auto-gradable/);
    expect(
      buildSectionPart({
        id: 'concept_1',
        type: 'concept',
        heading: 'C',
        body: body({ blocks: [] }),
      }).issues.join(' '),
    ).toMatch(/no blocks/);
  });

  it('puts unplaced question blocks before a closing not_yet callout', () => {
    const blocks: Block[] = [
      { type: 'paragraph', text: 'x' },
      { type: 'callout', tone: 'not_yet', text: 'Not yet?' },
    ];
    const placed = placeUnplacedQuestions(blocks, ['q_1']);
    expect(placed.map((b) => b.type)).toEqual(['paragraph', 'question', 'callout']);
  });
});

describe('author view of a unit', () => {
  it('round-trips blocks and tutor scripts of the golden unit', () => {
    for (const section of goldenUnit2.sections) {
      const refs = new Map(Object.keys(goldenUnit2.questions).map((id) => [id, id]));
      const mapped = mapBlocks(section.blocks.map(blockToAuthor), refs);
      expect(mapped.issues, section.id).toEqual([]);
      expect(mapped.blocks, section.id).toEqual(section.blocks);
      if (section.tutor_script) {
        const tutor = mapTutorScript(tutorToAuthor(section.tutor_script), refs);
        expect(tutor.issues, section.id).toEqual([]);
        expect(
          tutor.value!.nodes.map((n) => [n.say, n.expect, n.on_correct, n.on_incorrect, n.hint]),
        ).toEqual(
          section.tutor_script.nodes.map((n) => [
            n.say,
            n.expect,
            n.on_correct,
            n.on_incorrect,
            n.hint,
          ]),
        );
      }
    }
    expect(parseUnit(JSON.parse(JSON.stringify(goldenUnit2))).kind).toBe('lesson');
  });
});
