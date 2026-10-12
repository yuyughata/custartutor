// The characters editor works on a flat form of strings; this converts to and from the stored CharacterRecord.
// Only facts typed here become facts: a blank field is stored as "not stated", never guessed. Unknown keys in
// `voice` are kept untouched. Pure and tested.
import type { Json } from '@custar/authoring-core';
import type { CharacterRecord } from '../api/types';

export interface CharacterForm {
  name: string;
  ageYears: string;
  ageNote: string;
  gender: '' | 'female' | 'male';
  pronouns: string;
  relationshipNote: string;
  /** One trait per line. */
  personality: string;
  derivedGuidance: string;
  voiceNotes: string;
  active: boolean;
}

export const AGE_MIN = 2;
export const AGE_MAX = 20;

export function toForm(character: CharacterRecord): CharacterForm {
  const notes = character.voice.notes;
  return {
    name: character.name,
    ageYears: character.traits.age_years === undefined ? '' : String(character.traits.age_years),
    ageNote: character.traits.age_note ?? '',
    gender: character.traits.gender ?? '',
    pronouns: character.traits.pronouns ?? '',
    relationshipNote: character.traits.relationship_note ?? '',
    personality: character.traits.personality.join('\n'),
    derivedGuidance: character.traits.derived_guidance ?? '',
    voiceNotes: typeof notes === 'string' ? notes : '',
    active: character.active,
  };
}

export type FormProblems = Partial<Record<'name' | 'ageYears', string>>;

export function validateForm(form: CharacterForm): FormProblems {
  const problems: FormProblems = {};
  if (form.name.trim() === '') problems.name = 'A character needs a name.';
  const age = form.ageYears.trim();
  if (age !== '') {
    const value = Number(age);
    if (!Number.isInteger(value) || value < AGE_MIN || value > AGE_MAX) {
      problems.ageYears = `Age must be a whole number from ${AGE_MIN} to ${AGE_MAX}. Use the age note for "almost 5".`;
    }
  }
  return problems;
}

/** Builds the record to save. Call only when `validateForm` found no problems. */
export function fromForm(original: CharacterRecord, form: CharacterForm): CharacterRecord {
  const text = (value: string): string | undefined => {
    const trimmed = value.trim();
    return trimmed === '' ? undefined : trimmed;
  };
  const age = form.ageYears.trim();
  const ageNote = text(form.ageNote);
  const gender = form.gender === '' ? undefined : form.gender;
  const pronouns = text(form.pronouns);
  const relationshipNote = text(form.relationshipNote);
  const derivedGuidance = text(form.derivedGuidance);
  const traits = {
    personality: form.personality
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== ''),
    ...(age !== '' ? { age_years: Number(age) } : {}),
    ...(ageNote ? { age_note: ageNote } : {}),
    ...(gender ? { gender } : {}),
    ...(pronouns ? { pronouns } : {}),
    ...(relationshipNote ? { relationship_note: relationshipNote } : {}),
    ...(derivedGuidance ? { derived_guidance: derivedGuidance } : {}),
  };
  const voice: Record<string, Json> = { ...original.voice };
  const notes = text(form.voiceNotes);
  if (notes) voice.notes = notes;
  else delete voice.notes;
  return { ...original, name: form.name.trim(), traits, voice, active: form.active };
}

export function formsEqual(a: CharacterForm, b: CharacterForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Facts the owner has stated, for the summary line on each card. */
export function statedFacts(character: CharacterRecord): string[] {
  const facts: string[] = [];
  const { traits } = character;
  if (traits.age_years !== undefined) {
    facts.push(`age ${traits.age_years}${traits.age_note ? ` (${traits.age_note})` : ''}`);
  } else if (traits.age_note) facts.push(`age: ${traits.age_note}`);
  if (traits.gender) facts.push(traits.gender);
  if (traits.pronouns) facts.push(traits.pronouns);
  if (traits.relationship_note) facts.push('relationship noted');
  if (traits.personality.length > 0) facts.push(`${traits.personality.length} personality trait${traits.personality.length === 1 ? '' : 's'}`);
  return facts;
}
