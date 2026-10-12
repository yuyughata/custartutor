import { describe, expect, it } from 'vitest';
import { goldenUnit2 } from '@custar/content-schema/fixtures';
import { parseUnit, type UnitContent } from '@custar/content-schema';
import { headerDrift, stampHeader } from './headerStamp';

const gold = goldenUnit2 as UnitContent;
const same = { unit_no: 2, week_no: 2, chapter: { number: 1, title: 'Our World Around Us' } };

describe('header drift', () => {
  it('is empty when the unit row and the header agree', () => {
    expect(headerDrift(gold, same)).toEqual([]);
  });

  it('names what moved when units were added in an earlier chapter', () => {
    const drift = headerDrift(gold, { unit_no: 3, week_no: 2, chapter: { number: 2, title: 'Our Environment' } });
    expect(drift.map((d) => d.field)).toEqual(['unit_no', 'chapter']);
    expect(drift[0]).toMatchObject({ have: '2', want: '3' });
    expect(drift[1]?.want).toBe('2: Our Environment');
  });

  it('a unit without a scheme week does not touch the header week', () => {
    expect(headerDrift(gold, { ...same, week_no: null })).toEqual([]);
    expect(stampHeader(gold, { ...same, week_no: null }).header.week_no).toBe(2);
    expect(headerDrift(gold, { ...same, week_no: 5 }).map((d) => d.field)).toEqual(['week_no']);
  });
});

describe('stampHeader', () => {
  it('writes the number, chapter and week, and the result still parses', () => {
    const stamped = stampHeader(gold, { unit_no: 7, week_no: 6, chapter: { number: 2, title: 'Our Environment' } });
    expect(stamped.header.unit_no).toBe(7);
    expect(stamped.header.chapter).toEqual({ number: 2, title: 'Our Environment' });
    expect(stamped.header.week_no).toBe(6);
    expect(gold.header.unit_no).toBe(2);
    expect(() => parseUnit(stamped)).not.toThrow();
    expect(headerDrift(stamped, { unit_no: 7, week_no: 6, chapter: { number: 2, title: 'Our Environment' } })).toEqual([]);
  });
});
