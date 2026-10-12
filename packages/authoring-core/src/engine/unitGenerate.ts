// unit_generate. For a lesson the steps are, in order:
//   outline            one call: which sections, how the periods are filled (validated and repaired by code)
//   section:<id> ...   one call per section: blocks, the questions the section owns, the tutor script
//   workbook           one call: tier titles, quick-answer drill, take-it-home, application task, variants
//   manual             one call: the teacher's manual (script per section, theme map, materials, helper script)
//   assemble           no call: build UnitContent, parseUnit (strict), lintUnit
//   repair:1, repair:2 only when lint has errors: one call each, rewriting only the sections the errors point at
//   review             one call: advisory flags (never blocks, never fixes)
// Other kinds have a simpler plan: draft, assemble, (repair), review.
//
// Every step reads only strictly EARLIER steps' outputs, so running it again with the same (input, state) gives
// the same output, whatever else is in the state.
import {
  parseUnit,
  type SectionType,
  type UnitContent,
} from '@custar/content-schema';
import {
  StepError,
  type Flag,
  type Json,
  type JobProgress,
  type JobState,
  type StepDeps,
  type StepOutcome,
  type UnitDraftOutput,
  type UnitGenerateInput,
} from '../contract';
import { renderUnit } from '../prompts/render';
import {
  AuthorSectionBody,
  OutlineOutput,
  ManualOutput,
  ProjectDraftOutput,
  RepairOutput,
  ReviewOutput,
  TestDraftOutput,
  WorkbookOutput,
} from '../prompts/schemas';
import {
  manualMessages,
  outlineMessages,
  projectMessages,
  repairMessages,
  reviewMessages,
  sectionMessages,
  testMessages,
  workbookMessages,
} from '../prompts/steps';
import { buildSystem } from '../prompts/system';
import {
  assembleLesson,
  assembleProject,
  assembleTest,
  type AssembledUnit,
  type LessonParts,
  type ManualPart,
  type ProjectPart,
  type WorkbookPart,
} from './assemble';
import { callModel } from './call';
import {
  blockToAuthor,
  buildSectionPart,
  mapQuestion,
  mapSectionQuestions,
  mapTutorScript,
  questionToAuthor,
  tutorToAuthor,
  type SectionPart,
} from './mapping';
import { normalizeOutline, validateOutline } from './outline';
import { castGuard, reviewToFlags, sortFlags, tutorGuard } from './review';
import {
  DEFAULT_HEADINGS,
  StoredOutlineSchema,
  sectionIdOfStep,
  sectionStepName,
  type StoredOutline,
} from './sections';
import { clean, cleanAll, isRecord, slot, toJson, unique } from './util';

// ---------------------------------------------------------------------------------------------
// Stored shapes
// ---------------------------------------------------------------------------------------------

interface StoredLint {
  errors: Flag[];
  warnings: Flag[];
  ok: boolean;
}

/** What `assemble` and `repair:n` store. */
interface StoredAssembly {
  content: Json;
  lint: StoredLint;
  notes: string[];
  parsed: boolean;
  skipped?: boolean;
  /** `repair:n` only: the sections it rewrote. */
  replaced?: Record<string, SectionPart>;
}

const MAX_REPAIRS = 2;

function readOutline(state: JobState): StoredOutline | null {
  const parsed = StoredOutlineSchema.safeParse(state.outputs['outline']);
  return parsed.success ? parsed.data : null;
}

function asPart(value: Json | undefined): SectionPart | null {
  if (!isRecord(value) || !isRecord(value['section']) || !Array.isArray(value['questions'])) return null;
  return value as unknown as SectionPart;
}

function asAssembly(value: Json | undefined): StoredAssembly | null {
  if (!isRecord(value) || !isRecord(value['lint']) || value['content'] === undefined) return null;
  return value as unknown as StoredAssembly;
}

function repairKey(n: number): string {
  return `repair:${n}`;
}

function supportsRepair(kind: UnitGenerateInput['unit']['kind']): boolean {
  return kind === 'lesson' || kind === 'revision' || kind === 'assessment';
}

/** The assembly a repair (or the review) starts from: `assemble`, then the repairs below `before`. */
function latestAssembly(state: JobState, before: number = MAX_REPAIRS + 1): StoredAssembly | null {
  for (let n = Math.min(before - 1, MAX_REPAIRS); n >= 1; n -= 1) {
    const repaired = asAssembly(state.outputs[repairKey(n)]);
    if (repaired) return repaired;
  }
  return asAssembly(state.outputs['assemble']);
}

/** Section parts of a lesson: the `section:<id>` outputs, overlaid with the sections repairs below `before` rewrote. */
function lessonSections(state: JobState, outline: StoredOutline, before: number): Record<string, SectionPart> {
  const parts: Record<string, SectionPart> = {};
  for (const section of outline.sections) {
    const part = asPart(state.outputs[sectionStepName(section.id)]);
    if (part) parts[section.id] = part;
  }
  for (let n = 1; n < before && n <= MAX_REPAIRS; n += 1) {
    const repaired = asAssembly(state.outputs[repairKey(n)])?.replaced ?? {};
    for (const [id, part] of Object.entries(repaired)) parts[id] = part;
  }
  return parts;
}

/** Section parts of a revision or assessment: the draft's, overlaid with repairs below `before`. */
function testSections(state: JobState, before: number): SectionPart[] {
  const draft = state.outputs['draft'];
  const base = isRecord(draft) && Array.isArray(draft['sections']) ? (draft['sections'] as unknown as SectionPart[]) : [];
  const parts = new Map(base.map((part) => [part.section.id, part]));
  for (let n = 1; n < before && n <= MAX_REPAIRS; n += 1) {
    const repaired = asAssembly(state.outputs[repairKey(n)])?.replaced ?? {};
    for (const [id, part] of Object.entries(repaired)) parts.set(id, part);
  }
  return base.map((part) => parts.get(part.section.id) ?? part);
}

// ---------------------------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------------------------

function hasErrors(assembly: StoredAssembly | null): boolean {
  return (assembly?.lint.errors.length ?? 0) > 0;
}

function plannedRepairs(input: UnitGenerateInput, state: JobState): string[] {
  const planned: string[] = [];
  if (!supportsRepair(input.unit.kind)) return planned;
  let current = asAssembly(state.outputs['assemble']);
  if (!current) return planned;
  for (let n = 1; n <= MAX_REPAIRS; n += 1) {
    const done = asAssembly(state.outputs[repairKey(n)]);
    if (done) {
      planned.push(repairKey(n));
      if (done.skipped) break;
      current = done;
      continue;
    }
    if (hasErrors(current)) planned.push(repairKey(n));
    break;
  }
  return planned;
}

/** Every step known so far, in order. Grows after `outline` (one step per section) and after a failed lint (repairs). */
export function plannedUnitSteps(input: UnitGenerateInput, state: JobState): string[] {
  if (input.unit.kind === 'lesson') {
    const steps = ['outline'];
    const outline = readOutline(state);
    if (outline) steps.push(...outline.sections.map((section) => sectionStepName(section.id)));
    steps.push('workbook', 'manual', 'assemble', ...plannedRepairs(input, state), 'review');
    return steps;
  }
  return ['draft', 'assemble', ...plannedRepairs(input, state), 'review'];
}

export function nextUnitStep(input: UnitGenerateInput, state: JobState): string | null {
  return plannedUnitSteps(input, state).find((step) => state.outputs[step] === undefined) ?? null;
}

export function unitProgress(input: UnitGenerateInput, state: JobState): JobProgress {
  const planned = plannedUnitSteps(input, state);
  return {
    done: planned.filter((step) => state.outputs[step] !== undefined),
    next: planned.find((step) => state.outputs[step] === undefined) ?? null,
    total: planned.length,
  };
}

// ---------------------------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------------------------

function storedAssembly(assembled: AssembledUnit, extra: Partial<StoredAssembly> = {}): Json {
  const stored: StoredAssembly = {
    content: assembled.content,
    lint: { errors: assembled.errors, warnings: assembled.warnings, ok: assembled.ok },
    notes: assembled.notes,
    parsed: assembled.unit !== null,
    ...extra,
  };
  return toJson(stored);
}

async function runOutline(input: UnitGenerateInput, deps: StepDeps): Promise<StepOutcome<'unit_generate'>> {
  const { value, usage } = await callModel(deps, {
    step: 'outline',
    family: 'unit_generate:outline',
    label: 'unit_generate:outline',
    schemaName: 'unit_outline',
    schema: OutlineOutput,
    system: buildSystem('unit', input.cast),
    messages: outlineMessages(input),
  });
  const outline = normalizeOutline(value, input);
  const problems = validateOutline(outline);
  if (problems.length > 0) {
    throw new StepError('outline', 'schema', `The outline could not be repaired: ${problems.join('; ')}`, { retryable: false });
  }
  return { output: toJson(outline), usage };
}

async function runSection(
  input: UnitGenerateInput,
  state: JobState,
  step: string,
  deps: StepDeps,
): Promise<StepOutcome<'unit_generate'>> {
  const sectionId = sectionIdOfStep(step);
  const outline = readOutline(state);
  if (!outline || sectionId === null) throw new StepError(step, 'internal', 'The outline is missing.', { retryable: false });
  const index = outline.sections.findIndex((section) => section.id === sectionId);
  const section = outline.sections[index];
  if (!section) throw new StepError(step, 'internal', `Unknown section "${sectionId}".`, { retryable: false });

  const soFar = outline.sections
    .slice(0, index)
    .map((earlier) => asPart(state.outputs[sectionStepName(earlier.id)]))
    .filter((part): part is SectionPart => part !== null);

  const built = slot<SectionPart>();
  const { usage } = await callModel(deps, {
    step,
    family: 'unit_generate:section',
    label: `unit_generate:section:${section.id}`,
    schemaName: 'unit_section',
    schema: AuthorSectionBody,
    system: buildSystem('unit', input.cast),
    messages: sectionMessages({ input, outline, section, soFar }),
    check: (body) => {
      const result = buildSectionPart({ id: section.id, type: section.type, heading: section.heading, body });
      built.value = result.part;
      return result.issues;
    },
  });
  if (!built.value) throw new StepError(step, 'internal', 'The section could not be built.', { retryable: false });
  return { output: toJson(built.value), usage };
}

// --- workbook ---

const DEFAULT_TIER_TITLES: [string, string, string] = ["Let's Start Together", 'Now You Try', 'Stretch Yourself'];
const VARIANT_IDS = ['variant_a', 'variant_b', 'variant_c'];

function buildWorkbookPart(value: WorkbookOutput): { part: WorkbookPart | null; issues: string[] } {
  const issues: string[] = [];
  const drill = mapSectionQuestions('drill', value.drill);
  issues.push(...drill.issues.map((issue) => `drill: ${issue}`));
  if (value.drill.length < 3 || value.drill.length > 8) issues.push('drill: write 4 to 6 quick-answer questions');
  for (const q of drill.questions) {
    if (!['mcq', 'fill_blank', 'circle', 'match', 'sort'].includes(q.kind)) {
      issues.push(`drill: ${q.id} is ${q.kind}; the drill must be auto-gradable`);
    }
  }
  const application = mapQuestion(value.application, 'q_application', 'application');
  issues.push(...application.issues);
  if (application.value && !['draw', 'free_text'].includes(application.value.kind)) {
    issues.push('application: kind must be draw or free_text');
  }
  const variants: WorkbookPart['variants'] = [];
  if (value.variants.length < 1) issues.push('variants: write 2 pools of 3 questions');
  value.variants.slice(0, VARIANT_IDS.length).forEach((variant, index) => {
    const id = VARIANT_IDS[index]!;
    const mapped = mapSectionQuestions(id, variant.questions);
    issues.push(...mapped.issues.map((issue) => `variants[${index}]: ${issue}`));
    if (mapped.questions.length < 2) issues.push(`variants[${index}]: a pool needs at least 2 questions`);
    variants.push({ id, questions: mapped.questions });
  });
  const takeItHome = clean(value.take_it_home);
  const notYet = clean(value.not_yet);
  if (takeItHome === '') issues.push('take_it_home is empty');
  if (notYet === '') issues.push('not_yet is empty');
  if (issues.length > 0 || !application.value) return { part: null, issues };

  const titles = [value.tier1_title, value.tier2_title, value.tier3_title].map((title, i) => clean(title) || DEFAULT_TIER_TITLES[i]!);
  const seconds = Number.isFinite(value.drill_seconds) && value.drill_seconds >= 10 && value.drill_seconds <= 600 ? Math.round(value.drill_seconds) : 60;
  return {
    part: {
      tier_titles: titles as [string, string, string],
      drill: drill.questions,
      drill_seconds: seconds,
      take_it_home: takeItHome,
      application: application.value,
      not_yet: notYet,
      variants,
    },
    issues: [],
  };
}

async function runWorkbook(input: UnitGenerateInput, state: JobState, deps: StepDeps): Promise<StepOutcome<'unit_generate'>> {
  const outline = readOutline(state);
  if (!outline) throw new StepError('workbook', 'internal', 'The outline is missing.', { retryable: false });
  const ordered = orderedParts(outline, state);
  if (!ordered.some((part) => part.section.type === 'practice')) {
    throw new StepError('workbook', 'internal', 'The practice section has not been written yet.', { retryable: false });
  }
  const built = slot<WorkbookPart>();
  const { usage } = await callModel(deps, {
    step: 'workbook',
    family: 'unit_generate:workbook',
    label: 'unit_generate:workbook',
    schemaName: 'unit_workbook',
    schema: WorkbookOutput,
    system: buildSystem('unit', input.cast),
    messages: workbookMessages(input, outline, ordered),
    check: (value) => {
      const result = buildWorkbookPart(value);
      built.value = result.part;
      return result.issues;
    },
  });
  if (!built.value) throw new StepError('workbook', 'internal', 'The workbook could not be built.', { retryable: false });
  return { output: toJson(built.value), usage };
}

function orderedParts(outline: StoredOutline, state: JobState): SectionPart[] {
  const parts = lessonSections(state, outline, 1);
  return outline.sections.flatMap((section) => (parts[section.id] ? [parts[section.id]!] : []));
}

// --- manual ---

function buildManualPart(
  value: ManualOutput,
  outline: StoredOutline,
  hasTheme: boolean,
): { part: ManualPart | null; issues: string[] } {
  const issues: string[] = [];
  const ids = outline.sections.map((section) => section.id);
  const known = new Set(ids);
  const script = new Map<string, ManualPart['script'][number]>();
  for (const entry of value.script) {
    const sectionId = clean(entry.section_id);
    if (!known.has(sectionId) || script.has(sectionId)) continue;
    const row = { section_id: sectionId, say: clean(entry.say), ask: clean(entry.ask), watch_for: clean(entry.watch_for) };
    if (row.say === '' || row.ask === '' || row.watch_for === '') issues.push(`script entry for ${sectionId} needs say, ask and watch_for`);
    script.set(sectionId, row);
  }
  const missing = ids.filter((id) => !script.has(id));
  if (missing.length > 0) issues.push(`script has no entry for: ${missing.join(', ')} (use exactly the section ids given)`);

  const helper = new Map<string, ManualPart['helper_script'][number]>();
  for (const entry of value.helper_script) {
    const sectionId = clean(entry.section_id);
    const steps = cleanAll(entry.steps);
    if (!known.has(sectionId) || helper.has(sectionId) || steps.length === 0) continue;
    helper.set(sectionId, { section_id: sectionId, steps });
  }
  if (helper.size === 0) issues.push('helper_script needs entries for the sections a pre-reader cannot do alone');

  const lenses = value.theme_lenses
    .map((lens) => ({ subject: clean(lens.subject), lens: clean(lens.lens), what_child_does: clean(lens.what_child_does) }))
    .filter((lens) => lens.subject !== '' && lens.lens !== '' && lens.what_child_does !== '');
  const connection = clean(value.connection_moment);
  if (hasTheme && (lenses.length < 2 || connection === '')) {
    issues.push('the unit has a theme: give at least 2 theme_lenses and a connection_moment');
  }
  const materials = cleanAll(value.materials);
  const gotIt = cleanAll(value.got_it);
  const notYet = clean(value.not_yet_guidance);
  if (materials.length === 0) issues.push('materials is empty');
  if (gotIt.length === 0) issues.push('got_it is empty');
  if (notYet === '') issues.push('not_yet_guidance is empty');
  if (issues.length > 0) return { part: null, issues };

  return {
    part: {
      script: ids.flatMap((id) => (script.has(id) ? [script.get(id)!] : [])),
      theme_lenses: hasTheme ? lenses : [],
      connection_moment: hasTheme ? connection : '',
      materials,
      got_it: gotIt,
      not_yet_guidance: notYet,
      helper_script: ids.flatMap((id) => (helper.has(id) ? [helper.get(id)!] : [])),
    },
    issues: [],
  };
}

async function runManual(input: UnitGenerateInput, state: JobState, deps: StepDeps): Promise<StepOutcome<'unit_generate'>> {
  const outline = readOutline(state);
  if (!outline) throw new StepError('manual', 'internal', 'The outline is missing.', { retryable: false });
  const built = slot<ManualPart>();
  const { usage } = await callModel(deps, {
    step: 'manual',
    family: 'unit_generate:manual',
    label: 'unit_generate:manual',
    schemaName: 'unit_manual',
    schema: ManualOutput,
    system: buildSystem('unit', input.cast),
    messages: manualMessages(input, outline, orderedParts(outline, state)),
    check: (value) => {
      const result = buildManualPart(value, outline, input.theme !== undefined);
      built.value = result.part;
      return result.issues;
    },
  });
  if (!built.value) throw new StepError('manual', 'internal', 'The manual could not be built.', { retryable: false });
  return { output: toJson(built.value), usage };
}

// --- non-lesson drafts ---

function buildProjectPart(value: ProjectDraftOutput): { part: ProjectPart | null; issues: string[] } {
  const issues: string[] = [];
  const brief = clean(value.brief);
  const steps = cleanAll(value.steps);
  const materials = cleanAll(value.materials);
  const reflection = cleanAll(value.reflection_prompts);
  if (brief === '') issues.push('brief is empty');
  if (steps.length < 3) issues.push('steps: write at least 3 steps');
  if (materials.length === 0) issues.push('materials is empty');
  if (reflection.length === 0) issues.push('reflection_prompts is empty');
  const rubric = value.rubric.map((row, index) => {
    const levels = cleanAll(row.levels).slice(0, 4);
    if (clean(row.criterion) === '') issues.push(`rubric[${index}].criterion is empty`);
    if (levels.length < 2) issues.push(`rubric[${index}] needs 2 to 4 level descriptors`);
    return { criterion: clean(row.criterion), levels: levels.map((descriptor, i) => ({ level: i + 1, descriptor })) };
  });
  if (rubric.length === 0) issues.push('rubric is empty');
  const evidence = unique(value.evidence_options);
  if (evidence.length === 0) issues.push('evidence_options is empty');
  const tutor = mapTutorScript(value.tutor_script, new Map());
  issues.push(...tutor.issues);
  if (issues.length > 0) return { part: null, issues };
  return {
    part: {
      brief,
      steps: steps.map((text, i) => ({ n: i + 1, text })),
      materials,
      rubric,
      evidence_options: evidence,
      reflection_prompts: reflection,
      ...(tutor.value ? { tutor_script: tutor.value } : {}),
    },
    issues: [],
  };
}

function buildTestSections(
  value: TestDraftOutput,
  type: SectionType,
): { sections: SectionPart[] | null; issues: string[] } {
  const issues: string[] = [];
  const sections: SectionPart[] = [];
  value.parts.forEach((part, index) => {
    const id = `${type}_${index + 1}`;
    const heading = clean(part.heading) || `${DEFAULT_HEADINGS[type] ?? type} ${index + 1}`;
    const built = buildSectionPart({
      id,
      type,
      heading,
      body: { blocks: part.blocks, questions: part.questions, tutor_script: [] },
    });
    issues.push(...built.issues.map((issue) => `parts[${index}]: ${issue}`));
    if (built.part) sections.push(built.part);
  });
  if (value.parts.length === 0) issues.push('parts is empty');
  if (sections.reduce((n, part) => n + part.questions.length, 0) < 3) issues.push('write at least 3 questions in all');
  return issues.length > 0 ? { sections: null, issues } : { sections, issues: [] };
}

async function runDraft(input: UnitGenerateInput, deps: StepDeps): Promise<StepOutcome<'unit_generate'>> {
  const kind = input.unit.kind;
  const base = { step: 'draft', family: 'unit_generate:draft', label: 'unit_generate:draft', system: buildSystem('unit', input.cast) };
  if (kind === 'mini_project' || kind === 'term_project') {
    const built = slot<ProjectPart>();
    const { usage } = await callModel(deps, {
      ...base,
      schemaName: 'unit_project',
      schema: ProjectDraftOutput,
      messages: projectMessages(input),
      check: (value) => {
        const result = buildProjectPart(value);
        built.value = result.part;
        return result.issues;
      },
    });
    if (!built.value) throw new StepError('draft', 'internal', 'The project could not be built.', { retryable: false });
    return { output: toJson(built.value), usage };
  }
  if (kind === 'revision' || kind === 'assessment') {
    const type: SectionType = kind === 'revision' ? 'revision_topic' : 'assessment_part';
    const built = slot<SectionPart[]>();
    const { usage } = await callModel(deps, {
      ...base,
      schemaName: 'unit_test',
      schema: TestDraftOutput,
      messages: testMessages(input),
      check: (value) => {
        const result = buildTestSections(value, type);
        built.value = result.sections;
        return result.issues;
      },
    });
    if (!built.value) throw new StepError('draft', 'internal', 'The unit could not be built.', { retryable: false });
    return { output: toJson({ sections: built.value }), usage };
  }
  throw new StepError('draft', 'internal', 'A lesson has no draft step.', { retryable: false });
}

// --- assemble ---

function runAssemble(input: UnitGenerateInput, state: JobState): StepOutcome<'unit_generate'> {
  const kind = input.unit.kind;
  if (kind === 'lesson') {
    const outline = readOutline(state);
    const workbook = state.outputs['workbook'] as unknown as WorkbookPart | undefined;
    const manual = state.outputs['manual'] as unknown as ManualPart | undefined;
    if (!outline || !workbook || !manual) {
      throw new StepError('assemble', 'internal', 'A lesson cannot be assembled before its outline, workbook and manual exist.', { retryable: false });
    }
    const parts: LessonParts = { outline, sections: lessonSections(state, outline, 1), workbook, manual };
    return { output: storedAssembly(assembleLesson(input, parts)), usage: [] };
  }
  if (kind === 'mini_project' || kind === 'term_project') {
    const project = state.outputs['draft'] as unknown as ProjectPart | undefined;
    if (!project) throw new StepError('assemble', 'internal', 'The draft is missing.', { retryable: false });
    return { output: storedAssembly(assembleProject(input, project)), usage: [] };
  }
  return { output: storedAssembly(assembleTest(input, { sections: testSections(state, 1) })), usage: [] };
}

// --- repair ---

const QUESTION_PATH = /^questions(?:\.|\[")([A-Za-z0-9_]+)/;
const SECTION_PATH = /^sections\[(\d+)\]/;

/** The section ids the lint errors point at (directly, or through a question the section owns). */
export function affectedSectionIds(content: Json, errors: readonly Flag[]): string[] {
  const sections = isRecord(content) && Array.isArray(content['sections']) ? (content['sections'] as Json[]) : [];
  const ids = sections.map((section) => (isRecord(section) && typeof section['id'] === 'string' ? section['id'] : ''));
  const ownerOfQuestion = (questionId: string): string | null => {
    for (const section of sections) {
      if (!isRecord(section) || !Array.isArray(section['blocks'])) continue;
      const placed = (section['blocks'] as Json[]).some(
        (block) => isRecord(block) && block['type'] === 'question' && block['question_id'] === questionId,
      );
      if (placed && typeof section['id'] === 'string') return section['id'];
    }
    return ids.find((id) => id !== '' && questionId.startsWith(`q_${id}_`)) ?? null;
  };
  const found: string[] = [];
  for (const error of errors) {
    const path = error.path ?? '';
    const bySection = SECTION_PATH.exec(path);
    if (bySection) {
      const id = ids[Number(bySection[1])];
      if (id) found.push(id);
      continue;
    }
    const byQuestion = QUESTION_PATH.exec(path);
    if (byQuestion) {
      const owner = ownerOfQuestion(byQuestion[1]!);
      if (owner) found.push(owner);
    }
  }
  return unique(found);
}

async function runRepair(
  input: UnitGenerateInput,
  state: JobState,
  step: string,
  deps: StepDeps,
): Promise<StepOutcome<'unit_generate'>> {
  const n = Number(step.slice('repair:'.length));
  if (!Number.isInteger(n) || n < 1 || n > MAX_REPAIRS) throw new StepError(step, 'internal', `Unknown step "${step}".`, { retryable: false });
  const current = latestAssembly(state, n);
  if (!current) throw new StepError(step, 'internal', 'There is nothing to repair yet.', { retryable: false });

  const affected = affectedSectionIds(current.content, current.lint.errors);
  const skip = (): StepOutcome<'unit_generate'> => ({
    output: toJson({ ...current, skipped: true, replaced: {} }),
    usage: [],
  });
  if (affected.length === 0) return skip();

  const isLesson = input.unit.kind === 'lesson';
  const outline = isLesson ? readOutline(state) : null;
  const lessonParts = isLesson && outline ? lessonSections(state, outline, n) : {};
  const testParts = isLesson ? [] : testSections(state, n);
  const partOf = (id: string): SectionPart | undefined => (isLesson ? lessonParts[id] : testParts.find((p) => p.section.id === id));
  const targets = affected.map((id) => partOf(id)).filter((part): part is SectionPart => part !== undefined);
  if (targets.length === 0) return skip();

  const view = targets.map((part) => ({
    id: part.section.id,
    type: part.section.type,
    heading: part.section.heading,
    authoring: {
      blocks: part.section.blocks.map(blockToAuthor),
      questions: part.questions.flatMap((q) => {
        const authored = questionToAuthor(q);
        return authored ? [authored] : [];
      }),
      tutor_script: tutorToAuthor(part.section.tutor_script),
    },
  }));
  const targetIds = targets.map((part) => part.section.id);

  let rebuilt: Record<string, SectionPart> = {};
  const { usage } = await callModel(deps, {
    step,
    family: 'unit_generate:repair',
    label: `unit_generate:repair:${n}`,
    schemaName: 'unit_repair',
    schema: RepairOutput,
    system: buildSystem('unit', input.cast),
    messages: repairMessages(
      input,
      current.lint.errors.map((error) => ({ code: error.code, message: error.message, path: error.path })),
      view,
    ),
    check: (reply) => {
      const issues: string[] = [];
      const next: Record<string, SectionPart> = {};
      for (const id of targetIds) {
        const body = reply.sections.find((section) => clean(section.id) === id);
        const old = partOf(id)!;
        if (!body) {
          issues.push(`the reply is missing section ${id}`);
          continue;
        }
        const result = buildSectionPart({ id, type: old.section.type, heading: old.section.heading, body });
        issues.push(...result.issues.map((issue) => `${id}: ${issue}`));
        if (result.part) next[id] = result.part;
      }
      rebuilt = next;
      return issues;
    },
  });

  // re-assemble with the rewritten sections
  let assembled: AssembledUnit;
  if (isLesson && outline) {
    const workbook = state.outputs['workbook'] as unknown as WorkbookPart;
    const manual = state.outputs['manual'] as unknown as ManualPart;
    assembled = assembleLesson(input, { outline, sections: { ...lessonParts, ...rebuilt }, workbook, manual });
  } else {
    assembled = assembleTest(input, {
      sections: testSections(state, n).map((part) => rebuilt[part.section.id] ?? part),
    });
  }
  return { output: storedAssembly(assembled, { replaced: rebuilt }), usage };
}

// --- review ---

function summaryOf(unit: UnitContent, lint: StoredLint, review: readonly Flag[], outline: StoredOutline | null): string {
  const concerns = review.filter((flag) => flag.severity === 'concern').length;
  const notes = review.length - concerns;
  const sections = 'sections' in unit && unit.sections ? unit.sections.length : 0;
  const questions = 'questions' in unit && unit.questions ? Object.keys(unit.questions).length : 0;
  const shape =
    unit.kind === 'lesson' && outline
      ? `${sections} sections (enrichment: ${outline.enrichment.join(', ')}), ${questions} questions, ${outline.periods.length} period(s)`
      : `${sections} section(s), ${questions} question(s)`;
  return `Drafted "${unit.header.title}" (${unit.kind}): ${shape}. Lint: ${lint.errors.length} error(s), ${lint.warnings.length} warning(s). Review: ${concerns} concern(s), ${notes} note(s). A human must read and approve it before it is published.`;
}

async function runReview(input: UnitGenerateInput, state: JobState, deps: StepDeps): Promise<StepOutcome<'unit_generate'>> {
  const assembly = latestAssembly(state);
  if (!assembly) throw new StepError('review', 'internal', 'There is no assembled draft to review.', { retryable: false });
  const outline = readOutline(state);
  const outlineNotes: Flag[] = (outline?.notes ?? []).map((message) => ({ code: 'other', severity: 'note', message: `Outline: ${message}` }));

  let unit: UnitContent | null = null;
  try {
    unit = parseUnit(assembly.content);
  } catch {
    unit = null;
  }
  if (!unit) {
    const review = sortFlags([
      { code: 'other', severity: 'concern', message: 'The draft does not pass the schema, so it was not reviewed. Fix the lint errors first.' },
      ...outlineNotes,
    ]);
    const result: UnitDraftOutput = { content: assembly.content, lint: assembly.lint, review, summary: 'The draft does not pass the schema; see the lint errors.' };
    return { output: toJson({ flags: review.length }), usage: [], result };
  }

  const { value, usage } = await callModel(deps, {
    step: 'review',
    family: 'unit_generate:review',
    label: 'unit_generate:review',
    schemaName: 'unit_review',
    schema: ReviewOutput,
    system: buildSystem('unit', input.cast),
    messages: reviewMessages(input, renderUnit(unit)),
  });
  const review = sortFlags([
    ...reviewToFlags(value, unit),
    ...castGuard(unit, input.cast),
    ...tutorGuard(unit),
    ...outlineNotes,
    ...assembly.notes.map((message): Flag => ({ code: 'other', severity: 'note', message })),
  ]);
  const result: UnitDraftOutput = {
    content: assembly.content,
    lint: assembly.lint,
    review,
    summary: summaryOf(unit, assembly.lint, review, outline),
  };
  return { output: toJson({ flags: review.length }), usage, result };
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

export async function runUnitGenerateStep(
  call: { input: UnitGenerateInput; state: JobState; step: string },
  deps: StepDeps,
): Promise<StepOutcome<'unit_generate'>> {
  const { input, state, step } = call;
  const isLesson = input.unit.kind === 'lesson';
  if (step === 'outline' && isLesson) return runOutline(input, deps);
  if (step.startsWith('section:') && isLesson) return runSection(input, state, step, deps);
  if (step === 'workbook' && isLesson) return runWorkbook(input, state, deps);
  if (step === 'manual' && isLesson) return runManual(input, state, deps);
  if (step === 'draft' && !isLesson) return runDraft(input, deps);
  if (step === 'assemble') return runAssemble(input, state);
  if (step.startsWith('repair:')) return runRepair(input, state, step, deps);
  if (step === 'review') return runReview(input, state, deps);
  throw new StepError(step, 'internal', `Unknown step "${step}" for a ${input.unit.kind} unit.`, { retryable: false });
}

