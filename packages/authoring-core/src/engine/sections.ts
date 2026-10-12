// Section ids, the canonical section order and the stored outline. Ids are assigned by CODE, never by the model:
// `concept_1`, `concept_2`, ... for concept sections, the type name for every other section, and
// `q_<section>_<n>` for the questions a section owns, so re-running a step gives the same ids.
import { z } from 'zod';
import {
  ENRICHMENT_MENU,
  Id,
  LAYER_FOR_TYPE,
  SESSION_SEGMENTS,
  SectionType,
  type Layer,
} from '@custar/content-schema';

export type EnrichmentType = (typeof ENRICHMENT_MENU)[number];

/** The unit template's order (golden Unit 2). Concept sections keep the order the outline gives them. */
export const SECTION_ORDER: readonly SectionType[] = [
  'story_opener',
  'remember',
  'concept',
  'worked_examples',
  'across_subjects',
  'window_to_world',
  'do_and_discover',
  'character_values',
  'tell_it_back',
  'practice',
  'think_deeper',
  'quick_fire',
  'mastery_check',
];

export function orderOf(type: SectionType): number {
  const index = SECTION_ORDER.indexOf(type);
  return index === -1 ? SECTION_ORDER.length : index;
}

/** The template's five enrichment sections: the default for a Primary 1 lesson. */
export const TEMPLATE_ENRICHMENT: readonly EnrichmentType[] = [
  'story_opener',
  'remember',
  'do_and_discover',
  'character_values',
  'tell_it_back',
];

/** Which enrichment type to keep first when a set has to be trimmed or topped up. */
export const ENRICHMENT_PRIORITY: readonly EnrichmentType[] = [
  'story_opener',
  'do_and_discover',
  'tell_it_back',
  'character_values',
  'remember',
  'window_to_world',
  'across_subjects',
];

/** Headings used when the outline leaves one empty. They follow the golden unit. */
export const DEFAULT_HEADINGS: Record<string, string> = {
  story_opener: 'Come and Explore! (Our Story)',
  remember: 'Remember?',
  concept: 'What We Learn',
  worked_examples: "Let's Look Together (Examples)",
  across_subjects: 'Across Subjects',
  window_to_world: 'Window to the World',
  do_and_discover: 'Do & Discover',
  character_values: 'Our Good Habits',
  tell_it_back: 'Tell It Back & My Notebook',
  practice: 'Practice Time (Workbook Tiers 1 to 3)',
  think_deeper: 'Think Deeper',
  quick_fire: 'Quick-Fire! (Answer Fast)',
  mastery_check: 'Have I Got It? (Mastery Check)',
  revision_topic: 'Revision',
  assessment_part: 'Assessment',
};

export function conceptId(n: number): string {
  return `concept_${n}`;
}

/** `q_<section>_<n>`: the id of the n-th (1-based) question a section owns. */
export function questionId(sectionId: string, n: number): string {
  return `q_${sectionId}_${n}`;
}

export function layerFor(type: SectionType): Layer {
  return LAYER_FOR_TYPE[type];
}

// ---------------------------------------------------------------------------------------------
// The stored outline (validated and normalised by engine/outline.ts)
// ---------------------------------------------------------------------------------------------

export const OutlineSectionSchema = z.object({
  id: Id,
  type: SectionType,
  heading: z.string().min(1),
  /** One or two sentences from the outline: what this section does in this unit. */
  plan: z.string(),
  /** 1-based numbers of the scheme subtopics a concept section teaches. Empty for other types. */
  covers: z.array(z.number()),
});
export type OutlineSection = z.infer<typeof OutlineSectionSchema>;

export const OutlinePeriodSchema = z.object({
  period: z.number(),
  sections: z.array(Id).min(1),
  minutes: z.array(z.object({ segment: z.enum(SESSION_SEGMENTS), minutes: z.number() })).min(1),
});
export type OutlinePeriod = z.infer<typeof OutlinePeriodSchema>;

export const StoredOutlineSchema = z.object({
  sections: z.array(OutlineSectionSchema).min(1),
  periods: z.array(OutlinePeriodSchema).min(1),
  enrichment: z.array(SectionType),
  /** Deterministic adjustments the code made to the model's outline, shown to the reviewer. */
  notes: z.array(z.string()),
});
export type StoredOutline = z.infer<typeof StoredOutlineSchema>;

export function sectionStepName(sectionId: string): string {
  return `section:${sectionId}`;
}

export function sectionIdOfStep(step: string): string | null {
  return step.startsWith('section:') ? step.slice('section:'.length) : null;
}
