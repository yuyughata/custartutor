import { describe, expect, it } from 'vitest';
import { parseUnit } from '@custar/content-schema';
import type { LessonUnit } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import {
  getReady,
  hasHelp,
  helpForSection,
  masterySections,
  periodOfSection,
  retryIndex,
} from './script';

const golden = parseUnit(goldenUnit2) as LessonUnit;
const maths = parseUnit(marketDayMathsUnit) as LessonUnit;

describe('helpForSection', () => {
  it('returns the helper steps and the say / ask / watch-for lines of a section', () => {
    const help = helpForSection(golden.teacher_manual, 'places_in_school');
    expect(help.sectionId).toBe('places_in_school');
    expect(help.steps).toHaveLength(3);
    expect(help.steps[0]).toMatch(/Read each place aloud/);
    expect(help.say).toMatch(/Read each place/);
    expect(help.ask).toMatch(/playground/);
    expect(help.watchFor).toMatch(/toilet/);
    expect(hasHelp(help)).toBe(true);
  });

  it('returns only the manual lines when a section has no helper steps', () => {
    const help = helpForSection(golden.teacher_manual, 'remember_senses');
    expect(help.steps).toEqual([]);
    expect(help.say).not.toBeNull();
    expect(hasHelp(help)).toBe(true);
  });

  it('returns an empty help (not an error) for a section the manual never mentions', () => {
    const help = helpForSection(golden.teacher_manual, 'no_such_section');
    expect(help).toEqual({
      sectionId: 'no_such_section',
      steps: [],
      say: null,
      ask: null,
      watchFor: null,
    });
    expect(hasHelp(help)).toBe(false);
  });

  it('merges the steps if a section appears twice in the helper script', () => {
    const manual = {
      ...golden.teacher_manual,
      helper_script: [
        { section_id: 'a_section', steps: ['One.'] },
        { section_id: 'a_section', steps: ['Two.', 'Three.'] },
      ],
    };
    expect(helpForSection(manual, 'a_section').steps).toEqual(['One.', 'Two.', 'Three.']);
  });

  it('every helper step in both fixtures belongs to a real section of the lesson', () => {
    for (const unit of [golden, maths]) {
      const ids = new Set(unit.sections.map((section) => section.id));
      for (const entry of unit.teacher_manual.helper_script) {
        expect(ids.has(entry.section_id), entry.section_id).toBe(true);
        expect(helpForSection(unit.teacher_manual, entry.section_id).steps.length).toBeGreaterThan(
          0,
        );
      }
    }
  });
});

describe('getReady', () => {
  it('lists the materials, the manual timing note and the periods in order with their sections', () => {
    const ready = getReady(golden, golden.teacher_manual);
    expect(ready.materials).toEqual(golden.teacher_manual.materials);
    expect(ready.timing).toBe(golden.teacher_manual.timing);
    expect(ready.periods.map((period) => period.period)).toEqual([1, 2]);
    expect(ready.periods[0]?.timing).toBe(
      'Start 10 min · Teach 15 min · Move and do 15 min · Practice 10 min · Close 10 min',
    );
    expect(ready.periods[0]?.totalMinutes).toBe(60);
    expect(ready.periods[0]?.sectionHeadings[0]).toBe('Come and Explore! (Our Story)');
    expect(ready.periods[0]?.sectionIds).toContain('quick_fire');
  });
});

describe('periodOfSection / masterySections / retryIndex', () => {
  it('finds the period of a section', () => {
    expect(periodOfSection(golden, 'come_and_explore')).toBe(1);
    expect(periodOfSection(golden, 'have_i_got_it')).toBe(2);
    expect(periodOfSection(golden, 'nope')).toBeNull();
  });

  it('finds the mastery check and where "Try again" goes', () => {
    expect(masterySections(golden).map((section) => section.id)).toEqual(['have_i_got_it']);
    expect(retryIndex(golden)).toBe(golden.sections.length - 1);
    expect(retryIndex(maths)).toBe(maths.sections.findIndex((s) => s.type === 'mastery_check'));
  });
});
