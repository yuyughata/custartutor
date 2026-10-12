import { describe, expect, it } from 'vitest';
import { parseUnit, questionsOf, sectionsOf } from '@custar/content-schema';
import type { AnyBlock, Question, Section } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import { blockSpeechText, questionSpeechText, sectionSpeechText } from './speechText';

const none = { questions: {} };

describe('blockSpeechText', () => {
  it('strips bold markers and ends each piece with a full stop', () => {
    const block: AnyBlock = { type: 'paragraph', text: 'We **learn** in the classroom' };
    expect(blockSpeechText(block, none)).toBe('We learn in the classroom.');
  });

  it('reads definitions, examples, dialogue and callouts', () => {
    expect(
      blockSpeechText({ type: 'definition', term: 'Environment', meaning: 'All around us.' }, none),
    ).toBe('Environment. All around us.');
    expect(
      blockSpeechText({ type: 'example', label: 'Example 1:', text: 'A **bin**.' }, none),
    ).toBe('Example 1: A bin.');
    expect(
      blockSpeechText(
        {
          type: 'dialogue',
          lines: [
            { character: 'Zari', text: 'Hello!' },
            { character: 'Zuri', text: 'Hi, Zari.' },
          ],
        },
        none,
      ),
    ).toBe('Zari says: Hello! Zuri says: Hi, Zari.');
    expect(blockSpeechText({ type: 'callout', tone: 'tip', text: 'Wash your hands' }, none)).toBe(
      'Wash your hands.',
    );
  });

  it('reads bullets with their lead words and activity steps with their labels', () => {
    expect(
      blockSpeechText(
        {
          type: 'bullets',
          items: [{ lead: 'Home', text: 'where we sleep' }, { text: 'School' }],
        },
        none,
      ),
    ).toBe('Home: where we sleep. School.');
    expect(
      blockSpeechText(
        { type: 'activity_steps', steps: [{ label: 'Step 1', text: 'Look around' }] },
        none,
      ),
    ).toBe('Step 1. Look around.');
  });

  it('says what an illustration shows, from its alt text and not its production brief', () => {
    const text = blockSpeechText(
      {
        type: 'illustration',
        brief: 'Zari and Zuri outside the school gate, painted style, warm light',
        alt: 'Two children at the school gate',
      },
      none,
    );
    expect(text).toBe('Picture: Two children at the school gate.');
    expect(text).not.toContain('painted');
  });

  it('reads a table row by row with its headers', () => {
    expect(
      blockSpeechText(
        {
          type: 'table',
          headers: ['Place', 'We'],
          rows: [
            ['Kitchen', 'cook'],
            ['Bedroom', 'sleep'],
          ],
        },
        none,
      ),
    ).toBe('Place: Kitchen, We: cook. Place: Bedroom, We: sleep.');
  });

  it('says nothing for an unknown block or a missing question', () => {
    expect(blockSpeechText({ type: 'unknown', original_type: 'hologram', raw: {} }, none)).toBe('');
    expect(blockSpeechText({ type: 'question', question_id: 'nope' }, none)).toBe('');
  });
});

describe('questionSpeechText', () => {
  const base = { id: 'q_one', tier: 1 as const, hint: 'SECRET HINT', explanation: 'SECRET WHY' };

  it('reads every option of a multiple-choice question and not the answer or hint', () => {
    const question: Question = {
      ...base,
      kind: 'mcq',
      prompt: 'Where do we **cook**?',
      options: ['Kitchen', 'Bedroom', 'Playground'],
      answer: { correct_index: 0 },
    };
    const text = questionSpeechText(question);
    expect(text).toBe('Where do we cook? Choose one. Kitchen. Bedroom. Playground.');
    expect(text).not.toContain('SECRET');
  });

  it('speaks a blank as the word blank, never as underscores', () => {
    const question: Question = {
      ...base,
      kind: 'fill_blank',
      prompt: 'We sleep in the ____.',
      answer: { blanks: [{ accepted: ['bedroom'] }] },
    };
    const text = questionSpeechText(question);
    expect(text).toBe('We sleep in the blank.');
    expect(text).not.toContain('_');
  });

  it('describes match, circle, sort, tap_image, speak, draw and free_text without answers', () => {
    const match: Question = {
      ...base,
      kind: 'match',
      prompt: 'Match them.',
      distractors: ['Fly'],
      answer: {
        pairs: [
          { left: 'Kitchen', right: 'Cook' },
          { left: 'Bedroom', right: 'Sleep' },
        ],
      },
    };
    expect(questionSpeechText(match)).toBe(
      'Match them. Match these. Kitchen. Bedroom. With these. Cook. Fly. Sleep.',
    );

    const circle: Question = {
      ...base,
      kind: 'circle',
      prompt: 'Circle the people at school.',
      options: ['teacher', 'astronaut'],
      answer: { correct: ['teacher'] },
    };
    expect(questionSpeechText(circle)).toBe('Circle the people at school. teacher. astronaut.');

    const sort: Question = {
      ...base,
      kind: 'sort',
      prompt: 'Sort the places.',
      items: ['classroom', 'kitchen'],
      categories: ['At school', 'At home'],
      answer: { mapping: { classroom: 'At school', kitchen: 'At home' } },
    };
    expect(questionSpeechText(sort)).toBe(
      'Sort the places. Sort these. classroom. kitchen. Put each one with: At school, or At home.',
    );

    const tap: Question = {
      ...base,
      kind: 'tap_image',
      prompt: 'Tap the bin.',
      brief: 'A classroom with a bin',
      alt: 'A classroom with a red bin by the door',
      answer: {
        hotspots: [
          { id: 'bin', label: 'The bin', x: 0.1, y: 0.1, w: 0.2, h: 0.2, correct: true },
          { id: 'desk', label: 'The desk', x: 0.5, y: 0.5, w: 0.2, h: 0.2, correct: false },
        ],
      },
    };
    expect(questionSpeechText(tap)).toBe(
      'Tap the bin. Look at the picture. A classroom with a red bin by the door. The bin. The desk.',
    );

    const speak: Question = {
      ...base,
      kind: 'speak',
      prompt: 'Say hello.',
      answer: { expected: ['hello'] },
    };
    expect(questionSpeechText(speak)).toBe('Say hello. Say it out loud.');

    const draw: Question = {
      ...base,
      kind: 'draw',
      prompt: 'Draw your room.',
      self_check: ['I drew a bed'],
    };
    expect(questionSpeechText(draw)).toBe(
      'Draw your room. Draw it, then check your drawing. I drew a bed.',
    );

    const free: Question = {
      ...base,
      kind: 'free_text',
      prompt: 'Name one neighbour.',
      rubric: { criteria: ['names a person'], exemplar: 'EXEMPLAR ANSWER' },
    };
    expect(questionSpeechText(free)).toBe('Name one neighbour.');

    for (const q of [match, circle, sort, tap, speak, draw, free]) {
      expect(questionSpeechText(q)).not.toMatch(/SECRET|EXEMPLAR/);
    }
  });
});

describe('sectionSpeechText on the fixtures', () => {
  const units = [parseUnit(goldenUnit2), parseUnit(marketDayMathsUnit)];

  it('says something for every section, starting with its heading, with no markup left', () => {
    for (const unit of units) {
      const questions = questionsOf(unit);
      for (const section of sectionsOf(unit)) {
        const text = sectionSpeechText(section, questions);
        expect(text.length, section.id).toBeGreaterThan(section.heading.length);
        expect(text.startsWith(section.heading.replace(/\*\*/g, '')), section.id).toBe(true);
        expect(text, section.id).not.toContain('**');
        expect(text, section.id).not.toMatch(/_{2,}/);
      }
    }
  });

  it('never reads out a hint, an explanation or a rubric exemplar from the questions it speaks', () => {
    for (const unit of units) {
      const questions = questionsOf(unit);
      for (const section of sectionsOf(unit)) {
        const text = sectionSpeechText(section, questions);
        for (const block of section.blocks) {
          if (block.type !== 'question') continue;
          const question = questions[block.question_id];
          if (!question) continue;
          for (const secret of [
            question.hint,
            question.explanation,
            'rubric' in question ? question.rubric.exemplar : undefined,
          ]) {
            if (secret) expect(text, `${section.id}/${question.id}`).not.toContain(secret);
          }
        }
      }
    }
  });

  it('reads the mastery check questions with all of their options', () => {
    const unit = units[0];
    if (!unit || unit.kind !== 'lesson') throw new Error('fixture');
    const section: Section | undefined = unit.sections.find((s) => s.type === 'mastery_check');
    if (!section) throw new Error('no mastery check');
    const text = sectionSpeechText(section, unit.questions);
    // The sort question lists its items and categories; the circle question its options.
    expect(text).toContain('classroom');
    expect(text).toContain('At school');
    expect(text).toContain('At home');
  });
});
