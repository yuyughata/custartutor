// Advisory review flags. Two sources, both advisory (they never block, never fix, never approve):
//   - Claude's own review (one model call, mapped here to `Flag`s);
//   - deterministic guards the code can run for free: invented relationships between cast members, sections that
//     lack a tutor script, and the notes the outline step recorded when it adjusted the model's plan.
import { sectionsOf, type SectionType, type UnitContent } from '@custar/content-schema';
import type { CastMember, Flag } from '../contract';
import { renderUnit } from '../prompts/render';
import type { ReviewOutput } from '../prompts/schemas';
import { clean } from './util';

export const MAX_REVIEW_FLAGS = 12;

const RELATION_WORDS =
  /\b(siblings?|brothers?|sisters?|cousins?|twins?|classmates?|schoolmates?|friends?|neighbou?rs?|mother|father|mama|mummy|mum|daddy|dad|parents?|aunt(?:y|ie)?|uncle|grand(?:mother|father|ma|pa|mum|dad|parent|parents))\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Flags any sentence that names a cast member AND uses a family or friendship word. The owner has not said how
 * the characters are related, so such a sentence is an invented fact until a relationship note says otherwise.
 * Skipped entirely when any cast member has a relationship note.
 */
export function castGuard(unit: UnitContent, cast: readonly CastMember[]): Flag[] {
  if (cast.length === 0) return [];
  if (cast.some((member) => (member.traits.relationship_note ?? '').trim() !== '')) return [];
  const names = cast.map((member) => new RegExp(`\\b${escapeRegExp(member.name)}\\b`, 'i'));
  const sections = sectionsOf(unit);
  const flags: Flag[] = [];
  let currentId = '';
  for (const line of renderUnit(unit).split('\n')) {
    const heading = /^### ([a-z][a-z0-9_]*) \(/.exec(line);
    if (heading) currentId = heading[1]!;
    for (const sentence of line.split(/(?<=[.!?”"])\s+/)) {
      if (!names.some((name) => name.test(sentence)) || !RELATION_WORDS.test(sentence)) continue;
      const index = sections.findIndex((section) => section.id === currentId);
      flags.push({
        code: 'cast',
        severity: 'concern',
        message: `A sentence names a character and uses a family or friendship word, but the owner has not said how the characters are related: "${clean(sentence).slice(0, 160)}"`,
        ...(index >= 0 ? { path: `sections[${index}]` } : {}),
      });
    }
  }
  return flags;
}

/** Section types where a tutor script is expected (not required): the tutor leads the child through them. */
export const TUTOR_EXPECTED: ReadonlySet<SectionType> = new Set<SectionType>([
  'story_opener',
  'remember',
  'concept',
  'character_values',
]);

export function tutorGuard(unit: UnitContent): Flag[] {
  const flags: Flag[] = [];
  sectionsOf(unit).forEach((section, index) => {
    if (TUTOR_EXPECTED.has(section.type) && (section.tutor_script?.nodes.length ?? 0) === 0) {
      flags.push({
        code: 'other',
        severity: 'note',
        message: `Section "${section.heading}" (${section.id}) has no tutor script, so the offline tutor has nothing to say there.`,
        path: `sections[${index}]`,
      });
    }
  });
  return flags;
}

/** Maps the model's review reply to flags. Unknown section ids become whole-unit flags. */
export function reviewToFlags(output: ReviewOutput, unit: UnitContent): Flag[] {
  const index = new Map(sectionsOf(unit).map((section, i) => [section.id, i]));
  return output.flags
    .slice(0, MAX_REVIEW_FLAGS)
    .map((flag) => ({
      code: flag.code,
      severity: flag.severity,
      message: clean(flag.message),
      sectionIndex: index.get(clean(flag.section_id)),
    }))
    .filter((flag) => flag.message !== '')
    .map(({ sectionIndex, ...flag }) => ({
      ...flag,
      ...(sectionIndex !== undefined ? { path: `sections[${sectionIndex}]` } : {}),
    }));
}

/** Concerns first, then notes; otherwise the order is kept. */
export function sortFlags(flags: readonly Flag[]): Flag[] {
  const concerns = flags.filter((flag) => flag.severity === 'concern');
  const notes = flags.filter((flag) => flag.severity !== 'concern');
  return [...concerns, ...notes];
}
