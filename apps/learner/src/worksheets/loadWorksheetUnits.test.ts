import { describe, expect, it } from 'vitest';
import { parseUnit } from '@custar/content-schema';
import type { LessonUnit } from '@custar/content-schema';
import { goldenUnit2, marketDayMathsUnit } from '@custar/content-schema/fixtures';
import type { Home, HomeUnit } from '../data/queries';
import { loadWorksheetUnits } from './loadWorksheetUnits';

const golden = parseUnit(goldenUnit2) as LessonUnit;
const maths = parseUnit(marketDayMathsUnit) as LessonUnit;

function item(
  id: string,
  title: string,
  kind: string,
  availability: 'not_downloaded' | 'up_to_date' | 'update_available' | null,
): HomeUnit {
  return {
    unit: { id, title, kind, unit_no: 1 } as HomeUnit['unit'],
    state: 'available',
    score: null,
    pack:
      availability === null
        ? null
        : {
            unitId: id,
            latestVersionNo: 1,
            activeVersionNo: availability === 'not_downloaded' ? null : 1,
            availability,
          },
  };
}

const home = (units: HomeUnit[]): Home => ({
  child: { id: 'c1', display_alias: 'Ada' } as Home['child'],
  groups: [
    { subject: { id: 's1', name: 'Basic Science' } as Home['groups'][number]['subject'], units },
  ],
});

const lessons: Record<string, LessonUnit> = { sci: golden, maths };

describe('loadWorksheetUnits', () => {
  it('lists only downloaded lessons, reading each from its pack', async () => {
    const read: string[] = [];
    const result = await loadWorksheetUnits(
      home([
        item('sci', 'Our Environment', 'lesson', 'up_to_date'),
        item('maths', 'Market Day', 'lesson', 'not_downloaded'),
        item('colours', 'Colour chart', 'mini_project', 'up_to_date'),
        item('nopack', 'Unpublished', 'lesson', null),
      ]),
      (id) => {
        read.push(id);
        return Promise.resolve({ unit: lessons[id] as LessonUnit });
      },
    );
    expect(result.units.map((u) => u.unitId)).toEqual(['sci']);
    expect(read).toEqual(['sci']); // nothing else was opened
    expect(result.problems).toEqual([]);
    expect(result.units[0]?.subject).toBe('Basic Science');
    expect(result.units[0]?.listing.variants).toHaveLength(2);
  });

  it('keeps going when one lesson cannot be read, and reports it', async () => {
    const result = await loadWorksheetUnits(
      home([
        item('bad', 'Broken lesson', 'lesson', 'up_to_date'),
        item('maths', 'Market Day', 'lesson', 'update_available'),
      ]),
      (id) =>
        id === 'bad'
          ? Promise.reject(new Error('The lesson file is missing or damaged'))
          : Promise.resolve({ unit: lessons[id] as LessonUnit }),
    );
    expect(result.units.map((u) => u.unitId)).toEqual(['maths']);
    expect(result.problems).toEqual([
      { unitId: 'bad', title: 'Broken lesson', message: 'The lesson file is missing or damaged' },
    ]);
  });

  it('returns nothing for a child with no downloaded lessons', async () => {
    expect(await loadWorksheetUnits(home([]), () => Promise.reject(new Error('unused')))).toEqual({
      units: [],
      problems: [],
    });
  });
});
