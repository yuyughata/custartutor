import { describe, expect, it } from 'vitest';
import {
  colourChartProject,
  goldenUnit2,
  marketDayMathsUnit,
  p1BasicScienceSchemes,
  p1BasicScienceTerm1,
} from './fixtures';
import { lintUnit } from './lint';
import { parseUnit } from './parse';
import { Scheme, groupIntoChapters } from './scheme';
import { questionsOf } from './unit';
import { gradeQuestion } from './grade';

/**
 * Warnings each fixture is ALLOWED to produce (anything else fails the test, so a new warning is a
 * conscious decision):
 *  - golden Unit 2: the template has no Window to the World section.
 */
const ALLOWED_WARNINGS: Record<string, string[]> = {
  // no_global_window: the template has no Window to the World. reading_level: the template's own
  // "Tell It Back" prompt is one long sentence; the template wins (docs/adr/0006).
  golden: ['no_global_window', 'reading_level'],
  maths: [],
};

describe('fixtures parse and lint', () => {
  it('golden Unit 2 parses, round-trips and lints with zero errors', () => {
    const parsed = parseUnit(goldenUnit2);
    expect(parsed).toEqual(goldenUnit2);
    const report = lintUnit(parsed);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(ALLOWED_WARNINGS.golden);
  });

  it('P1 Mathematics Market Day parses and lints with zero errors and zero warnings', () => {
    const parsed = parseUnit(marketDayMathsUnit);
    expect(parsed).toEqual(marketDayMathsUnit);
    const report = lintUnit(parsed);
    expect(report.errors).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.warnings.map((w) => w.code)).toEqual(ALLOWED_WARNINGS.maths);
  });

  it('the colour chart mini project parses and lints with zero errors', () => {
    const parsed = parseUnit(colourChartProject);
    expect(parsed.kind).toBe('mini_project');
    const report = lintUnit(parsed);
    expect(report.errors).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  it('the schema was not overfitted: the three fixtures differ in subject, theme and kind', () => {
    expect(goldenUnit2.header.subject_slug).toBe('basic-science');
    expect(marketDayMathsUnit.header.subject_slug).toBe('mathematics');
    expect(colourChartProject.kind).toBe('mini_project');
    expect(marketDayMathsUnit.header.stage).toBe('connect');
  });
});

describe('golden Unit 2 transcription', () => {
  it('keeps the NERDC objective and the stage range from the template', () => {
    expect(goldenUnit2.header.objective).toBe(
      'Explore the school environment (classroom, playground, toilet, staff room) and the home environment (bedroom, kitchen, living room, bathroom, compound); identify the people in our environment; understand safety; take care of our environment by keeping it clean.',
    );
    expect(goldenUnit2.header.stage).toBe('absorb');
    expect(goldenUnit2.header.stage_to).toBe('connect');
    expect(goldenUnit2.header.chapter).toEqual({ number: 1, title: 'Our World Around Us' });
    expect(goldenUnit2.header.week_no).toBe(2);
  });

  it('keeps the five enrichment sections and four concept sections the template prints', () => {
    const types = goldenUnit2.sections.map((s) => s.type);
    expect(types.filter((t) => t === 'concept')).toHaveLength(4);
    expect(
      types.filter((t) =>
        [
          'story_opener',
          'remember',
          'do_and_discover',
          'character_values',
          'tell_it_back',
        ].includes(t),
      ),
    ).toHaveLength(5);
    expect(goldenUnit2.sections.filter((s) => s.layer === 'ENRICH')).toHaveLength(5);
  });

  it('has Zari and Zuri in the story opener, five quick-fire items and four Think Deeper prompts', () => {
    const story = goldenUnit2.sections.find((s) => s.type === 'story_opener');
    expect(JSON.stringify(story)).toContain('Zari and Zuri');
    const quick = goldenUnit2.sections.find((s) => s.type === 'quick_fire');
    expect(quick?.blocks.filter((b) => b.type === 'question')).toHaveLength(5);
    const deeper = goldenUnit2.sections.find((s) => s.type === 'think_deeper');
    const bullets = deeper?.blocks[0];
    expect(bullets?.type === 'bullets' ? bullets.items : []).toHaveLength(4);
  });

  it('has the workbook shape from pages 4-5 and at least two practice variants', () => {
    expect(goldenUnit2.workbook.tiers.map((t) => t.tier)).toEqual([1, 2, 3]);
    expect(goldenUnit2.workbook.quick_answer_drill).toMatchObject({ seconds: 60 });
    expect(goldenUnit2.workbook.quick_answer_drill.question_ids).toHaveLength(5);
    expect(goldenUnit2.workbook.practice_variants.length).toBeGreaterThanOrEqual(2);
    expect(goldenUnit2.workbook.take_it_home).toContain('walk through your home');
  });

  it('has a gradable mastery check built from the three I can statements', () => {
    const mastery = goldenUnit2.sections.find((s) => s.type === 'mastery_check');
    const ids = (mastery?.blocks ?? []).flatMap((b) =>
      b.type === 'question' ? [b.question_id] : [],
    );
    expect(ids).toEqual(['mc_places', 'mc_people', 'mc_safe_clean']);
    const questions = questionsOf(goldenUnit2);
    for (const id of ids) {
      expect(['sort', 'match', 'circle']).toContain(questions[id]?.kind);
    }
  });

  it('can be graded offline with the answer key from the workbook', () => {
    const questions = questionsOf(goldenUnit2);
    const match = questions.wb_match_places;
    expect(
      match &&
        gradeQuestion(match, {
          kind: 'match',
          pairs: [
            { left: 'Kitchen', right: 'Cook' },
            { left: 'Bedroom', right: 'Sleep' },
            { left: 'Playground', right: 'Play' },
            { left: 'Classroom', right: 'Learn' },
            { left: 'Bathroom', right: 'Bath' },
          ],
        }).result,
    ).toBe('correct');
    const circle = questions.wb_circle_people;
    expect(
      circle &&
        gradeQuestion(circle, {
          kind: 'circle',
          selected: ['teacher', 'friend', 'classmate'],
        }).result,
    ).toBe('correct');
  });
});

describe('Market Day Mathematics fixture', () => {
  it('uses numeric fill_blank answers and grades them exactly', () => {
    const questions = questionsOf(marketDayMathsUnit);
    const numeric = Object.values(questions).filter(
      (q) => q.kind === 'fill_blank' && q.answer.blanks.some((blank) => blank.numeric),
    );
    expect(numeric.length).toBeGreaterThanOrEqual(10);
    const change = questions.m_change_bread;
    expect(change && gradeQuestion(change, { kind: 'fill_blank', answers: ['₦3'] }).result).toBe(
      'correct',
    );
    expect(
      change && gradeQuestion(change, { kind: 'fill_blank', answers: ['3 naira'] }).result,
    ).toBe('correct');
    expect(change && gradeQuestion(change, { kind: 'fill_blank', answers: ['7'] }).result).toBe(
      'incorrect',
    );
    const share = questions.m_share_half;
    for (const answer of ['1/2', '0.5', '½', 'half']) {
      expect(share && gradeQuestion(share, { kind: 'fill_blank', answers: [answer] }).result).toBe(
        'correct',
      );
    }
    const kobo = questions.m_kobo;
    expect(kobo && gradeQuestion(kobo, { kind: 'fill_blank', answers: ['10'] }).result).toBe(
      'incorrect',
    );
    expect(kobo && gradeQuestion(kobo, { kind: 'fill_blank', answers: ['1,00'] }).result).toBe(
      'incorrect',
    );
  });

  it('includes the global window the golden unit lacks', () => {
    expect(marketDayMathsUnit.sections.some((s) => s.type === 'window_to_world')).toBe(true);
  });
});

describe('P1 Basic Science scheme fixture', () => {
  it('has three terms of 13 weeks that all validate', () => {
    expect(p1BasicScienceSchemes).toHaveLength(3);
    p1BasicScienceSchemes.forEach((scheme, index) => {
      expect(Scheme.parse(scheme)).toEqual(scheme);
      expect(scheme.term).toBe(index + 1);
      expect(scheme.weeks).toHaveLength(13);
      expect(scheme.weeks.map((w) => w.week_no)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ]);
    });
  });

  it('classifies the non-teaching weeks the same way in every term', () => {
    for (const scheme of p1BasicScienceSchemes) {
      const kinds = scheme.weeks.map((w) => w.kind);
      expect(kinds).toEqual([
        'teaching',
        'teaching',
        'teaching',
        'teaching',
        'mid_term_exam',
        'break',
        'teaching',
        'teaching',
        'teaching',
        'teaching',
        'revision',
        'exam',
        'closing',
      ]);
    }
  });

  it('matches the PDF for Term 1 week 2 (the golden unit) and for the exam weeks', () => {
    const week2 = p1BasicScienceTerm1.weeks[1];
    expect(week2?.topic).toBe('Exploring Our Environment (Part 2)');
    expect(week2?.subtopics).toHaveLength(5);
    expect(week2?.subtopics[4]).toBe('Taking care of our environment (keeping it clean)');
    expect(p1BasicScienceTerm1.weeks[4]).toMatchObject({
      topic: 'MID-TERM EXAMINATION',
      subtopics: ['Assessment of Weeks 1–4'],
    });
    expect(p1BasicScienceTerm1.weeks[3]?.subtopics).toHaveLength(6);
    expect(goldenUnit2.header.title).toBe(week2?.topic);
  });

  it('proposes chapters of 3 to 5 units for every term', () => {
    for (const scheme of p1BasicScienceSchemes) {
      const { chapters, warnings } = groupIntoChapters(scheme, { min: 3, max: 5 });
      expect(warnings).toEqual([]);
      expect(chapters.map((c) => c.week_nos)).toEqual([
        [1, 2, 3, 4],
        [7, 8, 9, 10],
      ]);
      for (const chapter of chapters) {
        expect(chapter.week_nos.length).toBeGreaterThanOrEqual(3);
        expect(chapter.week_nos.length).toBeLessThanOrEqual(5);
      }
    }
  });
});
