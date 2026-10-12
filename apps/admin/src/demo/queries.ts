// Read helpers over the demo state. They mirror what the server's JobInputResolver reads from the database.
import type { Json } from '@custar/authoring-core';
import { ENRICHMENT_MENU, type SectionType } from '@custar/content-schema';
import type { UnitVersionFull } from '../api/types';
import type { DemoChapter, DemoScheme, DemoState, DemoUnit } from './state';

export function schemeOf(state: DemoState, chapter: DemoChapter): DemoScheme {
  const scheme = state.schemes.find((candidate) => candidate.id === chapter.scheme_id);
  if (!scheme) throw new Error(`demo: scheme ${chapter.scheme_id} is missing`);
  return scheme;
}

export function chapterOf(state: DemoState, unit: DemoUnit): DemoChapter {
  const chapter = state.chapters.find((candidate) => candidate.id === unit.chapter_id);
  if (!chapter) throw new Error(`demo: chapter ${unit.chapter_id} is missing`);
  return chapter;
}

export function versionsOf(state: DemoState, unitId: string): UnitVersionFull[] {
  return state.versions.filter((version) => version.unit_id === unitId).sort((a, b) => b.version - a.version);
}

export function latestVersionOf(state: DemoState, unitId: string): UnitVersionFull | undefined {
  return versionsOf(state, unitId)[0];
}

/** All units of a subject and level, in teaching order (term, then unit number). */
export function unitsInOrder(state: DemoState, subjectId: string, levelCode: string): DemoUnit[] {
  return state.units
    .map((unit) => ({ unit, chapter: chapterOf(state, unit) }))
    .map(({ unit, chapter }) => ({ unit, scheme: schemeOf(state, chapter) }))
    .filter(({ scheme }) => scheme.subject_id === subjectId && scheme.level_code === levelCode)
    .sort((a, b) => a.scheme.term - b.scheme.term || a.unit.unit_no - b.unit.unit_no)
    .map(({ unit }) => unit);
}

export function previousUnit(state: DemoState, unit: DemoUnit): DemoUnit | undefined {
  const scheme = schemeOf(state, chapterOf(state, unit));
  const ordered = unitsInOrder(state, scheme.subject_id, scheme.level_code);
  const index = ordered.findIndex((candidate) => candidate.id === unit.id);
  return index > 0 ? ordered[index - 1] : undefined;
}

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sectionList(content: Json): Rec[] {
  return isRec(content) && Array.isArray(content.sections)
    ? (content.sections as unknown[]).filter(isRec)
    : [];
}

/** The enrichment section types a unit version uses (for the rotation rule). */
export function enrichmentTypes(content: Json): SectionType[] {
  const used: SectionType[] = [];
  for (const section of sectionList(content)) {
    const type = section.type;
    if (typeof type === 'string' && (ENRICHMENT_MENU as readonly string[]).includes(type)) {
      used.push(type as SectionType);
    }
  }
  return used;
}

/** Defined terms in a unit version, for the "Remember?" section of later units. */
export function keyTerms(content: Json): string[] {
  const terms: string[] = [];
  for (const section of sectionList(content)) {
    if (!Array.isArray(section.blocks)) continue;
    for (const block of section.blocks) {
      if (isRec(block) && block.type === 'definition' && typeof block.term === 'string') {
        terms.push(block.term);
      }
    }
  }
  return terms;
}
