import { goldenUnit2, marketDayMathsUnit, colourChartProject } from '@custar/content-schema/fixtures';
import { questionsOf, sectionsOf } from '@custar/content-schema';
import { describe, expect, it } from 'vitest';
import { buildGrounding, buildMasteryGuard } from './grounding';

const options = { versionNo: 3, unitId: '11111111-1111-4111-8111-111111111111' };
const g = buildGrounding(goldenUnit2, options);

describe('buildGrounding on the golden unit', () => {
  it('carries the identity and the objective verbatim', () => {
    expect(g).toMatchObject({
      unit_id: options.unitId,
      version_no: 3,
      title: 'Exploring Our Environment (Part 2)',
      subject_name: 'Basic Science',
      level_code: 'P1',
      stage: 'absorb',
      objective: goldenUnit2.header.objective,
    });
  });

  it('takes the vocabulary from bold terms and definitions', () => {
    const terms = g.vocabulary.map((v) => v.term.toLowerCase());
    expect(terms).toEqual(expect.arrayContaining(['classroom', 'playground', 'kitchen', 'bedroom']));
    expect(g.vocabulary.find((v) => v.term === 'classroom')?.meaning).toBe('where we learn.');
  });

  it('digests every section in order', () => {
    expect(g.sections.map((s) => s.id)).toEqual(sectionsOf(goldenUnit2).map((s) => s.id));
    expect(g.sections.find((s) => s.id === 'places_in_school')?.digest).toContain('The classroom — where we learn.');
    expect(g.sections.find((s) => s.id === 'come_and_explore')?.digest).toContain('Picture:');
    for (const s of g.sections) expect(s.digest.length).toBeLessThanOrEqual(600);
  });

  it('lists practice questions with short answers', () => {
    const cook = g.practice.find((q) => q.id === 'wb_fill_cook');
    expect(cook).toEqual({ id: 'wb_fill_cook', prompt: 'Fill in the blank. We cook our food in the ____.', answer: 'kitchen' });
    expect(g.practice.find((q) => q.id === 'qf_gutter')?.answer).toBe('No');
    expect(g.practice.find((q) => q.id === 'wb_circle_people')?.answer).toBe('teacher, friend, classmate');
    expect(g.practice.find((q) => q.id === 'wb_application')?.answer).toBeNull();
  });

  it('gives the mastery check as prompts only', () => {
    expect(g.mastery_prompts.map((q) => q.id)).toEqual(['mc_places', 'mc_people', 'mc_safe_clean']);
    for (const q of g.mastery_prompts) expect(Object.keys(q).sort()).toEqual(['id', 'prompt']);
    expect(g.practice.some((q) => q.id.startsWith('mc_'))).toBe(false);
  });

  it('leaks nothing of the mastery check, the manual or the scripts', () => {
    const text = JSON.stringify(g);
    const questions = questionsOf(goldenUnit2);
    for (const id of ['mc_places', 'mc_people', 'mc_safe_clean']) {
      const q = questions[id];
      expect(q?.hint).toBeDefined();
      expect(text).not.toContain(q?.hint as string);
    }
    // options and categories that appear nowhere else
    expect(text).not.toContain('Play near a deep gutter');
    expect(text).not.toContain('teachers and friends');
    expect(text).not.toContain('Not yet?');
    expect(text).not.toContain('Do not give hints or answers');
    expect(text).not.toContain('Hello! Zari and Zuri are going to explore');
    expect(text).not.toContain('Read the story aloud');
    const mastery = g.sections.find((s) => s.type === 'mastery_check');
    expect(mastery?.digest).toContain('Question: I can name places');
    expect(mastery?.digest).not.toContain('Not yet');
  });

  it('is deterministic', () => {
    expect(buildGrounding(goldenUnit2, options)).toEqual(g);
  });
});

describe('other units', () => {
  it('handles a unit with a different subject and a project without sections', () => {
    const maths = buildGrounding(marketDayMathsUnit, { ...options, subjectName: 'Mathematics' });
    expect(maths.subject_name).toBe('Mathematics');
    expect(maths.mastery_prompts.length).toBeGreaterThan(0);
    const project = buildGrounding(colourChartProject, options);
    expect(project.sections.length).toBeGreaterThanOrEqual(0);
    expect(project.title.length).toBeGreaterThan(0);
  });
});

describe('buildMasteryGuard', () => {
  const guard = buildMasteryGuard(goldenUnit2);

  it('holds the answers as phrase groups, for the sanitiser only', () => {
    expect(guard).toContainEqual(['classroom', 'At school']);
    expect(guard).toContainEqual(['Put rubbish in the bin']);
    expect(guard).toContainEqual(['At home', 'family']);
  });

  it('is never part of the grounding', () => {
    const text = JSON.stringify(g);
    expect(text).not.toContain('"At school"');
  });
});
