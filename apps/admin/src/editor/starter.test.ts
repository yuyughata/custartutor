import { describe, expect, it } from 'vitest';
import { UnitKind } from '@custar/content-schema';
import { starterUnit, type StarterContext } from './starter';
import { validateUnit } from './validate';
import { sections } from './ops';

const ctx = (kind: StarterContext['kind'], week: number | null = 4): StarterContext => ({
  kind,
  title: 'Places in school',
  objective: 'Identify places in the school.',
  stage: 'connect',
  unit_no: 7,
  week_no: week,
  chapter: { number: 2, title: 'My school' },
  subject_slug: 'social-studies',
  level_code: 'P3',
  term: 2,
});

describe('starterUnit', () => {
  it.each(UnitKind.options)('gives a %s the structure its kind needs and stamps the header', (kind) => {
    const unit = starterUnit(ctx(kind));
    expect(unit.kind).toBe(kind);
    expect(unit).toMatchObject({
      schema_version: 1,
      header: {
        title: 'Places in school',
        objective: 'Identify places in the school.',
        stage: 'connect',
        unit_no: 7,
        chapter: { number: 2, title: 'My school' },
        subject_slug: 'social-studies',
        level_code: 'P3',
        term: 2,
      },
    });
  });

  it('starts a lesson with the six always-present sections and two enrichment sections, all in the session plan and manual', () => {
    const unit = starterUnit(ctx('lesson'));
    const ids = sections(unit as never).map((s) => String(s.id));
    expect(ids).toHaveLength(8);
    expect(new Set(ids).size).toBe(8);
    expect(ids).toEqual(expect.arrayContaining(['concept_1', 'worked_examples_1', 'practice_1', 'think_deeper_1', 'quick_fire_1', 'mastery_check_1']));
    const plan = (unit.session_plan as { sections: string[]; minutes: { minutes: number }[] }[])[0]!;
    expect(plan.sections).toEqual(ids);
    expect(plan.minutes.reduce((sum, m) => sum + m.minutes, 0)).toBe(60);
    expect((unit.teacher_manual as { script: { section_id: string }[] }).script.map((r) => r.section_id)).toEqual(ids);
  });

  it('has no words anywhere, so nothing can be saved until a person writes it', () => {
    for (const kind of UnitKind.options) {
      const result = validateUnit(starterUnit(ctx(kind)));
      expect(result.canSave).toBe(false);
      expect(result.parsed).toBeNull();
    }
  });

  it('takes the week from the scheme, or defaults a lesson with none to week 1 for the author to set', () => {
    expect((starterUnit(ctx('lesson', 9)).header as { week_no: number }).week_no).toBe(9);
    expect((starterUnit(ctx('lesson', null)).header as { week_no: number }).week_no).toBe(1);
    expect(starterUnit(ctx('revision', null)).header).not.toHaveProperty('week_no');
  });
});
