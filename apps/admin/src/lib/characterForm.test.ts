import { describe, expect, it } from 'vitest';
import { CastTraits } from '@custar/authoring-core';
import type { CharacterRecord } from '../api/types';
import { formsEqual, fromForm, statedFacts, toForm, validateForm } from './characterForm';

const zuri: CharacterRecord = {
  id: 'c2',
  slug: 'zuri',
  name: 'Zuri',
  traits: {
    age_years: 4,
    age_note: 'almost 5',
    gender: 'male',
    pronouns: 'he/him',
    personality: [],
    derived_guidance: 'Derived from age. Uses very simple words.',
  },
  voice: { notes: 'Speaks softly', accent: 'Lagos' },
  active: true,
};

describe('character form', () => {
  it('round-trips a record without inventing anything', () => {
    const form = toForm(zuri);
    expect(form).toMatchObject({ ageYears: '4', ageNote: 'almost 5', gender: 'male', voiceNotes: 'Speaks softly', relationshipNote: '' });
    expect(fromForm(zuri, form)).toEqual(zuri);
  });

  it('stores blank fields as not stated', () => {
    const blank: CharacterRecord = { ...zuri, traits: { personality: [] }, voice: {} };
    const out = fromForm(blank, toForm(blank));
    expect(out.traits).toEqual({ personality: [] });
    expect(out.voice).toEqual({});
  });

  it('saves edits: facts, relationship, personality lines and derived guidance', () => {
    const form = {
      ...toForm(zuri),
      relationshipNote: '  Zari is Zuri’s big sister  ',
      personality: ' curious \n\n shy ',
      ageNote: '',
      gender: '' as const,
      derivedGuidance: '',
    };
    const out = fromForm(zuri, form);
    expect(out.traits).toEqual({
      age_years: 4,
      pronouns: 'he/him',
      relationship_note: 'Zari is Zuri’s big sister',
      personality: ['curious', 'shy'],
    });
    expect(CastTraits.safeParse(out.traits).success).toBe(true);
  });

  it('keeps other voice keys and removes notes when cleared', () => {
    const cleared = fromForm(zuri, { ...toForm(zuri), voiceNotes: ' ' });
    expect(cleared.voice).toEqual({ accent: 'Lagos' });
    const changed = fromForm(zuri, { ...toForm(zuri), voiceNotes: 'Loud' });
    expect(changed.voice).toEqual({ notes: 'Loud', accent: 'Lagos' });
  });

  it('validates name and age', () => {
    expect(validateForm(toForm(zuri))).toEqual({});
    expect(validateForm({ ...toForm(zuri), name: ' ' }).name).toBeDefined();
    for (const bad of ['1', '21', '4.5', 'five']) {
      expect(validateForm({ ...toForm(zuri), ageYears: bad }).ageYears).toMatch(/whole number from 2 to 20/);
    }
    expect(validateForm({ ...toForm(zuri), ageYears: '' })).toEqual({});
  });

  it('detects edits and lists stated facts', () => {
    expect(formsEqual(toForm(zuri), toForm(zuri))).toBe(true);
    expect(formsEqual(toForm(zuri), { ...toForm(zuri), pronouns: 'they' })).toBe(false);
    expect(statedFacts(zuri)).toEqual(['age 4 (almost 5)', 'male', 'he/him']);
    expect(statedFacts({ ...zuri, traits: { personality: ['shy'] } })).toEqual(['1 personality trait']);
  });
});
