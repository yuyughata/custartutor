// The cast bible, rendered from `input.cast` (the `characters` table). Only facts the owner supplied are facts;
// guidance derived from age is printed under its own heading, labelled as derived and adjustable.
import type { CastMember, Json } from '../contract';

function ageText(member: CastMember): string {
  const { age_note, age_years } = member.traits;
  if (age_note && age_note.trim() !== '') return age_note.trim();
  return age_years !== undefined ? String(age_years) : 'not supplied';
}

function factsLine(member: CastMember): string {
  const { gender, pronouns, personality } = member.traits;
  const parts = [
    `gender: ${gender ?? 'not supplied'}${pronouns ? ` (${pronouns})` : ''}`,
    `age: ${ageText(member)}`,
    `personality: ${personality.length > 0 ? personality.join('; ') : 'none supplied'}`,
  ];
  return `- ${member.name}: ${parts.join('; ')}.`;
}

function voiceLine(member: CastMember): string | null {
  const entries = Object.entries(member.voice as Record<string, Json>);
  if (entries.length === 0) return null;
  return `- ${member.name} speaks like this (owner's note): ${JSON.stringify(member.voice)}`;
}

/** The cast section of the system prompt. Pure: the same cast always renders the same text. */
export function renderCastBible(cast: readonly CastMember[]): string {
  const lines: string[] = ['## THE CAST (recurring characters)', ''];
  if (cast.length === 0) {
    lines.push(
      'No recurring characters have been supplied. Do not invent named recurring characters; use unnamed roles (the teacher, a trader, a neighbour) and "you".',
    );
    return lines.join('\n');
  }

  lines.push('### Facts supplied by the owner');
  lines.push('Only these are facts about the characters. Nothing else is known.');
  for (const member of cast) lines.push(factsLine(member));
  const related = cast.filter((m) => m.traits.relationship_note && m.traits.relationship_note.trim() !== '');
  if (related.length === 0) {
    lines.push('- Relationships between the characters: none supplied.');
  } else {
    for (const member of related) {
      lines.push(`- ${member.name}, relationship (owner's note): ${member.traits.relationship_note!.trim()}`);
    }
  }
  const voices = cast.map(voiceLine).filter((line): line is string => line !== null);
  lines.push(...voices);

  lines.push('');
  lines.push('### Guidance derived from age only');
  lines.push(
    'This guidance is derived from each character\'s age. It is NOT a fact supplied by the owner, it says nothing about the character\'s personality, and the owner may adjust it. Use it only to pitch how the character speaks and what the character can do in a scene.',
  );
  for (const member of cast) {
    const guidance = member.traits.derived_guidance?.trim();
    lines.push(`- ${member.name}: ${guidance && guidance !== '' ? guidance : 'none supplied.'}`);
  }

  const names = cast.map((m) => m.name);
  const pair = names.length >= 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? 'the characters');
  lines.push('');
  lines.push('### Rules for the cast');
  lines.push(
    `1. Do not invent any other trait, backstory or relationship. Never use a character fact that is not listed above under "Facts supplied by the owner".`,
  );
  lines.push(
    `2. Never state how ${pair} are related: no sibling, cousin, friend, classmate, neighbour or twin relationship, no shared parent, shared home or shared school, unless a relationship note above says so. They may appear in the same scene, speak, ask and answer; what they say must come from the lesson.`,
  );
  lines.push(
    '3. Do not give a character a pet, a favourite food, a hobby, a fear, a family member or a personality. If a story needs another person, use an unnamed role (the teacher, a trader, a neighbour, a grown-up).',
  );
  lines.push(
    '4. Pitch each character\'s lines to the age. Never let the younger character know or do what a child of that age could not.',
  );
  lines.push(
    '5. The worked example at the end of this prompt comes from the template. Take its shape and voice only: its scene-setting about where the characters live or go to school is storytelling, not a fact you may repeat.',
  );
  return lines.join('\n');
}
