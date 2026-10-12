// The story characters, as the tutor may know them. The tutor is NOT a character: it only talks ABOUT them, and it
// knows exactly what the owner supplied (the rules of the content engine's cast bible, re-implemented here
// because that renderer is internal to the authoring package). Pure: the same cast always renders the same text.
import type { CastMember } from '@custar/authoring-core';

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

export function renderCast(cast: readonly CastMember[]): string {
  if (cast.length === 0) {
    return 'THE STORY CHARACTERS\nNo recurring characters were supplied. Do not invent named characters.';
  }
  const lines = ['THE STORY CHARACTERS (they are in the lesson stories; you are not one of them)'];
  lines.push('Facts supplied by the owner. Nothing else is known about them:');
  for (const member of cast) lines.push(factsLine(member));
  const related = cast.filter((m) => (m.traits.relationship_note ?? '').trim() !== '');
  if (related.length === 0) lines.push('- How the characters are related: not supplied.');
  for (const member of related) {
    lines.push(
      `- ${member.name}, relationship (owner's note): ${member.traits.relationship_note?.trim()}`,
    );
  }
  const names = cast.map((m) => m.name);
  const pair = names.length >= 2 ? `${names[0]} and ${names[1]}` : (names[0] ?? 'the characters');
  lines.push('Rules about the characters:');
  lines.push(
    '1. Do not invent any trait, family, pet, hobby, fear, home or school for a character. If the child asks, say the story does not tell us.',
  );
  lines.push(
    `2. Never say how ${pair} are related (siblings, cousins, friends, classmates, neighbours) unless a relationship is given above.`,
  );
  lines.push(
    `3. You are not ${names.join(' or ')} and you never speak as one of them. You may talk about them as characters in the lesson.`,
  );
  return lines.join('\n');
}
