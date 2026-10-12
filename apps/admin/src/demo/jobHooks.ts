// What the demo backend gives the in-memory job API: a resolver that builds engine inputs from the demo store
// (mirroring the server's JobInputResolver) and a hook that saves finished drafts into the store (mirroring the
// ai-job edge function calling create_unit_version_draft). Written against the contract types only.
import type {
  AiSettings,
  CastMember,
  EngineResult,
  JobInput,
  JobInputResolver,
  JobKind,
  JobParams,
  JobRow,
  Json,
  PriorUnitDigest,
  StoredLintReport,
  StoredResult,
} from '@custar/authoring-core';
import { AdminApiError } from '../api/errors';
import {
  chapterOf,
  enrichmentTypes,
  keyTerms,
  latestVersionOf,
  previousUnit,
  schemeOf,
  unitsInOrder,
} from './queries';
import { DEMO_MODEL_ID, type DemoState } from './state';

export interface DemoJobHooks {
  /** Builds engine inputs from the demo store, like the server's JobInputResolver. */
  resolveInput: JobInputResolver;
  /** The live demo settings (kill switch, budgets, prices); read before every step. */
  settings(): AiSettings;
  /** Reads an uploaded scheme file back from the demo store. */
  loadUpload(path: string): Promise<{ bytes: Uint8Array; mime: string }>;
  /** Saves what a finished job produced; returns what the job row keeps in `result`. */
  onSucceeded(
    job: JobRow,
    result: EngineResult[JobKind],
    input: JobInput[JobKind],
  ): StoredResult[JobKind];
  now(): Date;
}

function notFound(what: string): AdminApiError {
  return new AdminApiError('not_found', 'not_found', `That ${what} no longer exists.`, 404);
}

export function castOf(state: DemoState): CastMember[] {
  return state.characters
    .filter((character) => character.active)
    .map((character) => ({
      slug: character.slug,
      name: character.name,
      traits: character.traits,
      voice: character.voice,
    }));
}

export function createDemoJobHooks(
  state: DemoState,
  options: {
    newId: () => string;
    now: () => Date;
    loadUpload: DemoJobHooks['loadUpload'];
  },
): DemoJobHooks {
  const resolveInput: JobInputResolver = async <K extends JobKind>(
    kind: K,
    params: JobParams[K],
  ): Promise<JobInput[K]> => {
    switch (kind) {
      case 'scheme_ingest': {
        const p = params as JobParams['scheme_ingest'];
        const subject = state.subjects.find((candidate) => candidate.id === p.subject_id);
        if (!subject) throw notFound('subject');
        const input: JobInput['scheme_ingest'] = {
          subject_slug: subject.slug,
          subject_name: subject.name,
          level_code: p.level_code,
          term: p.term,
          source: p.source,
        };
        return input as JobInput[K];
      }
      case 'chapter_plan': {
        const p = params as JobParams['chapter_plan'];
        const scheme = state.schemes.find((candidate) => candidate.id === p.scheme_id);
        if (!scheme) throw notFound('scheme');
        const subject = state.subjects.find((candidate) => candidate.id === scheme.subject_id);
        if (!subject) throw notFound('subject');
        const input: JobInput['chapter_plan'] = {
          scheme_id: scheme.id,
          scheme: {
            subject_slug: subject.slug,
            level_code: scheme.level_code,
            term: scheme.term,
            weeks: scheme.weeks,
          },
          subject_name: subject.name,
          cast: castOf(state),
        };
        return input as JobInput[K];
      }
      case 'unit_generate': {
        const p = params as JobParams['unit_generate'];
        const unit = state.units.find((candidate) => candidate.id === p.unit_id);
        if (!unit) throw notFound('unit');
        const chapter = chapterOf(state, unit);
        const scheme = schemeOf(state, chapter);
        const subject = state.subjects.find((candidate) => candidate.id === scheme.subject_id);
        if (!subject) throw notFound('subject');
        const week = scheme.weeks.find((candidate) => candidate.week_no === unit.week_no);
        const ordered = unitsInOrder(state, scheme.subject_id, scheme.level_code);
        const before = ordered.slice(
          0,
          Math.max(
            0,
            ordered.findIndex((entry) => entry.id === unit.id),
          ),
        );
        const prior: PriorUnitDigest[] = before.slice(-6).map((earlier) => {
          const latest = latestVersionOf(state, earlier.id);
          return {
            unit_no: earlier.unit_no,
            title: earlier.title,
            objective: earlier.objective,
            key_terms: latest ? keyTerms(latest.content) : [],
          };
        });
        const previous = previousUnit(state, unit);
        const previousVersion = previous ? latestVersionOf(state, previous.id) : undefined;
        const input: JobInput['unit_generate'] = {
          unit: {
            id: unit.id,
            kind: unit.kind,
            unit_no: unit.unit_no,
            week_no: unit.week_no,
            title: unit.title,
            objective: unit.objective ?? week?.topic ?? unit.title,
            stage: unit.stage,
            periods: unit.periods,
          },
          chapter: { number: chapter.number, title: chapter.title },
          subject: { slug: subject.slug, name: subject.name },
          level_code: scheme.level_code,
          term: scheme.term,
          ...(chapter.theme ? { theme: chapter.theme } : {}),
          scheme_week: week ? { topic: week.topic, subtopics: week.subtopics } : null,
          prior_units: prior,
          previous_enrichment: previousVersion ? enrichmentTypes(previousVersion.content) : [],
          cast: castOf(state),
          ...(p.notes ? { notes: p.notes } : {}),
        };
        return input as JobInput[K];
      }
      case 'unit_revise': {
        const p = params as JobParams['unit_revise'];
        const version = state.versions.find((candidate) => candidate.id === p.unit_version_id);
        if (!version) throw notFound('version');
        const unit = state.units.find((candidate) => candidate.id === version.unit_id);
        if (!unit) throw notFound('unit');
        const latest = latestVersionOf(state, unit.id);
        if (latest && latest.id !== version.id) {
          throw new AdminApiError(
            'conflict',
            'stale_base',
            'A newer version of this unit exists. Reload the page and try again.',
            409,
          );
        }
        const previous = previousUnit(state, unit);
        const previousVersion = previous ? latestVersionOf(state, previous.id) : undefined;
        const input: JobInput['unit_revise'] = {
          unit_id: unit.id,
          base_version_id: version.id,
          base_version_no: version.version,
          base_content: version.content,
          instruction: p.instruction,
          ...(p.section_ids ? { section_ids: p.section_ids } : {}),
          previous_enrichment: previousVersion ? enrichmentTypes(previousVersion.content) : [],
          cast: castOf(state),
        };
        return input as JobInput[K];
      }
      default: {
        const never: never = kind;
        throw new Error(`demo: unknown job kind ${String(never)}`);
      }
    }
  };

  /** What the ai-job edge function does after the last step: save a draft version through the caller's JWT. */
  function saveDraft(
    unitId: string,
    output: EngineResult['unit_generate'],
  ): StoredResult['unit_generate'] {
    const latest = latestVersionOf(state, unitId);
    const id = options.newId();
    const version = (latest?.version ?? 0) + 1;
    const stored: StoredLintReport = {
      errors: output.lint.errors,
      warnings: output.lint.warnings,
      ok: output.lint.ok,
      review: output.review,
      summary: output.summary,
    };
    state.versions.push({
      id,
      unit_id: unitId,
      version,
      schema_version: 1,
      status: 'draft',
      generated_by: 'ai',
      model: DEMO_MODEL_ID,
      prompt_version: state.settings.prompt_version,
      lint_report: stored,
      base_version_id: latest?.id ?? null,
      created_by: null,
      created_at: options.now().toISOString(),
      content: output.content as Json,
    });
    return {
      unit_version_id: id,
      version,
      lint: {
        errors: output.lint.errors.length,
        warnings: output.lint.warnings.length,
        ok: output.lint.ok,
      },
      review: output.review,
      summary: output.summary,
      ...(output.changed ? { changed: output.changed } : {}),
    };
  }

  return {
    resolveInput,
    settings: () => state.settings,
    loadUpload: options.loadUpload,
    now: options.now,
    onSucceeded(job, result, input) {
      switch (job.kind) {
        case 'scheme_ingest':
        case 'chapter_plan':
          // Nothing is saved: the draft stays in the job row until a person applies it.
          return result as StoredResult[JobKind];
        case 'unit_generate': {
          const { unit } = input as JobInput['unit_generate'];
          return saveDraft(unit.id, result as EngineResult['unit_generate']);
        }
        case 'unit_revise': {
          const { unit_id: unitId, base_version_id: baseId } = input as JobInput['unit_revise'];
          const latest = latestVersionOf(state, unitId);
          if (latest && latest.id !== baseId) {
            // The same guard the database has: a draft can only be based on the latest version.
            throw Object.assign(
              new Error('A newer version of this unit exists. Reload the page and try again.'),
              { code: 'stale_base' },
            );
          }
          return saveDraft(unitId, result as EngineResult['unit_revise']);
        }
        default: {
          const never: never = job.kind;
          throw new Error(`demo: unknown job kind ${String(never)}`);
        }
      }
    },
  };
}
