import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { parseUnit } from '@custar/content-schema';
import type { LessonUnit, Question } from '@custar/content-schema';
import { goldenUnit2 } from '@custar/content-schema/fixtures';

vi.mock('react-native', async () => (await import('./rn-mock')).reactNativeMock);

const { QuestionView } = await import('./QuestionView');
const { SectionView } = await import('./SectionView');
const { UnitView } = await import('./UnitView');

const unit = parseUnit(goldenUnit2) as LessonUnit;

const mcq: Question = {
  id: 'q_mcq',
  kind: 'mcq',
  tier: 1,
  prompt: 'Where do we cook?',
  options: ['Kitchen', 'Bedroom', 'Playground'],
  answer: { correct_index: 0 },
};

const SHAPES = /[●■▲★◆♥]/;

describe('QuestionView: additive props', () => {
  it('renders exactly as before when no new prop is given (no shapes, no extras)', () => {
    const out = renderToStaticMarkup(createElement(QuestionView, { question: mcq, number: 1 }));
    expect(out).not.toMatch(SHAPES);
    expect(out).toContain('aria-label="Kitchen"');
  });

  it('adds a shape to every choice with largeTargets, and keeps the accessible name the label', () => {
    const out = renderToStaticMarkup(
      createElement(QuestionView, { question: mcq, number: 1, largeTargets: true }),
    );
    for (const shape of ['●', '■', '▲']) expect(out).toContain(shape);
    expect(out).toContain('aria-label="Kitchen"');
    expect(out).toContain('aria-label="Playground"');
  });

  it('shows extras under the prompt', () => {
    const out = renderToStaticMarkup(
      createElement(QuestionView, {
        question: mcq,
        extras: createElement('span', { 'data-testid': 'extra' }, 'EXTRA'),
      }),
    );
    expect(out).toContain('EXTRA');
    expect(out.indexOf('Where do we cook?')).toBeLessThan(out.indexOf('EXTRA'));
    expect(out.indexOf('EXTRA')).toBeLessThan(out.indexOf('Kitchen'));
  });
});

describe('SectionView and UnitView: additive props', () => {
  const section = unit.sections.find((s) => s.type === 'mastery_check');
  if (!section) throw new Error('fixture has no mastery check');

  it('renders section and question extras, and passes largeTargets down', () => {
    const out = renderToStaticMarkup(
      createElement(SectionView, {
        section,
        questions: unit.questions,
        mode: 'student',
        largeTargets: true,
        renderSectionExtras: (s) => createElement('span', null, `SECTION-EXTRA-${s.id}`),
        renderQuestionExtras: (q) => createElement('span', null, `QUESTION-EXTRA-${q.id}`),
      }),
    );
    expect(out).toContain(`SECTION-EXTRA-${section.id}`);
    expect(out).toContain('QUESTION-EXTRA-mc_places');
    expect(out).toMatch(SHAPES);
  });

  it('is unchanged without the new props', () => {
    const out = renderToStaticMarkup(
      createElement(SectionView, { section, questions: unit.questions, mode: 'student' }),
    );
    expect(out).not.toContain('EXTRA');
    expect(out).not.toMatch(SHAPES);
  });

  it('UnitView forwards the extras to its sections', () => {
    const out = renderToStaticMarkup(
      createElement(UnitView, {
        unit,
        mode: 'student',
        renderSectionExtras: (s) => createElement('span', null, `SX-${s.id}`),
      }),
    );
    for (const s of unit.sections) expect(out).toContain(`SX-${s.id}`);
  });
});
