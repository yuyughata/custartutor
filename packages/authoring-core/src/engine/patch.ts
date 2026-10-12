// ID-addressed patches for unit_revise, and the section/question diff of two versions.
//
// The model never regenerates a unit. It returns a patch: replacement sections and questions keyed by EXISTING
// ids (new ids only for new items), and small workbook and manual edits. `applyUnitPatch` applies it
// deterministically to a copy of the base unit; anything the patch does not mention is untouched. Ids are
// permanent (README of content-schema): a patch cannot delete anything, and `restoreDroppedIds` puts back
// anything a faulty patch application removed.
import {
  Id,
  isEnrichmentType,
  sectionsOf,
  type AnyBlock,
  type Block,
  type Question,
  type Section,
  type SectionType,
  type UnitContent,
} from '@custar/content-schema';
import { ENRICHMENT_MENU } from '@custar/content-schema';
import type { Json } from '../contract';
import type { PatchOutput } from '../prompts/schemas';
import { answersNote, timingTextFrom } from './assemble';
import {
  blockToAuthor,
  isAuthorable,
  mapBlocks,
  mapQuestion,
  mapTutorScript,
  ownerOfQuestion,
  placeUnplacedQuestions,
  placedQuestionIds,
  questionToAuthor,
  tutorToAuthor,
} from './mapping';
import { orderOf, layerFor, questionId } from './sections';
import {
  clean,
  cleanAll,
  clone,
  isRecord,
  sameJson,
  stableStringify,
  toJson,
  unique,
} from './util';

type Rec = Record<string, unknown>;

// ---------------------------------------------------------------------------------------------
// The diff
// ---------------------------------------------------------------------------------------------

export interface UnitDiff {
  /** Sections that are new or whose heading, blocks, tutor script, type, layer or language changed. */
  section_ids: string[];
  /** Questions that are new or changed. */
  question_ids: string[];
  removed_section_ids: string[];
  removed_question_ids: string[];
  workbook_changed: boolean;
  manual_changed: boolean;
  session_plan_changed: boolean;
  header_changed: boolean;
}

function sectionList(unit: unknown): Rec[] {
  return isRecord(unit) && Array.isArray(unit['sections']) ? (unit['sections'] as Rec[]) : [];
}

function questionMap(unit: unknown): Record<string, unknown> {
  return isRecord(unit) && isRecord(unit['questions']) ? unit['questions'] : {};
}

/** Which sections and questions differ between two versions of a unit (parsed or raw JSON). Pure. */
export function diffUnits(a: UnitContent | Json, b: UnitContent | Json): UnitDiff {
  const before = new Map(sectionList(a).map((section) => [String(section['id']), section]));
  const afterSections = sectionList(b);
  const sectionIds: string[] = [];
  for (const section of afterSections) {
    const id = String(section['id']);
    const old = before.get(id);
    if (!old || !sameJson(old, section)) sectionIds.push(id);
  }
  const afterIds = new Set(afterSections.map((section) => String(section['id'])));
  const removedSections = [...before.keys()].filter((id) => !afterIds.has(id));

  const oldQuestions = questionMap(a);
  const newQuestions = questionMap(b);
  const questionIds = Object.keys(newQuestions).filter(
    (id) => !(id in oldQuestions) || !sameJson(oldQuestions[id], newQuestions[id]),
  );
  const removedQuestions = Object.keys(oldQuestions).filter((id) => !(id in newQuestions));

  const field = (unit: unknown, key: string): unknown => (isRecord(unit) ? unit[key] : undefined);
  return {
    section_ids: sectionIds,
    question_ids: questionIds,
    removed_section_ids: removedSections,
    removed_question_ids: removedQuestions,
    workbook_changed: !sameJson(field(a, 'workbook'), field(b, 'workbook')),
    manual_changed: !sameJson(field(a, 'teacher_manual'), field(b, 'teacher_manual')),
    session_plan_changed: !sameJson(field(a, 'session_plan'), field(b, 'session_plan')),
    header_changed: !sameJson(field(a, 'header'), field(b, 'header')),
  };
}

// ---------------------------------------------------------------------------------------------
// Restoring dropped ids
// ---------------------------------------------------------------------------------------------

/**
 * The stable-ID rule as a repair: every section and question id of `base` that is missing from `next` is put
 * back (a section at its old position). Returns the repaired candidate and a note per restored id. Pure.
 */
export function restoreDroppedIds(
  base: UnitContent | Json,
  next: Json,
): { content: Json; notes: string[] } {
  const notes: string[] = [];
  const candidate = clone(next) as Rec;
  const sections = sectionList(candidate);
  const have = new Set(sections.map((section) => String(section['id'])));
  const oldSections = sectionList(base);
  oldSections.forEach((section, index) => {
    const id = String(section['id']);
    if (have.has(id)) return;
    const insertAt = Math.min(index, sections.length);
    sections.splice(insertAt, 0, clone(section));
    have.add(id);
    notes.push(
      `Section ${id} was missing after the change and was restored from the previous version.`,
    );
  });
  if (sectionList(candidate).length !== sections.length || !Array.isArray(candidate['sections'])) {
    candidate['sections'] = sections;
  }
  const current = isRecord(candidate['questions'])
    ? (candidate['questions'] as Record<string, unknown>)
    : {};
  const baseQuestions = questionMap(base);
  const merged: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(baseQuestions)) {
    if (id in current) {
      merged[id] = current[id];
    } else {
      merged[id] = clone(question);
      notes.push(
        `Question ${id} was missing after the change and was restored from the previous version.`,
      );
    }
  }
  for (const [id, question] of Object.entries(current)) if (!(id in merged)) merged[id] = question;
  if (Object.keys(merged).length > 0) candidate['questions'] = merged;
  return { content: toJson(candidate), notes };
}

// ---------------------------------------------------------------------------------------------
// The authoring view of a base unit (what the patch prompt shows the model)
// ---------------------------------------------------------------------------------------------

export function buildPatchBaseView(unit: UnitContent): {
  base: unknown;
  sections: { id: string; type: string; heading: string; question_ids: string[] }[];
  locked_question_ids: string[];
  enrichment_used: string[];
} {
  const sections = sectionsOf(unit);
  const questions: Record<string, Question> =
    'questions' in unit && unit.questions ? unit.questions : {};
  const locked: string[] = [];
  const authored = Object.values(questions).flatMap((question) => {
    const view = questionToAuthor(question);
    if (!view) {
      locked.push(question.id);
      return [];
    }
    return [{ owner: ownerOfQuestion(sections, question.id) ?? 'workbook', question: view }];
  });
  const base: Rec = {
    header: {
      title: unit.header.title,
      objective: unit.header.objective,
      stage: unit.header.stage,
      stage_to: unit.header.stage_to ?? null,
    },
    sections: sections.map((section) => ({
      id: section.id,
      type: section.type,
      heading: section.heading,
      blocks: section.blocks.map(blockToAuthor),
      tutor_script: tutorToAuthor(section.tutor_script),
    })),
    questions: authored,
  };
  if (unit.kind === 'lesson') {
    const wb = unit.workbook;
    base['workbook'] = {
      tier_titles: wb.tiers.map((tier) => ({
        tier: tier.tier,
        title: tier.title,
        question_ids: tier.question_ids,
      })),
      take_it_home: wb.take_it_home,
      not_yet: wb.not_yet ?? '',
      quick_answer_drill_ids: wb.quick_answer_drill.question_ids,
      application_task_id: wb.application_task_id,
      practice_variants: wb.practice_variants,
    };
    const manual = unit.teacher_manual;
    base['teacher_manual'] = {
      script: manual.script,
      helper_script: manual.helper_script,
      materials: manual.materials,
      got_it: manual.mastery_guidance.got_it,
      not_yet_guidance: manual.mastery_guidance.not_yet,
    };
  }
  return {
    base,
    sections: sections.map((section) => ({
      id: section.id,
      type: section.type,
      heading: section.heading,
      question_ids: placedQuestionIds(section.blocks),
    })),
    locked_question_ids: locked,
    enrichment_used: sections
      .filter((section) => isEnrichmentType(section.type))
      .map((section) => section.type),
  };
}

// ---------------------------------------------------------------------------------------------
// Applying a patch
// ---------------------------------------------------------------------------------------------

export interface PatchOptions {
  /** When set, only these sections (and their questions and manual entries) may change. */
  restrictTo?: readonly string[] | undefined;
}

export interface PatchApplication {
  /** The candidate unit (JSON). Not parsed: the caller parses and lints it. */
  content: Json;
  /** Pieces of the patch that are invalid and were skipped. A repair retry should fix these. */
  issues: string[];
  /** Pieces that were left out on purpose (outside the restriction, locked, a deletion request). */
  notes: string[];
}

interface MutableUnit extends Rec {
  sections: Section[];
  questions: Record<string, Question>;
  session_plan?: {
    period: number;
    sections: string[];
    minutes: { segment: string; minutes: number }[];
  }[];
  workbook?: Rec & {
    tiers: { tier: number; title: string; question_ids: string[] }[];
    quick_answer_drill: { question_ids: string[] };
  };
  teacher_manual?: Rec;
}

const BLOCK_KEEP_KEYS = ['lang', 'asset_id'];

function withoutExtras(block: unknown): string {
  if (!isRecord(block)) return stableStringify(block);
  const copy: Rec = { ...block };
  for (const key of BLOCK_KEEP_KEYS) delete copy[key];
  return stableStringify(copy);
}

/** Keeps an illustration's picture and a block's language when the new block says the same thing as an old one. */
function preserveExtras(oldBlocks: readonly AnyBlock[], newBlocks: readonly Block[]): Block[] {
  const byKey = new Map<string, AnyBlock>();
  for (const block of oldBlocks) byKey.set(withoutExtras(block), block);
  return newBlocks.map((block) => {
    const old = byKey.get(withoutExtras(block)) as Rec | undefined;
    if (!old) return block;
    const extras: Rec = {};
    for (const key of BLOCK_KEEP_KEYS) if (old[key] !== undefined) extras[key] = old[key];
    return { ...block, ...extras } as Block;
  });
}

function nextQuestionNumber(owner: string, taken: ReadonlySet<string>): number {
  let n = 1;
  while (taken.has(questionId(owner, n))) n += 1;
  return n;
}

const MAX_ENRICHMENT = 5;

export function applyUnitPatch(
  base: UnitContent,
  patch: PatchOutput,
  options: PatchOptions = {},
): PatchApplication {
  const issues: string[] = [];
  const notes: string[] = [];
  if (base.kind === 'mini_project' || base.kind === 'term_project') {
    return { content: toJson(base), issues: ['Projects cannot be revised with a patch.'], notes };
  }
  const unit = clone(base) as unknown as MutableUnit;
  const restrict =
    options.restrictTo && options.restrictTo.length > 0 ? new Set(options.restrictTo) : null;
  const sectionIds = () => new Set(unit.sections.map((section) => section.id));
  const takenQuestionIds = new Set(Object.keys(unit.questions));

  // --- new sections: validate ids and types first, so new questions can name them as owners ---
  const newSectionPlans: {
    plan: PatchOutput['sections'][number];
    id: string;
    type: SectionType;
  }[] = [];
  const enrichmentUsed = new Set(
    unit.sections.filter((s) => isEnrichmentType(s.type)).map((s) => s.type),
  );
  for (const plan of patch.sections) {
    const id = clean(plan.id);
    if (sectionIds().has(id)) continue;
    const type = clean(plan.type) as SectionType;
    if (!Id.safeParse(id).success) {
      issues.push(
        `sections: "${id}" is not an existing section and is not a valid new id (lowercase letters, digits, underscores)`,
      );
      continue;
    }
    if (unit.kind !== 'lesson') {
      notes.push(`Adding a section (${id}) is only supported for lessons.`);
      continue;
    }
    if (restrict) {
      notes.push(
        `New section ${id} was left out: the change was limited to ${[...restrict].join(', ')}.`,
      );
      continue;
    }
    const isConcept = type === 'concept';
    const isEnrichment = (ENRICHMENT_MENU as readonly string[]).includes(type);
    if (!isConcept && !isEnrichment) {
      issues.push(
        `sections: new section ${id} has type "${type}"; use concept or an enrichment type (${ENRICHMENT_MENU.join(', ')})`,
      );
      continue;
    }
    if (isEnrichment && enrichmentUsed.has(type)) {
      issues.push(
        `sections: new section ${id} has type ${type}, which this unit already uses; each enrichment type is used once`,
      );
      continue;
    }
    if (isEnrichment && enrichmentUsed.size >= MAX_ENRICHMENT) {
      issues.push(
        `sections: the unit already has ${MAX_ENRICHMENT} enrichment sections; new section ${id} would be a sixth`,
      );
      continue;
    }
    if (isEnrichment) enrichmentUsed.add(type);
    newSectionPlans.push({ plan, id, type });
  }
  const futureSectionIds = new Set([...sectionIds(), ...newSectionPlans.map((p) => p.id)]);

  // --- questions: replace existing, assign ids to new ones ---
  const refs = new Map<string, string>(Object.keys(unit.questions).map((id) => [id, id]));
  const replacements: { id: string; question: Question }[] = [];
  const additions: { id: string; owner: string; question: Question }[] = [];
  const pending: {
    ref: string;
    id: string;
    owner: string;
    q: PatchOutput['questions'][number]['question'];
  }[] = [];
  for (const item of patch.questions) {
    const q = item.question;
    const ref = clean(q.ref);
    if (ref === '') {
      issues.push('questions: a question has an empty ref');
      continue;
    }
    const existing = unit.questions[ref];
    if (existing) {
      const owner = ownerOfQuestion(unit.sections, ref);
      if (restrict && (!owner || !restrict.has(owner))) {
        notes.push(
          `Question ${ref} was left out: the change was limited to ${[...restrict].join(', ')}.`,
        );
        continue;
      }
      if (!isAuthorable(existing)) {
        notes.push(
          `Question ${ref} is a ${existing.kind} question, which cannot be edited here; it was kept.`,
        );
        continue;
      }
      const mapped = mapQuestion(q, ref, `questions (replacing ${ref})`);
      issues.push(...mapped.issues);
      if (mapped.value) replacements.push({ id: ref, question: mapped.value });
      continue;
    }
    const owner = clean(item.section_id);
    if (!futureSectionIds.has(owner)) {
      issues.push(
        `questions: new question "${ref}" needs section_id = an existing (or new) section id; got "${owner}"`,
      );
      continue;
    }
    if (restrict && !restrict.has(owner)) {
      notes.push(
        `New question ${ref} was left out: the change was limited to ${[...restrict].join(', ')}.`,
      );
      continue;
    }
    if (pending.some((p) => p.ref === ref)) {
      issues.push(`questions: the new ref "${ref}" is used twice`);
      continue;
    }
    const id = questionId(owner, nextQuestionNumber(owner, takenQuestionIds));
    takenQuestionIds.add(id);
    refs.set(ref, id);
    pending.push({ ref, id, owner, q });
  }
  for (const item of pending) {
    const mapped = mapQuestion(item.q, item.id, `questions (new ${item.ref})`);
    issues.push(...mapped.issues);
    if (mapped.value) additions.push({ id: item.id, owner: item.owner, question: mapped.value });
  }

  // --- section replacements ---
  for (const plan of patch.sections) {
    const id = clean(plan.id);
    const section = unit.sections.find((s) => s.id === id);
    if (!section) continue;
    if (restrict && !restrict.has(id)) {
      notes.push(
        `Section ${id} was left out: the change was limited to ${[...restrict].join(', ')}.`,
      );
      continue;
    }
    const heading = clean(plan.heading);
    if (heading !== '') section.heading = heading;
    if (plan.blocks.length > 0) {
      const mapped = mapBlocks(plan.blocks, refs);
      issues.push(...mapped.issues.map((issue) => `section ${id}: ${issue}`));
      if (mapped.issues.length === 0 && mapped.blocks.length > 0) {
        const blocks = preserveExtras(section.blocks, mapped.blocks);
        if (
          !sameJson(blocks, section.blocks) &&
          section.audio_refs &&
          section.audio_refs.length > 0
        ) {
          delete section.audio_refs;
          notes.push(
            `Section ${id}: its narration audio was detached because the text changed; record it again.`,
          );
        }
        section.blocks = blocks;
      }
    }
    if (plan.tutor_script.length > 0) {
      const tutor = mapTutorScript(plan.tutor_script, refs);
      issues.push(...tutor.issues.map((issue) => `section ${id}: ${issue}`));
      if (tutor.value) section.tutor_script = tutor.value;
    }
  }

  // --- apply question replacements and additions ---
  for (const { id, question } of replacements) unit.questions[id] = question;
  for (const { id, question } of additions) unit.questions[id] = question;

  // --- new sections ---
  for (const { plan, id, type } of newSectionPlans) {
    const mapped = mapBlocks(plan.blocks, refs);
    issues.push(...mapped.issues.map((issue) => `new section ${id}: ${issue}`));
    if (mapped.issues.length > 0 || mapped.blocks.length === 0) {
      if (mapped.blocks.length === 0 && mapped.issues.length === 0)
        issues.push(`new section ${id}: it has no blocks`);
      continue;
    }
    const tutor = mapTutorScript(plan.tutor_script, refs);
    issues.push(...tutor.issues.map((issue) => `new section ${id}: ${issue}`));
    const section: Section = {
      id,
      type,
      layer: layerFor(type),
      heading: clean(plan.heading) || id.replace(/_/g, ' '),
      blocks: mapped.blocks,
      ...(tutor.value ? { tutor_script: tutor.value } : {}),
    };
    // unit order: after the last section whose type sorts at or before this one
    let at = 0;
    unit.sections.forEach((existing, index) => {
      if (orderOf(existing.type) <= orderOf(type)) at = index + 1;
    });
    unit.sections.splice(at, 0, section);
    // the session plan: the period of the section before it (or the first)
    const before = unit.sections[at - 1];
    const periods = unit.session_plan ?? [];
    const target = (before && periods.find((p) => p.sections.includes(before.id))) ?? periods[0];
    if (target) {
      const index = before ? target.sections.indexOf(before.id) : -1;
      target.sections.splice(index + 1, 0, id);
    }
  }

  // --- new questions that no block places yet go into their owner section ---
  for (const { id, owner } of additions) {
    const section = unit.sections.find((s) => s.id === owner);
    if (!section) continue;
    const placedAnywhere = unit.sections.some((s) => placedQuestionIds(s.blocks).includes(id));
    if (!placedAnywhere) {
      section.blocks = placeUnplacedQuestions(section.blocks as Block[], [id]);
      notes.push(
        `Question ${id} was not placed by any block, so it was added to the end of section ${owner}.`,
      );
    }
    // a new practice question joins its workbook tier
    const isPractice = section.type === 'practice';
    const question = unit.questions[id];
    const tier = unit.workbook?.tiers.find((t) => t.tier === question?.tier);
    if (isPractice && tier && !tier.question_ids.includes(id)) tier.question_ids.push(id);
  }
  // a question block that now shows a replaced question marks nothing new; replaced questions are in the question diff.

  // --- workbook ---
  if (unit.kind === 'lesson' && unit.workbook) {
    const edit = patch.workbook;
    const wantsWorkbook = [
      edit.tier1_title,
      edit.tier2_title,
      edit.tier3_title,
      edit.take_it_home,
      edit.not_yet,
    ].some((t) => clean(t) !== '');
    if (wantsWorkbook && restrict) {
      notes.push('Workbook text was left out: the change was limited to particular sections.');
    } else if (wantsWorkbook) {
      [edit.tier1_title, edit.tier2_title, edit.tier3_title].forEach((title, index) => {
        const tier = unit.workbook!.tiers.find((t) => t.tier === index + 1);
        if (tier && clean(title) !== '') tier.title = clean(title);
      });
      if (clean(edit.take_it_home) !== '') unit.workbook['take_it_home'] = clean(edit.take_it_home);
      if (clean(edit.not_yet) !== '') unit.workbook['not_yet'] = clean(edit.not_yet);
    }
    const touched = new Set([...replacements.map((r) => r.id), ...additions.map((a) => a.id)]);
    const inWorkbook = [
      ...unit.workbook.tiers.flatMap((t) => t.question_ids),
      ...unit.workbook.quick_answer_drill.question_ids,
    ];
    if (inWorkbook.some((id) => touched.has(id))) {
      unit.workbook['answers_note'] = answersNote(
        unit.workbook.tiers,
        unit.workbook.quick_answer_drill.question_ids,
        unit.questions,
      );
    }
  }

  // --- teacher's manual ---
  if (unit.kind === 'lesson' && unit.teacher_manual) {
    const manual = unit.teacher_manual as Rec & {
      script: { section_id: string; say: string; ask: string; watch_for: string }[];
      helper_script: { section_id: string; steps: string[] }[];
      materials: string[];
      mastery_guidance: { got_it: string[]; not_yet: string };
    };
    const known = sectionIds();
    const orderIndex = (id: string) => unit.sections.findIndex((s) => s.id === id);
    const upsert = <T extends { section_id: string }>(list: T[], entry: T) => {
      const at = list.findIndex((e) => e.section_id === entry.section_id);
      if (at >= 0) list[at] = entry;
      else {
        list.push(entry);
        list.sort((a, b) => orderIndex(a.section_id) - orderIndex(b.section_id));
      }
    };
    for (const entry of patch.manual.script) {
      const sectionId = clean(entry.section_id);
      const row = {
        section_id: sectionId,
        say: clean(entry.say),
        ask: clean(entry.ask),
        watch_for: clean(entry.watch_for),
      };
      if (!known.has(sectionId) && !futureSectionIds.has(sectionId)) continue;
      if (row.say === '' || row.ask === '' || row.watch_for === '') {
        if (row.say !== '' || row.ask !== '' || row.watch_for !== '')
          issues.push(`manual.script for ${sectionId} needs say, ask and watch_for`);
        continue;
      }
      if (restrict && !restrict.has(sectionId)) continue;
      upsert(manual.script, row);
    }
    for (const entry of patch.manual.helper_script) {
      const sectionId = clean(entry.section_id);
      const steps = cleanAll(entry.steps);
      if ((!known.has(sectionId) && !futureSectionIds.has(sectionId)) || steps.length === 0)
        continue;
      if (restrict && !restrict.has(sectionId)) continue;
      upsert(manual.helper_script, { section_id: sectionId, steps });
    }
    if (!restrict) {
      const materials = cleanAll(patch.manual.materials);
      if (materials.length > 0) manual.materials = materials;
      const gotIt = cleanAll(patch.manual.got_it);
      if (gotIt.length > 0) manual.mastery_guidance.got_it = gotIt;
      if (clean(patch.manual.not_yet_guidance) !== '')
        manual.mastery_guidance.not_yet = clean(patch.manual.not_yet_guidance);
    }
    if (newSectionPlans.length > 0 && unit.session_plan) {
      const headings = new Map(unit.sections.map((s) => [s.id, s.heading]));
      manual['timing'] = timingTextFrom(unit.session_plan, headings);
    }
  }

  return { content: toJson(unit), issues: unique(issues), notes };
}
