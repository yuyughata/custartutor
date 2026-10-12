// unit_revise: `patch` (one call: the instruction and the base unit give an ID-addressed patch), `apply` (no call:
// apply the patch deterministically, parse strictly, lint, lintVersionIds, work out what changed) and `review`
// (one call over the changed parts only; no call when nothing changed). The model never regenerates the unit,
// and an id of the base version can never disappear.
import {
  lintUnit,
  lintVersionIds,
  parseUnit,
  sectionsOf,
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
  type UnitReviseInput,
} from '../contract';
import { renderManual, renderUnit, renderWorkbook } from '../prompts/render';
import { PatchOutput, ReviewOutput } from '../prompts/schemas';
import { patchMessages, patchReviewMessages } from '../prompts/steps';
import { buildSystem } from '../prompts/system';
import { lintToFlags } from './assemble';
import { callModel } from './call';
import {
  applyUnitPatch,
  buildPatchBaseView,
  diffUnits,
  restoreDroppedIds,
  type UnitDiff,
} from './patch';
import { castGuard, reviewToFlags, sortFlags } from './review';
import { clean, isRecord, toJson } from './util';

export const REVISE_STEPS = ['patch', 'apply', 'review'] as const;

export function nextReviseStep(state: JobState): string | null {
  return REVISE_STEPS.find((step) => state.outputs[step] === undefined) ?? null;
}

export function reviseProgress(state: JobState): JobProgress {
  return {
    done: REVISE_STEPS.filter((step) => state.outputs[step] !== undefined),
    next: nextReviseStep(state),
    total: REVISE_STEPS.length,
  };
}

function parseBase(input: UnitReviseInput, step: string): UnitContent {
  try {
    return parseUnit(input.base_content);
  } catch (error) {
    throw new StepError(
      step,
      'invalid_input',
      `The base version does not parse: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`,
      {
        retryable: false,
      },
    );
  }
}

function assertRevisable(base: UnitContent, step: string): void {
  if (base.kind === 'mini_project' || base.kind === 'term_project') {
    throw new StepError(
      step,
      'invalid_input',
      'Revising a project is not supported yet; edit it by hand or draft it again.',
      {
        retryable: false,
      },
    );
  }
}

export async function runPatch(
  input: UnitReviseInput,
  deps: StepDeps,
): Promise<StepOutcome<'unit_revise'>> {
  const base = parseBase(input, 'patch');
  assertRevisable(base, 'patch');
  const known = new Set(sectionsOf(base).map((section) => section.id));
  const unknown = (input.section_ids ?? []).filter((id) => !known.has(id));
  if (unknown.length > 0) {
    throw new StepError(
      'patch',
      'invalid_input',
      `section_ids names sections the unit does not have: ${unknown.join(', ')}`,
      { retryable: false },
    );
  }
  const view = buildPatchBaseView(base);
  const { value, usage } = await callModel(deps, {
    step: 'patch',
    family: 'unit_revise:patch',
    label: 'unit_revise:patch',
    schemaName: 'unit_patch',
    schema: PatchOutput,
    system: buildSystem('unit', input.cast),
    messages: patchMessages(input, {
      ...view,
      restricted_to: input.section_ids && input.section_ids.length > 0 ? input.section_ids : null,
    }),
    check: (patch) => applyUnitPatch(base, patch, { restrictTo: input.section_ids }).issues,
  });
  return { output: toJson(value), usage };
}

/** What `apply` stores. */
interface StoredRevision {
  content: Json;
  lint: { errors: Flag[]; warnings: Flag[]; ok: boolean };
  changed: { section_ids: string[]; question_ids: string[] };
  diff: UnitDiff;
  notes: string[];
  issues: string[];
  summary: string;
  parsed: boolean;
}

function asRevision(value: Json | undefined): StoredRevision | null {
  if (
    !isRecord(value) ||
    !isRecord(value['lint']) ||
    !isRecord(value['changed']) ||
    value['content'] === undefined
  )
    return null;
  return value as unknown as StoredRevision;
}

export function runApply(input: UnitReviseInput, state: JobState): StepOutcome<'unit_revise'> {
  const base = parseBase(input, 'apply');
  assertRevisable(base, 'apply');
  const parsedPatch = PatchOutput.safeParse(state.outputs['patch']);
  if (!parsedPatch.success)
    throw new StepError('apply', 'internal', 'The patch step has no usable output yet.', {
      retryable: false,
    });
  const patch = parsedPatch.data;

  const applied = applyUnitPatch(base, patch, { restrictTo: input.section_ids });
  // the stable-ID rule as a repair: anything that went missing is put back from the base version
  const restored = restoreDroppedIds(base, applied.content);
  const notes = [...applied.notes, ...restored.notes];

  let next: UnitContent | null = null;
  let parseErrors: Flag[] = [];
  try {
    next = parseUnit(restored.content);
  } catch (error) {
    const issues =
      isRecord(error) && Array.isArray(error['issues'])
        ? (error['issues'] as { path: string; message: string }[])
        : [];
    parseErrors =
      issues.length > 0
        ? issues.map((issue) => ({
            code: 'schema_invalid',
            severity: 'concern' as const,
            message: issue.message,
            ...(issue.path ? { path: issue.path } : {}),
          }))
        : [
            {
              code: 'schema_invalid',
              severity: 'concern',
              message: error instanceof Error ? error.message : String(error),
            },
          ];
  }

  let lint: StoredRevision['lint'];
  if (next) {
    const report = lintUnit(next, { previousEnrichment: input.previous_enrichment });
    const ids = lintVersionIds(base, next);
    const flags = lintToFlags({
      errors: [...report.errors, ...ids.errors],
      warnings: report.warnings,
    });
    lint = { errors: flags.errors, warnings: flags.warnings, ok: report.ok && ids.ok };
  } else {
    lint = { errors: parseErrors, warnings: [], ok: false };
  }

  const diff = diffUnits(base, next ? toJson(next) : restored.content);
  const changed = { section_ids: diff.section_ids, question_ids: diff.question_ids };
  const parts: string[] = [];
  if (diff.section_ids.length > 0) parts.push(`${diff.section_ids.length} section(s)`);
  if (diff.question_ids.length > 0) parts.push(`${diff.question_ids.length} question(s)`);
  if (diff.workbook_changed) parts.push('the workbook text');
  if (diff.manual_changed) parts.push("the teacher's manual");
  const what = parts.length > 0 ? `Changed ${parts.join(', ')}.` : 'Nothing changed.';
  const said = clean(patch.summary);
  const stored: StoredRevision = {
    content: next ? toJson(next) : restored.content,
    lint,
    changed,
    diff,
    notes,
    issues: applied.issues,
    summary: `${said !== '' ? `${said} ` : ''}${what}`,
    parsed: next !== null,
  };
  return { output: toJson(stored), usage: [] };
}

export async function runReviseReview(
  input: UnitReviseInput,
  state: JobState,
  deps: StepDeps,
): Promise<StepOutcome<'unit_revise'>> {
  const revision = asRevision(state.outputs['apply']);
  if (!revision)
    throw new StepError('review', 'internal', 'The apply step has no usable output yet.', {
      retryable: false,
    });

  const noteFlags: Flag[] = [
    ...revision.issues.map((message): Flag => ({
      code: 'other',
      severity: 'concern',
      message: `Part of the patch was invalid and was skipped: ${message}`,
    })),
    ...revision.notes.map((message): Flag => ({ code: 'other', severity: 'note', message })),
  ];
  const finish = (review: Flag[], usage: StepOutcome['usage']): StepOutcome<'unit_revise'> => {
    const result: UnitDraftOutput = {
      content: revision.content,
      lint: revision.lint,
      review: sortFlags(review),
      summary: revision.summary,
      changed: revision.changed,
    };
    return { output: toJson({ flags: review.length }), usage, result };
  };

  let unit: UnitContent | null = null;
  try {
    unit = parseUnit(revision.content);
  } catch {
    unit = null;
  }
  const { diff } = revision;
  const anyChange =
    diff.section_ids.length > 0 ||
    diff.question_ids.length > 0 ||
    diff.workbook_changed ||
    diff.manual_changed;
  if (!unit) {
    return finish(
      [
        {
          code: 'other',
          severity: 'concern',
          message:
            'The revised draft does not pass the schema, so it was not reviewed. See the lint errors.',
        },
        ...noteFlags,
      ],
      [],
    );
  }
  if (!anyChange) return finish(noteFlags, []);

  const parts = [
    renderUnit(unit, { onlySectionIds: diff.section_ids, onlyQuestionIds: diff.question_ids }),
  ];
  if (unit.kind === 'lesson') {
    const questions = unit.questions;
    if (diff.workbook_changed) parts.push(renderWorkbook(unit.workbook, questions));
    if (diff.manual_changed) parts.push(renderManual(unit.teacher_manual));
  }
  const { value, usage } = await callModel(deps, {
    step: 'review',
    family: 'unit_revise:review',
    label: 'unit_revise:review',
    schemaName: 'unit_review',
    schema: ReviewOutput,
    system: buildSystem('unit', input.cast),
    messages: patchReviewMessages(input, parts.join('\n\n'), revision.changed),
  });
  const changedIndexes = new Set(
    sectionsOf(unit)
      .map((section, index) =>
        revision.changed.section_ids.includes(section.id) ? `sections[${index}]` : null,
      )
      .filter((path): path is string => path !== null),
  );
  const guard = castGuard(unit, input.cast).filter(
    (flag) => flag.path !== undefined && changedIndexes.has(flag.path),
  );
  return finish([...reviewToFlags(value, unit), ...guard, ...noteFlags], usage);
}

export async function runUnitReviseStep(
  call: { input: UnitReviseInput; state: JobState; step: string },
  deps: StepDeps,
): Promise<StepOutcome<'unit_revise'>> {
  switch (call.step) {
    case 'patch':
      return runPatch(call.input, deps);
    case 'apply':
      return runApply(call.input, call.state);
    case 'review':
      return runReviseReview(call.input, call.state, deps);
    default:
      throw new StepError(call.step, 'internal', `Unknown step "${call.step}" for unit_revise.`, {
        retryable: false,
      });
  }
}
