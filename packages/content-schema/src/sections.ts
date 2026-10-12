import { z } from 'zod';
import { AnyBlock } from './blocks';
import { AssetId, Id, Lang, Layer, Text } from './common';
import { TutorScript } from './tutor-script';

/** The thirteen section types of a lesson (brief section 7). `concept` may repeat. */
export const LESSON_SECTION_TYPES = [
  'story_opener',
  'concept',
  'worked_examples',
  'across_subjects',
  'window_to_world',
  'practice',
  'do_and_discover',
  'tell_it_back',
  'remember',
  'think_deeper',
  'quick_fire',
  'character_values',
  'mastery_check',
] as const;

/** Section types used by the other unit kinds. */
export const OTHER_SECTION_TYPES = ['revision_topic', 'assessment_part', 'project_part'] as const;

export const SectionType = z.enum([...LESSON_SECTION_TYPES, ...OTHER_SECTION_TYPES]);
export type SectionType = z.infer<typeof SectionType>;
export type LessonSectionType = (typeof LESSON_SECTION_TYPES)[number];

/** Always present in a lesson (brief section 7). */
export const ALWAYS_PRESENT_TYPES = [
  'concept',
  'worked_examples',
  'practice',
  'think_deeper',
  'quick_fire',
  'mastery_check',
] as const satisfies readonly SectionType[];

/**
 * The enrichment menu (brief section 7). A lesson uses two to five of these, each type at most once: the brief
 * says two or three, the unit template carries five, and the template wins (ADR 0006).
 */
export const ENRICHMENT_MENU = [
  'story_opener',
  'across_subjects',
  'window_to_world',
  'do_and_discover',
  'tell_it_back',
  'remember',
  'character_values',
] as const satisfies readonly SectionType[];

/** The default layer tag of each section type (brief section 7). Think Deeper is CORE+. */
export const LAYER_FOR_TYPE: Record<SectionType, Layer> = {
  story_opener: 'ENRICH',
  concept: 'CORE',
  worked_examples: 'CORE',
  across_subjects: 'ENRICH',
  window_to_world: 'ENRICH',
  practice: 'CORE',
  do_and_discover: 'ENRICH',
  tell_it_back: 'ENRICH',
  remember: 'ENRICH',
  think_deeper: 'CORE+',
  quick_fire: 'CORE',
  character_values: 'ENRICH',
  mastery_check: 'CORE',
  revision_topic: 'CORE',
  assessment_part: 'CORE',
  project_part: 'CORE',
};

export function isEnrichmentType(type: SectionType): boolean {
  return (ENRICHMENT_MENU as readonly string[]).includes(type);
}

export const Section = z.object({
  id: Id,
  type: SectionType,
  layer: Layer,
  heading: Text,
  lang: Lang.optional(),
  blocks: z.array(AnyBlock).min(1),
  /** Offline tutor dialogue for this section. */
  tutor_script: TutorScript.optional(),
  /** Narration audio assets for this section, in reading order. */
  audio_refs: z.array(AssetId).optional(),
});
export type Section = z.infer<typeof Section>;
