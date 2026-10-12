// The demo AdminApi: an in-memory store seeded with sample data, the same rules the server applies (status
// moves, roles, 3 to 5 units per chapter, draft-only scheme replacement) and the in-memory job API wired to a
// STAND-IN model. Nothing here is Claude and nothing is persisted: a reload starts over.
import { z } from 'zod';
import {
  AiSettings,
  CastTraits,
  LlmModels,
  estimateCostUsd,
  type AiJobResponse,
  type AppSettingKey,
  type JobKind,
  type JobRow,
  type Json,
} from '@custar/authoring-core';
import { ChapterPlan } from '@custar/authoring-core';
import { SchemeWeek } from '@custar/content-schema';
import { AdminApiError } from '../api/errors';
import { validateJobParams } from '../api/jobParams';
import type {
  AdminApi,
  AdminJobs,
  ApplyPlanResult,
  ChapterRow,
  HomeSummary,
  JobListFilter,
  JobSummary,
  PackResult,
  ReviewItem,
  SchemeDetail,
  SchemeSummary,
  UnitContext,
  UnitRow,
  UnitVersionFull,
  UnitVersionSummary,
  UsageBucket,
  UsageSummary,
  UsageRange,
} from '../api/types';
import { can, type AdminRole, type Capability } from '../lib/roles';
import { createDemoAuth } from './demoAuth';
import { createDemoJobHooks, type DemoJobHooks } from './jobHooks';
import { chapterOf, schemeOf, versionsOf } from './queries';
import { createDemoState, type DemoScheme, type DemoState } from './state';
import { createDemoJobApi, type DemoJobApi } from './engine';

export type DemoJobApiFactory = (hooks: DemoJobHooks) => DemoJobApi;

export interface DemoOptions {
  /** Builds the job API. The default wires the in-memory job API to the stand-in model (demo/engine.ts). */
  jobApiFactory?: DemoJobApiFactory;
  now?: () => Date;
  newId?: () => string;
  state?: DemoState;
  initialRole?: AdminRole;
}

export type DemoAdminApi = AdminApi & { readonly state: DemoState };

const FORBIDDEN = new AdminApiError(
  'forbidden',
  'admin_role_required',
  'Your role is not allowed to do this. Ask a super admin if you need access.',
  403,
);

function conflict(code: string, message: string): AdminApiError {
  return new AdminApiError('conflict', code, message, 409);
}

function notFound(code: string, message: string): AdminApiError {
  return new AdminApiError('not_found', code, message, 404);
}

function emptyBucket(): UsageBucket {
  return {
    calls: 0,
    input_tokens: 0,
    output_tokens: 0,
    cache_read_tokens: 0,
    cache_creation_tokens: 0,
    est_cost_usd: null,
    unpriced_calls: 0,
  };
}

export function createDemoAdminApi(options: DemoOptions = {}): DemoAdminApi {
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? (() => crypto.randomUUID());
  const state = options.state ?? createDemoState(now());
  const { auth, role } = createDemoAuth(options.initialRole);
  // Uploaded PDFs live in memory so the job engine can read them back, like the private storage bucket.
  const uploads = new Map<string, Uint8Array>();
  const hooks = createDemoJobHooks(state, {
    newId,
    now,
    async loadUpload(path) {
      const bytes = uploads.get(path);
      if (!bytes) throw new Error(`No upload at ${path}`);
      return { bytes, mime: 'application/pdf' };
    },
  });
  const rawJobs = (options.jobApiFactory ?? createDemoJobApi)(hooks);
  let usageSeen = 0;

  /** The in-memory job API does not time-stamp its usage log, so new calls are stamped when first seen. */
  function syncUsage(): void {
    const all = rawJobs.usage?.() ?? [];
    for (; usageSeen < all.length; usageSeen += 1) {
      const record = all[usageSeen];
      if (!record) continue;
      const kind = record.label.split(':')[0] as JobKind;
      state.usage.push({ at: now().toISOString(), job_id: '', kind, record });
    }
  }

  function needs(capability: Capability): void {
    if (!can(role(), capability)) throw FORBIDDEN;
  }

  // --- jobs ---------------------------------------------------------------------------------------

  const created: string[] = [];
  const keys = new Map<string, string>();

  const jobs: AdminJobs = {
    async create(kind: JobKind, params: Record<string, unknown>, idempotencyKey?: string): Promise<JobRow> {
      needs('job.start');
      const checked = validateJobParams(kind, params) as Record<string, unknown>;
      if (idempotencyKey) {
        const known = keys.get(idempotencyKey);
        if (known) return rawJobs.get(known);
      }
      if (kind === 'chapter_plan') {
        const schemeId = (checked as { scheme_id: string }).scheme_id;
        const scheme = state.schemes.find((candidate) => candidate.id === schemeId);
        if (!scheme) throw notFound('scheme_not_found', 'That scheme no longer exists.');
        if (scheme.status !== 'approved') {
          throw conflict('scheme_not_approved', 'The scheme must be approved before chapters can be planned.');
        }
      }
      if (kind === 'unit_generate') {
        const unitId = (checked as { unit_id: string }).unit_id;
        if (!state.units.some((candidate) => candidate.id === unitId)) {
          throw notFound('not_found', 'That unit no longer exists.');
        }
      }
      const row = await rawJobs.create(kind, checked, idempotencyKey);
      created.push(row.id);
      if (idempotencyKey) keys.set(idempotencyKey, row.id);
      return row;
    },
    async step(jobId: string): Promise<AiJobResponse> {
      needs('job.start');
      try {
        return await rawJobs.step(jobId);
      } finally {
        syncUsage();
      }
    },
    async get(jobId: string): Promise<JobRow> {
      needs('content.view');
      const row = await rawJobs.get(jobId);
      syncUsage();
      return row;
    },
    async cancel(jobId: string): Promise<JobRow> {
      needs('job.start');
      return rawJobs.cancel(jobId);
    },
    async list(filter: JobListFilter = {}): Promise<JobSummary[]> {
      needs('content.view');
      const rows = await Promise.all(created.map((id) => rawJobs.get(id)));
      return rows
        .filter((row) => !filter.kind || row.kind === filter.kind)
        .filter((row) => !filter.status || filter.status.includes(row.status))
        .filter((row) => !filter.unitId || row.unit_id === filter.unitId)
        .filter((row) => !filter.schemeId || row.scheme_id === filter.schemeId)
        .sort((a, b) => b.created_at.localeCompare(a.created_at))
        .slice(0, filter.limit ?? 50)
        .map(({ result: _result, ...summary }) => summary);
    },
  };

  // --- helpers ------------------------------------------------------------------------------------

  function schemeSummary(scheme: DemoScheme): SchemeSummary {
    return {
      id: scheme.id,
      subject_id: scheme.subject_id,
      level_code: scheme.level_code,
      term: scheme.term,
      status: scheme.status,
      source_note: scheme.source_note,
      created_at: scheme.created_at,
      week_count: scheme.weeks.length,
      teaching_week_count: scheme.weeks.filter((week) => week.kind === 'teaching').length,
    };
  }

  function unitRow(unitId: string): UnitRow {
    const unit = state.units.find((candidate) => candidate.id === unitId);
    if (!unit) throw notFound('not_found', 'That unit no longer exists.');
    const versions = versionsOf(state, unit.id);
    const latest = versions[0];
    return {
      ...unit,
      version_count: versions.length,
      latest_version: latest?.version ?? null,
      latest_version_status: latest?.status ?? null,
    };
  }

  function reviewItem(version: UnitVersionFull): ReviewItem {
    const unit = state.units.find((candidate) => candidate.id === version.unit_id);
    return {
      version_id: version.id,
      version: version.version,
      status: version.status,
      unit_id: version.unit_id,
      unit_no: unit?.unit_no ?? 0,
      unit_title: unit?.title ?? 'Unit',
      created_at: version.created_at,
    };
  }

  function summaryOfVersion(version: UnitVersionFull): UnitVersionSummary {
    const { content: _content, ...rest } = version;
    return rest;
  }

  function findVersion(versionId: string): UnitVersionFull {
    const version = state.versions.find((candidate) => candidate.id === versionId);
    if (!version) throw notFound('unit_version_not_found', 'That version no longer exists.');
    return version;
  }

  function findScheme(schemeId: string): DemoScheme {
    const scheme = state.schemes.find((candidate) => candidate.id === schemeId);
    if (!scheme) throw notFound('scheme_not_found', 'That scheme no longer exists.');
    return scheme;
  }

  function addToBucket(bucket: UsageBucket, record: UsageBucket & { priced: boolean; cost: number | null }): void {
    bucket.calls += record.calls;
    bucket.input_tokens += record.input_tokens;
    bucket.output_tokens += record.output_tokens;
    bucket.cache_read_tokens += record.cache_read_tokens;
    bucket.cache_creation_tokens += record.cache_creation_tokens;
    if (record.cost !== null) bucket.est_cost_usd = (bucket.est_cost_usd ?? 0) + record.cost;
    else bucket.unpriced_calls += 1;
  }

  // --- the port -----------------------------------------------------------------------------------

  const api: DemoAdminApi = {
    mode: 'demo',
    state,
    auth,

    catalog: {
      async subjects() {
        return state.subjects.map((subject) => ({ ...subject }));
      },
      async levels() {
        return state.levels.map((level) => ({ ...level }));
      },
    },

    home: {
      async summary(): Promise<HomeSummary> {
        needs('content.view');
        const active = await jobs.list({ status: ['queued', 'running', 'failed'], limit: 20 });
        const inReview = state.versions.filter((version) => version.status === 'in_review');
        const approved = state.versions.filter((version) => version.status === 'approved');
        return {
          counts: {
            schemes: state.schemes.length,
            schemesApproved: state.schemes.filter((scheme) => scheme.status === 'approved').length,
            units: state.units.length,
            versionsInReview: inReview.length,
            versionsReadyToPublish: approved.length,
            jobsRunning: active.filter((job) => job.status === 'running' || job.status === 'queued').length,
            jobsFailed: active.filter((job) => job.status === 'failed').length,
          },
          schemesAwaitingApproval: state.schemes.filter((scheme) => scheme.status === 'draft').map(schemeSummary),
          versionsInReview: inReview.map(reviewItem),
          versionsReadyToPublish: approved.map(reviewItem),
          jobsNeedingAttention: active,
        };
      },
    },

    schemes: {
      async list() {
        needs('content.view');
        return [...state.schemes]
          .sort((a, b) => b.created_at.localeCompare(a.created_at))
          .map(schemeSummary);
      },
      async get(schemeId): Promise<SchemeDetail> {
        needs('content.view');
        const scheme = findScheme(schemeId);
        return {
          ...schemeSummary(scheme),
          weeks: scheme.weeks.map((week) => ({ ...week, subtopics: [...week.subtopics] })),
        };
      },
      async uploadPdf(file) {
        needs('job.start');
        // Kept in memory only, so the engine can read it back. The stand-in model does not understand PDFs.
        const path = `demo-user/${newId()}-${file.name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
        uploads.set(path, new Uint8Array(file.data));
        return { path };
      },
      async saveDraft(input) {
        needs('scheme.save');
        const parsed = z.array(SchemeWeek).min(1).safeParse(input.weeks);
        if (!parsed.success) {
          throw new AdminApiError('invalid', 'invalid_weeks', 'The server rejected the weeks table. Check each row.', 400);
        }
        const seen = new Set<number>();
        for (const week of parsed.data) {
          if (seen.has(week.week_no)) {
            throw new AdminApiError('invalid', 'invalid_weeks', `Week ${week.week_no} appears twice.`, 400);
          }
          seen.add(week.week_no);
        }
        const existing = state.schemes.find(
          (scheme) =>
            scheme.subject_id === input.subjectId &&
            scheme.level_code === input.levelCode &&
            scheme.term === input.term,
        );
        if (existing && existing.status !== 'draft') {
          throw conflict('scheme_not_draft', 'This scheme is already approved, so it can no longer be replaced.');
        }
        if (existing) {
          existing.weeks = parsed.data;
          existing.source_note = input.sourceNote;
          return { schemeId: existing.id };
        }
        const scheme: DemoScheme = {
          id: newId(),
          subject_id: input.subjectId,
          level_code: input.levelCode,
          term: input.term,
          status: 'draft',
          source_note: input.sourceNote,
          created_at: now().toISOString(),
          weeks: parsed.data,
        };
        state.schemes.push(scheme);
        return { schemeId: scheme.id };
      },
      async approve(schemeId) {
        needs('scheme.approve');
        const scheme = findScheme(schemeId);
        if (scheme.status !== 'draft') {
          throw conflict('scheme_not_draft', 'This scheme is already approved, so it can no longer be replaced.');
        }
        if (!scheme.weeks.some((week) => week.kind === 'teaching')) {
          throw new AdminApiError(
            'invalid',
            'scheme_needs_teaching_week',
            'A scheme needs at least one teaching week before it can be approved.',
            400,
          );
        }
        scheme.status = 'approved';
      },
    },

    chapters: {
      async list(schemeId): Promise<ChapterRow[]> {
        needs('content.view');
        return state.chapters
          .filter((chapter) => chapter.scheme_id === schemeId)
          .sort((a, b) => a.number - b.number)
          .map((chapter) => ({
            id: chapter.id,
            scheme_id: chapter.scheme_id,
            number: chapter.number,
            title: chapter.title,
            status: chapter.status,
            units: state.units
              .filter((unit) => unit.chapter_id === chapter.id)
              .sort((a, b) => a.unit_no - b.unit_no)
              .map((unit) => unitRow(unit.id)),
          }));
      },
      async applyPlan(schemeId, plan): Promise<ApplyPlanResult> {
        needs('plan.apply');
        const scheme = findScheme(schemeId);
        if (scheme.status !== 'approved') {
          throw conflict('scheme_not_approved', 'The scheme must be approved before chapters can be planned.');
        }
        const parsed = ChapterPlan.safeParse(plan);
        if (!parsed.success) {
          throw new AdminApiError('invalid', 'invalid_plan', 'The server rejected the chapter plan. Check each chapter.', 400);
        }
        if (parsed.data.chapters.some((chapter) => chapter.units.length < 3 || chapter.units.length > 5)) {
          throw new AdminApiError('invalid', 'chapter_unit_count_invalid', 'Every chapter needs 3 to 5 units.', 400);
        }
        // Refuse before changing anything: a unit that already has a version cannot be re-planned.
        for (const planned of parsed.data.chapters.flatMap((chapter, index) =>
          chapter.units.map((unit) => ({ chapterNo: index + 1, unit })),
        )) {
          const chapter = state.chapters.find(
            (candidate) => candidate.scheme_id === scheme.id && candidate.number === planned.chapterNo,
          );
          const unit = chapter
            ? state.units.find((candidate) => candidate.chapter_id === chapter.id && candidate.unit_no === planned.unit.unit_no)
            : undefined;
          if (unit && versionsOf(state, unit.id).length > 0) {
            throw conflict(
              'unit_has_versions',
              'A unit in this plan already has a draft version, so its plan cannot be changed here.',
            );
          }
        }
        let units = 0;
        parsed.data.chapters.forEach((planned, index) => {
          const number = index + 1;
          let chapter = state.chapters.find(
            (candidate) => candidate.scheme_id === scheme.id && candidate.number === number,
          );
          if (!chapter) {
            chapter = { id: newId(), scheme_id: scheme.id, number, title: planned.title, status: 'draft' };
            state.chapters.push(chapter);
          }
          chapter.title = planned.title;
          if (planned.theme) chapter.theme = planned.theme;
          else delete chapter.theme;
          for (const plannedUnit of planned.units) {
            units += 1;
            const found = state.units.find(
              (candidate) => candidate.chapter_id === chapter.id && candidate.unit_no === plannedUnit.unit_no,
            );
            const fields = {
              week_no: plannedUnit.week_no,
              kind: plannedUnit.kind,
              title: plannedUnit.title,
              objective: plannedUnit.objective,
              stage: plannedUnit.stage,
              periods: plannedUnit.periods,
            };
            if (found) Object.assign(found, fields);
            else {
              state.units.push({
                id: newId(),
                chapter_id: chapter.id,
                unit_no: plannedUnit.unit_no,
                status: 'draft',
                ...fields,
              });
            }
          }
        });
        return { chapters: parsed.data.chapters.length, units };
      },
    },

    units: {
      async get(unitId): Promise<UnitContext> {
        needs('content.view');
        const unit = state.units.find((candidate) => candidate.id === unitId);
        if (!unit) throw notFound('not_found', 'That unit no longer exists.');
        const chapter = chapterOf(state, unit);
        const scheme = schemeOf(state, chapter);
        const subject = state.subjects.find((candidate) => candidate.id === scheme.subject_id);
        if (!subject) throw notFound('not_found', 'That subject no longer exists.');
        return {
          unit: { ...unit },
          chapter: { id: chapter.id, number: chapter.number, title: chapter.title, scheme_id: chapter.scheme_id },
          scheme: {
            id: scheme.id,
            level_code: scheme.level_code,
            term: scheme.term,
            status: scheme.status,
            subject_id: scheme.subject_id,
          },
          subject: { id: subject.id, slug: subject.slug, name: subject.name },
        };
      },
      async versions(unitId) {
        needs('content.view');
        return versionsOf(state, unitId).map(summaryOfVersion);
      },
      async version(versionId) {
        needs('content.view');
        return structuredClone(findVersion(versionId));
      },
      async setVersionStatus(versionId, status) {
        const version = findVersion(versionId);
        const from = version.status;
        if (from === 'draft' && status === 'in_review') {
          needs('version.submit');
        } else if (from === 'in_review' && (status === 'approved' || status === 'draft')) {
          if (!can(role(), 'version.review')) {
            throw new AdminApiError('forbidden', 'reviewer_required', 'Only a reviewer or a super admin can approve a version.', 403);
          }
        } else {
          throw conflict('illegal_status_move', 'That status change is not allowed from the version’s current status.');
        }
        version.status = status;
      },
      async publishVersion(versionId) {
        needs('version.publish');
        const version = findVersion(versionId);
        if (version.status === 'superseded') {
          throw conflict('unit_version_superseded', 'That version has been replaced by a newer one.');
        }
        if (version.status !== 'approved') {
          throw conflict('unit_version_not_approved', 'Only an approved version can be published.');
        }
        const unit = state.units.find((candidate) => candidate.id === version.unit_id);
        if (!unit) throw notFound('not_found', 'That unit no longer exists.');
        const chapter = chapterOf(state, unit);
        const count = state.units.filter((candidate) => candidate.chapter_id === chapter.id).length;
        if (count < 3 || count > 5) {
          throw new AdminApiError('invalid', 'chapter_unit_count_invalid', 'Every chapter needs 3 to 5 units.', 400);
        }
        const current = state.published.find((entry) => entry.unit_id === unit.id && entry.is_current);
        if (current && current.version_no >= version.version) {
          throw conflict('unit_version_older_than_current', 'A newer version of this unit is already published.');
        }
        if (current) {
          current.is_current = false;
          const old = state.versions.find((candidate) => candidate.id === current.unit_version_id);
          if (old) old.status = 'superseded';
        }
        version.status = 'published';
        unit.status = 'published';
        chapter.status = 'published';
        const publishedUnitId = newId();
        state.published.push({
          id: publishedUnitId,
          unit_id: unit.id,
          unit_version_id: version.id,
          version_no: version.version,
          is_current: true,
          content_hash: null,
          pack_manifest_path: null,
          pack_built_at: null,
          published_at: now().toISOString(),
        });
        return { publishedUnitId };
      },
      async buildPack(publishedUnitId): Promise<PackResult> {
        needs('version.publish');
        const entry = state.published.find((candidate) => candidate.id === publishedUnitId);
        if (!entry) throw notFound('published_unit_not_found', 'That published unit no longer exists.');
        // Demo mode builds nothing: this only records that the step was reached.
        return {
          published_unit_id: entry.id,
          content_hash: 'demo-no-pack-built',
          manifest_path: '(demo: no pack built)',
          already_built: false,
          files: null,
          demo: true,
        };
      },
      async publication(versionId) {
        needs('content.view');
        const entry = state.published.find((candidate) => candidate.unit_version_id === versionId);
        if (!entry) return null;
        const { unit_version_id: _unused, ...info } = entry;
        return info;
      },
    },

    characters: {
      async list() {
        needs('content.view');
        return structuredClone(state.characters);
      },
      async save(character) {
        needs('characters.edit');
        const index = state.characters.findIndex((candidate) => candidate.id === character.id);
        if (index < 0) throw notFound('not_found', 'That character no longer exists.');
        const traits = CastTraits.safeParse(character.traits);
        if (!traits.success) {
          throw new AdminApiError('invalid', 'invalid_traits', 'The server rejected those traits. Check the age and gender.', 400);
        }
        if (character.name.trim() === '') {
          throw new AdminApiError('invalid', 'invalid_name', 'A character needs a name.', 400);
        }
        const saved = structuredClone({ ...character, traits: traits.data });
        state.characters[index] = saved;
        return structuredClone(saved);
      },
    },

    settings: {
      async get() {
        needs('settings.view');
        return structuredClone(state.settings);
      },
      async set(key: AppSettingKey, value: Json) {
        needs('settings.edit');
        const reject = (): never => {
          throw new AdminApiError('invalid', 'invalid_request', `The server rejected the value for ${key}.`, 400);
        };
        switch (key) {
          case 'ai.models': {
            const parsed = LlmModels.safeParse(value);
            if (!parsed.success) return reject();
            state.settings.models = parsed.data;
            break;
          }
          case 'ai.kill_switch': {
            const parsed = z.boolean().safeParse(value);
            if (!parsed.success) return reject();
            state.settings.kill_switch = parsed.data;
            break;
          }
          case 'ai.budget': {
            const parsed = AiSettings.shape.budget.safeParse(value);
            if (!parsed.success) return reject();
            state.settings.budget = parsed.data;
            break;
          }
          case 'ai.prices': {
            const parsed = AiSettings.shape.prices.safeParse(value);
            if (!parsed.success) return reject();
            state.settings.prices = parsed.data;
            break;
          }
          case 'ai.effort': {
            const parsed = AiSettings.shape.effort.safeParse(value);
            if (!parsed.success) return reject();
            state.settings.effort = parsed.data;
            break;
          }
          case 'ai.prompt_version': {
            const parsed = AiSettings.shape.prompt_version.safeParse(value);
            if (!parsed.success) return reject();
            state.settings.prompt_version = parsed.data;
            break;
          }
          default:
            return reject();
        }
      },
    },

    usage: {
      async summary(range: UsageRange): Promise<UsageSummary> {
        needs('usage.view');
        syncUsage();
        const from = Date.parse(range.from);
        const to = Date.parse(range.to);
        const inRange = state.usage.filter((entry) => {
          const at = Date.parse(entry.at);
          return at >= from && at < to;
        });
        const totals = emptyBucket();
        const byDay = new Map<string, UsageBucket>();
        const byModel = new Map<string, UsageBucket>();
        const byKind = new Map<string, UsageBucket>();
        const bucketFor = (map: Map<string, UsageBucket>, key: string): UsageBucket => {
          let bucket = map.get(key);
          if (!bucket) {
            bucket = emptyBucket();
            map.set(key, bucket);
          }
          return bucket;
        };
        for (const entry of inRange) {
          const cost = estimateCostUsd(entry.record, state.settings.prices);
          const one = {
            calls: 1,
            input_tokens: entry.record.input_tokens,
            output_tokens: entry.record.output_tokens,
            cache_read_tokens: entry.record.cache_read_tokens,
            cache_creation_tokens: entry.record.cache_creation_tokens,
            est_cost_usd: cost,
            unpriced_calls: 0,
            priced: cost !== null,
            cost,
          };
          addToBucket(totals, one);
          addToBucket(bucketFor(byDay, entry.at.slice(0, 10)), one);
          addToBucket(bucketFor(byModel, entry.record.model), one);
          addToBucket(bucketFor(byKind, entry.kind), one);
        }
        const jobsByStatus: Record<string, number> = {};
        for (const job of await jobs.list({ limit: 200 })) {
          jobsByStatus[job.status] = (jobsByStatus[job.status] ?? 0) + 1;
        }
        return {
          totals: { ...totals, jobs_by_status: jobsByStatus },
          by_day: [...byDay].sort(([a], [b]) => a.localeCompare(b)).map(([day, bucket]) => ({ day, ...bucket })),
          by_model: [...byModel].map(([model, bucket]) => ({ model, ...bucket })),
          by_kind: [...byKind].map(([kind, bucket]) => ({ kind, ...bucket })),
        };
      },
    },

    jobs,
  };

  return api;
}
