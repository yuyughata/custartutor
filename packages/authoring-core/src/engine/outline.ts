// Turns the model's outline reply into the outline the rest of the job relies on. The model chooses; this code
// guarantees the lint rules by construction: all six always-present sections, 2 to 5 distinct enrichment
// sections, rotation away from the previous unit, every scheme subtopic assigned to a concept, the mastery check
// last, ids assigned by code, and a session plan of exactly the planned number of one-hour periods.
import type { SectionType } from '@custar/content-schema';
import type { UnitGenerateInput } from '../contract';
import type { OutlineOutput } from '../prompts/schemas';
import {
  DEFAULT_HEADINGS,
  ENRICHMENT_PRIORITY,
  SECTION_ORDER,
  conceptId,
  type EnrichmentType,
  type OutlinePeriod,
  type OutlineSection,
  type StoredOutline,
} from './sections';
import { clean, cleanAll, unique } from './util';

export const MAX_CONCEPTS = 4;
export const ENRICHMENT_MIN_COUNT = 2;
export const ENRICHMENT_MAX_COUNT = 5;

/** The minutes of the one-hour shape: Start, Teach, Move & Do, Practice, Close. */
export const DEFAULT_MINUTES = [
  { segment: 'start', minutes: 10 },
  { segment: 'teach', minutes: 15 },
  { segment: 'move_and_do', minutes: 15 },
  { segment: 'practice', minutes: 10 },
  { segment: 'close', minutes: 10 },
] as const;

/** When swapping an enrichment type in, try these first. A Window to the World gives the unit its global window. */
const SWAP_IN_ORDER: readonly EnrichmentType[] = [
  'window_to_world',
  'across_subjects',
  'story_opener',
  'do_and_discover',
  'tell_it_back',
  'character_values',
  'remember',
];

const WEIGHT: Record<string, number> = {
  story_opener: 6,
  remember: 4,
  concept: 8,
  worked_examples: 8,
  across_subjects: 5,
  window_to_world: 5,
  do_and_discover: 12,
  character_values: 5,
  tell_it_back: 5,
  practice: 10,
  think_deeper: 4,
  quick_fire: 3,
  mastery_check: 6,
};

function sameSet<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

export function chooseEnrichment(
  requested: readonly EnrichmentType[],
  previous: readonly string[],
  hasPriorUnits: boolean,
  notes: string[],
): EnrichmentType[] {
  const allowed = (type: EnrichmentType) => hasPriorUnits || type !== 'remember';
  const rank = (type: EnrichmentType) => ENRICHMENT_PRIORITY.indexOf(type);
  let chosen = unique(requested);

  if (!hasPriorUnits && chosen.includes('remember')) {
    chosen = chosen.filter((type) => type !== 'remember');
    notes.push('Remember? was left out: this unit has no earlier unit to call back to.');
  }
  if (chosen.length > ENRICHMENT_MAX_COUNT) {
    chosen = [...chosen].sort((a, b) => rank(a) - rank(b)).slice(0, ENRICHMENT_MAX_COUNT);
    notes.push(`More than ${ENRICHMENT_MAX_COUNT} enrichment sections were proposed; kept the ${ENRICHMENT_MAX_COUNT} the template values most.`);
  }
  if (chosen.length < ENRICHMENT_MIN_COUNT) {
    const before = chosen.length;
    for (const type of ENRICHMENT_PRIORITY) {
      if (chosen.length >= ENRICHMENT_MIN_COUNT) break;
      if (!chosen.includes(type) && allowed(type)) chosen.push(type);
    }
    notes.push(`Only ${before} enrichment section(s) were proposed; added ${chosen.slice(before).join(', ')} to reach ${ENRICHMENT_MIN_COUNT}.`);
  }

  const previousSet = unique(previous).filter((type): type is EnrichmentType =>
    (ENRICHMENT_PRIORITY as readonly string[]).includes(type),
  );
  if (previousSet.length > 0 && sameSet(chosen, previousSet)) {
    const candidate = SWAP_IN_ORDER.find((type) => !chosen.includes(type) && allowed(type));
    const leastValued = [...chosen].sort((a, b) => rank(b) - rank(a))[0];
    if (candidate && leastValued) {
      chosen = chosen.map((type) => (type === leastValued ? candidate : type));
      notes.push(`The enrichment set matched the previous unit, so ${leastValued} was swapped for ${candidate} to vary the rotation.`);
    } else if (chosen.length > ENRICHMENT_MIN_COUNT && leastValued) {
      chosen = chosen.filter((type) => type !== leastValued);
      notes.push(`The enrichment set matched the previous unit, so ${leastValued} was dropped to vary the rotation.`);
    }
  }
  return chosen;
}

function sanitiseCovers(covers: readonly number[], max: number): number[] {
  return unique(covers.map((n) => Math.round(n)).filter((n) => n >= 1 && n <= max)).sort((a, b) => a - b);
}

function weightedSplit(ids: readonly string[], periods: number, weightOf: (id: string) => number): string[][] {
  const weights = ids.map(weightOf);
  const total = weights.reduce((sum, w) => sum + w, 0);
  const groups: string[][] = [];
  let index = 0;
  let accumulated = 0;
  for (let g = 0; g < periods; g += 1) {
    const group: string[] = [];
    const isLast = g === periods - 1;
    const target = (total * (g + 1)) / periods;
    const leaveForLater = periods - g - 1;
    while (index < ids.length) {
      const weight = weights[index] ?? 0;
      const mustTake = group.length === 0;
      const canTake = ids.length - index > leaveForLater;
      if (!mustTake && !isLast && !(canTake && accumulated + weight / 2 <= target)) break;
      group.push(ids[index]!);
      accumulated += weight;
      index += 1;
    }
    groups.push(group);
  }
  return groups;
}

function validMinutes(raw: OutlineOutput['periods'][number]): OutlinePeriod['minutes'] | null {
  const values = [raw.start, raw.teach, raw.move_and_do, raw.practice, raw.close].map((n) => Math.round(n));
  if (values.some((n) => !Number.isFinite(n) || n < 1 || n > 60)) return null;
  const total = values.reduce((sum, n) => sum + n, 0);
  if (total < 50 || total > 70) return null;
  return DEFAULT_MINUTES.map((entry, index) => ({ segment: entry.segment, minutes: values[index]! }));
}

/** Normalises the model's outline. Never throws: every problem has a deterministic repair, noted for the reviewer. */
export function normalizeOutline(raw: OutlineOutput, input: UnitGenerateInput): StoredOutline {
  const notes: string[] = [];
  const subtopicCount = input.scheme_week?.subtopics.length ?? 0;
  const hasPriorUnits = input.prior_units.length > 0;

  // --- enrichment ---
  const requested = raw.enrichment.map((entry) => entry.type);
  const enrichment = chooseEnrichment(requested, input.previous_enrichment, hasPriorUnits, notes);
  const enrichmentPlan = new Map<EnrichmentType, { heading: string; plan: string }>();
  for (const entry of raw.enrichment) {
    if (!enrichmentPlan.has(entry.type)) {
      enrichmentPlan.set(entry.type, { heading: clean(entry.heading), plan: clean(entry.plan) });
    }
  }

  // --- concepts ---
  let concepts = raw.concepts.map((concept) => ({
    heading: clean(concept.heading),
    plan: clean(concept.plan),
    covers: sanitiseCovers(concept.covers, subtopicCount),
  }));
  if (concepts.length === 0) {
    concepts = [{ heading: clean(input.unit.title), plan: '', covers: [] }];
    notes.push('The outline had no concept section; one was created from the unit title.');
  }
  if (concepts.length > MAX_CONCEPTS) {
    const head = concepts.slice(0, MAX_CONCEPTS - 1);
    const tail = concepts.slice(MAX_CONCEPTS - 1);
    concepts = [
      ...head,
      {
        heading: tail[0]!.heading,
        plan: cleanAll(tail.map((c) => c.plan)).join(' '),
        covers: unique(tail.flatMap((c) => c.covers)).sort((a, b) => a - b),
      },
    ];
    notes.push(`More than ${MAX_CONCEPTS} concept sections were proposed; the extra ones were merged into the last.`);
  }
  if (subtopicCount > 0) {
    const covered = new Set(concepts.flatMap((c) => c.covers));
    const missing = Array.from({ length: subtopicCount }, (_, i) => i + 1).filter((n) => !covered.has(n));
    if (missing.length > 0) {
      const last = concepts[concepts.length - 1]!;
      last.covers = [...last.covers, ...missing].sort((a, b) => a - b);
      notes.push(`Scheme subtopic(s) ${missing.join(', ')} were not assigned to a concept; added to "${last.heading || 'the last concept'}".`);
    }
  }

  // --- sections in unit order ---
  const sections: OutlineSection[] = [];
  const plan = (type: SectionType, value: { heading: string; plan: string }): OutlineSection => ({
    id: type,
    type,
    heading: clean(value.heading) || DEFAULT_HEADINGS[type] || type,
    plan: clean(value.plan),
    covers: [],
  });
  for (const type of SECTION_ORDER) {
    if (type === 'concept') {
      concepts.forEach((concept, index) => {
        sections.push({
          id: conceptId(index + 1),
          type: 'concept',
          heading: concept.heading || `${DEFAULT_HEADINGS['concept']}${concepts.length > 1 ? ` (${index + 1})` : ''}`,
          plan: concept.plan,
          covers: concept.covers,
        });
      });
    } else if (type === 'worked_examples') {
      sections.push(plan(type, raw.worked_examples));
    } else if (type === 'practice') {
      sections.push(plan(type, raw.practice));
    } else if (type === 'think_deeper') {
      sections.push(plan(type, raw.think_deeper));
    } else if (type === 'quick_fire') {
      sections.push(plan(type, raw.quick_fire));
    } else if (type === 'mastery_check') {
      sections.push(plan(type, raw.mastery_check));
    } else if (enrichment.includes(type as EnrichmentType)) {
      sections.push(plan(type, enrichmentPlan.get(type as EnrichmentType) ?? { heading: '', plan: '' }));
    }
  }

  // --- periods ---
  const ids = sections.map((section) => section.id);
  const wanted = Math.max(1, Math.min(input.unit.periods, ids.length));
  const indexOf = (id: string) => ids.indexOf(id);
  const seen = new Set<string>();
  const modelPeriods = raw.periods.map((period) => ({
    sections: cleanAll(period.sections).filter((id) => {
      if (indexOf(id) === -1 || seen.has(id)) return false;
      seen.add(id);
      return true;
    }),
    minutes: validMinutes(period),
  }));
  let groups: string[][] | null = null;
  const nonEmpty = modelPeriods.filter((period) => period.sections.length > 0);
  if (nonEmpty.length === wanted && raw.periods.length === wanted) {
    const grouped = nonEmpty.map((period) => [...period.sections]);
    for (const id of ids) {
      if (grouped.some((group) => group.includes(id))) continue;
      // a section the model forgot goes where the section before it in unit order went
      const before = ids.slice(0, indexOf(id)).reverse().find((other) => grouped.some((g) => g.includes(other)));
      const target = before ? grouped.find((g) => g.includes(before)) : grouped[0];
      (target ?? grouped[0]!).push(id);
      notes.push(`The session plan left out ${id}; it was added to the period of the section before it.`);
    }
    groups = grouped;
  }
  if (!groups) {
    groups = weightedSplit(ids, wanted, (id) => WEIGHT[sections[indexOf(id)]!.type] ?? 5);
    notes.push(`The session plan did not match the ${wanted} planned period(s); the sections were split across periods by size.`);
  }
  // the mastery check closes the unit
  const mastery = 'mastery_check';
  const lastGroup = groups[groups.length - 1]!;
  if (!lastGroup.includes(mastery)) {
    groups = groups.map((group) => group.filter((id) => id !== mastery));
    lastGroup.push(mastery);
    groups[groups.length - 1] = lastGroup;
    notes.push('The mastery check was moved to the last period.');
    if (groups.some((group) => group.length === 0)) {
      groups = weightedSplit(ids, wanted, (id) => WEIGHT[sections[indexOf(id)]!.type] ?? 5);
    }
  }
  const periods: OutlinePeriod[] = groups.map((group, index) => ({
    period: index + 1,
    sections: [...group].sort((a, b) => indexOf(a) - indexOf(b)),
    minutes: (modelPeriods[index]?.minutes ?? DEFAULT_MINUTES.map((entry) => ({ ...entry }))).map((m) => ({ ...m })),
  }));

  return {
    sections,
    periods,
    enrichment: sections
      .map((section) => section.type)
      .filter((type) => enrichment.includes(type as EnrichmentType)),
    notes,
  };
}

/** Invariants the later steps depend on. Returns problems; empty means the outline is sound. */
export function validateOutline(outline: StoredOutline): string[] {
  const problems: string[] = [];
  const types = outline.sections.map((s) => s.type);
  for (const required of ['concept', 'worked_examples', 'practice', 'think_deeper', 'quick_fire', 'mastery_check'] as const) {
    if (!types.includes(required)) problems.push(`missing ${required} section`);
  }
  const enrichment = outline.enrichment;
  if (enrichment.length < ENRICHMENT_MIN_COUNT || enrichment.length > ENRICHMENT_MAX_COUNT) {
    problems.push(`${enrichment.length} enrichment sections`);
  }
  if (unique(enrichment).length !== enrichment.length) problems.push('duplicate enrichment type');
  if (types[types.length - 1] !== 'mastery_check') problems.push('mastery_check is not last');
  const ids = outline.sections.map((s) => s.id);
  if (unique(ids).length !== ids.length) problems.push('duplicate section id');
  const planned = outline.periods.flatMap((p) => p.sections);
  if (planned.length !== ids.length || ids.some((id) => !planned.includes(id))) {
    problems.push('the session plan does not place every section exactly once');
  }
  return problems;
}
