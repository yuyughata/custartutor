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
import { AdminApiError, fromPostgrest, toAdminError } from '../api/errors';
import { validateJobParams } from '../api/jobParams';
import type {
  AdminApi,
  AdminJobs,
  ApplyLayoutResult,
  ApplyPlanResult,
  ChapterRow,
  HomeSummary,
  JobListFilter,
  JobSummary,
  PackResult,
  PublishedSnapshot,
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
import { LayoutRefusal, planLayout, type LayoutModel, type LayoutPlan } from '../lib/unitLayout';
import { DEMO_USER_ID, createDemoAuth } from './demoAuth';
import { createDemoJobHooks, type DemoJobHooks } from './jobHooks';
import { chapterOf, latestVersionOf, schemeOf, versionsOf } from './queries';
import { createDemoState, type DemoScheme, type DemoState } from './state';
import { createDemoJobApi, type DemoJobApi } from './engine';

export type DemoJobApiFactory = (
  hooks: DemoJobHooks,
  options: { stepDelayMs?: number },
) => DemoJobApi;

export interface DemoOptions {
  /** Builds the job API. The default wires the in-memory job API to the stand-in model (demo/engine.ts). */
  jobApiFactory?: DemoJobApiFactory;
  now?: () => Date;
  newId?: () => string;
  state?: DemoState;
  initialRole?: AdminRole;
  /** How long each step of a job waits, so progress is visible. Tests pass 0. */
  stepDelayMs?: number;
}

export type DemoAdminApi = AdminApi & { readonly state: DemoState };

function forbidden(): AdminApiError {
  return new AdminApiError(
    'forbidden',
    'admin_role_required',
    'Your role is not allowed to do this. Ask a super admin if you need access.',
    403,
  );
}

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
  const rawJobs = (options.jobApiFactory ?? createDemoJobApi)(hooks, {
    ...(options.stepDelayMs !== undefined ? { stepDelayMs: options.stepDelayMs } : {}),
  });
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
    if (!can(role(), capability)) throw forbidden();
  }

  // --- jobs ---------------------------------------------------------------------------------------

  const created: string[] = [];
  const keys = new Map<string, string>();

  /** Everything the job client throws becomes an AdminApiError, like the live adapter. */
  async function typed<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      throw toAdminError(error);
    }
  }

  /** Every job row, newest first, without the role check (the usage panel is for analysts too). */
  async function allJobRows(): Promise<JobRow[]> {
    const rows = await Promise.all(created.map((id) => rawJobs.get(id)));
    return rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  const jobs: AdminJobs = {
    create(
      kind: JobKind,
      params: Record<string, unknown>,
      idempotencyKey?: string,
    ): Promise<JobRow> {
      return typed(async () => {
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
            throw conflict(
              'scheme_not_approved',
              'The scheme must be approved before chapters can be planned.',
            );
          }
        }
        if (kind === 'unit_generate') {
          const unitId = (checked as { unit_id: string }).unit_id;
          if (!state.units.some((candidate) => candidate.id === unitId)) {
            throw notFound('not_found', 'That unit no longer exists.');
          }
        }
        if (kind === 'unit_revise') {
          const versionId = (checked as { unit_version_id: string }).unit_version_id;
          const version = state.versions.find((candidate) => candidate.id === versionId);
          if (!version) throw notFound('unit_version_not_found', 'That version no longer exists.');
          if (latestVersionOf(state, version.unit_id)?.id !== version.id) {
            throw conflict(
              'stale_base',
              'A newer version of this unit exists. Reload the page and try again.',
            );
          }
        }
        const row = await rawJobs.create(kind, checked, idempotencyKey);
        created.push(row.id);
        if (idempotencyKey) keys.set(idempotencyKey, row.id);
        return row;
      });
    },
    step(jobId: string): Promise<AiJobResponse> {
      return typed(async () => {
        needs('job.start');
        try {
          return await rawJobs.step(jobId);
        } finally {
          syncUsage();
        }
      });
    },
    get(jobId: string): Promise<JobRow> {
      return typed(async () => {
        needs('content.view');
        const row = await rawJobs.get(jobId);
        syncUsage();
        return row;
      });
    },
    cancel(jobId: string): Promise<JobRow> {
      return typed(async () => {
        needs('job.start');
        return rawJobs.cancel(jobId);
      });
    },
    list(filter: JobListFilter = {}): Promise<JobSummary[]> {
      return typed(async () => {
        needs('content.view');
        const rows = await allJobRows();
        return rows
          .filter((row) => !filter.kind || row.kind === filter.kind)
          .filter((row) => !filter.status || filter.status.includes(row.status))
          .filter((row) => !filter.unitId || row.unit_id === filter.unitId)
          .filter((row) => !filter.schemeId || row.scheme_id === filter.schemeId)
          .slice(0, filter.limit ?? 50)
          .map(({ result: _result, ...summary }) => summary);
      });
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

  function addToBucket(
    bucket: UsageBucket,
    record: UsageBucket & { priced: boolean; cost: number | null },
  ): void {
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
            units: state.units.filter((unit) => unit.status !== 'archived').length,
            versionsInReview: inReview.length,
            versionsReadyToPublish: approved.length,
            jobsRunning: active.filter((job) => job.status === 'running' || job.status === 'queued')
              .length,
            jobsFailed: active.filter((job) => job.status === 'failed').length,
          },
          schemesAwaitingApproval: state.schemes
            .filter((scheme) => scheme.status === 'draft')
            .map(schemeSummary),
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
          throw new AdminApiError(
            'invalid',
            'invalid_weeks',
            'The server rejected the weeks table. Check each row.',
            400,
          );
        }
        const seen = new Set<number>();
        for (const week of parsed.data) {
          if (seen.has(week.week_no)) {
            throw new AdminApiError(
              'invalid',
              'invalid_weeks',
              `Week ${week.week_no} appears twice.`,
              400,
            );
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
          throw conflict(
            'scheme_not_draft',
            'This scheme is already approved, so it can no longer be replaced.',
          );
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
          throw conflict(
            'scheme_not_draft',
            'This scheme is already approved, so it can no longer be replaced.',
          );
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
              .filter((unit) => unit.chapter_id === chapter.id && unit.status !== 'archived')
              .sort((a, b) => a.unit_no - b.unit_no)
              .map((unit) => unitRow(unit.id)),
          }));
      },
      async applyPlan(schemeId, plan): Promise<ApplyPlanResult> {
        needs('plan.apply');
        const scheme = findScheme(schemeId);
        if (scheme.status !== 'approved') {
          throw conflict(
            'scheme_not_approved',
            'The scheme must be approved before chapters can be planned.',
          );
        }
        const parsed = ChapterPlan.safeParse(plan);
        if (!parsed.success) {
          throw new AdminApiError(
            'invalid',
            'invalid_plan',
            'The server rejected the chapter plan. Check each chapter.',
            400,
          );
        }
        if (
          parsed.data.chapters.some(
            (chapter) => chapter.units.length < 3 || chapter.units.length > 5,
          )
        ) {
          throw new AdminApiError(
            'invalid',
            'chapter_unit_count_invalid',
            'Every chapter needs 3 to 5 units.',
            400,
          );
        }
        // Refuse before changing anything: a unit that already has a version cannot be re-planned.
        for (const planned of parsed.data.chapters.flatMap((chapter, index) =>
          chapter.units.map((unit) => ({ chapterNo: index + 1, unit })),
        )) {
          const chapter = state.chapters.find(
            (candidate) =>
              candidate.scheme_id === scheme.id && candidate.number === planned.chapterNo,
          );
          const unit = chapter
            ? state.units.find(
                (candidate) =>
                  candidate.chapter_id === chapter.id && candidate.unit_no === planned.unit.unit_no,
              )
            : undefined;
          if (unit && versionsOf(state, unit.id).length > 0) {
            throw conflict(
              'unit_has_versions',
              'A unit in this plan already has a draft version, so its plan cannot be changed here.',
            );
          }
        }
        // Units the plan no longer contains: without a version they go (as on the server), with one the apply is refused.
        const inPlan = (unit: (typeof state.units)[number]): boolean =>
          parsed.data.chapters.some((planned, index) => {
            const chapter = state.chapters.find(
              (candidate) => candidate.scheme_id === scheme.id && candidate.number === index + 1,
            );
            return (
              chapter !== undefined &&
              chapter.id === unit.chapter_id &&
              planned.units.some((plannedUnit) => plannedUnit.unit_no === unit.unit_no)
            );
          });
        const schemeChapterIds = new Set(
          state.chapters.filter((candidate) => candidate.scheme_id === scheme.id).map((c) => c.id),
        );
        const dropped = state.units.filter(
          (unit) => schemeChapterIds.has(unit.chapter_id) && !inPlan(unit),
        );
        if (dropped.some((unit) => versionsOf(state, unit.id).length > 0)) {
          throw conflict(
            'unit_has_versions',
            'A unit in this plan already has a draft version, so its plan cannot be changed here.',
          );
        }
        let units = 0;
        parsed.data.chapters.forEach((planned, index) => {
          const number = index + 1;
          let chapter = state.chapters.find(
            (candidate) => candidate.scheme_id === scheme.id && candidate.number === number,
          );
          if (!chapter) {
            chapter = {
              id: newId(),
              scheme_id: scheme.id,
              number,
              title: planned.title,
              status: 'draft',
            };
            state.chapters.push(chapter);
          }
          chapter.title = planned.title;
          if (planned.theme) chapter.theme = planned.theme;
          else delete chapter.theme;
          for (const plannedUnit of planned.units) {
            units += 1;
            const found = state.units.find(
              (candidate) =>
                candidate.chapter_id === chapter.id && candidate.unit_no === plannedUnit.unit_no,
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
        for (const unit of dropped) {
          const at = state.units.indexOf(unit);
          if (at >= 0) state.units.splice(at, 1);
        }
        return { chapters: parsed.data.chapters.length, units };
      },
      async applyLayout(schemeId, layout, options): Promise<ApplyLayoutResult> {
        needs('layout.apply');
        const scheme = findScheme(schemeId);
        if (scheme.status !== 'approved') {
          throw conflict('scheme_not_approved', 'The scheme must be approved before chapters can be planned.');
        }
        const chapters = state.chapters.filter((chapter) => chapter.scheme_id === scheme.id);
        const live = state.units.filter(
          (unit) => unit.status !== 'archived' && chapters.some((chapter) => chapter.id === unit.chapter_id),
        );
        const model: LayoutModel = {
          chapters: chapters.map((chapter) => ({ id: chapter.id, number: chapter.number, title: chapter.title })),
          units: live.map((unit) => ({
            id: unit.id,
            chapter_id: unit.chapter_id,
            unit_no: unit.unit_no,
            title: unit.title,
            objective: unit.objective ?? '',
            kind: unit.kind,
            stage: unit.stage,
            periods: unit.periods,
            week_no: unit.week_no,
            hasVersions: versionsOf(state, unit.id).length > 0,
            published: state.published.some((entry) => entry.unit_id === unit.id),
          })),
          weeks: scheme.weeks.map((week) => week.week_no),
        };
        let plan: LayoutPlan;
        try {
          plan = planLayout(model, layout, { confirmRenumber: options?.confirmRenumber === true });
        } catch (error) {
          if (error instanceof LayoutRefusal) {
            // The same typed error the live adapter makes from the server's message (and DETAIL).
            throw fromPostgrest(
              { message: error.code, ...(error.detail ? { details: JSON.stringify(error.detail) } : {}) },
              'The layout was refused.',
            );
          }
          throw error;
        }
        const createdUnitIds: string[] = [];
        const createdChapterIds: string[] = [];
        if (plan.changes) {
          const chapterIds: string[] = [];
          for (const planned of plan.chapters) {
            if (planned.id !== null) {
              chapterIds.push(planned.id);
              continue;
            }
            const created = {
              id: newId(),
              scheme_id: scheme.id,
              number: planned.number,
              title: planned.title,
              status: 'draft' as const,
            };
            state.chapters.push(created);
            chapterIds.push(created.id);
            createdChapterIds.push(created.id);
          }
          // Removed units are archived (kept, number parked), never deleted.
          for (const id of plan.archived) {
            const unit = state.units.find((candidate) => candidate.id === id);
            if (!unit) continue;
            const parked = state.units
              .filter((other) => other.chapter_id === unit.chapter_id && other.unit_no >= 10000)
              .reduce((max, other) => Math.max(max, other.unit_no), 9999);
            unit.status = 'archived';
            unit.unit_no = parked + 1;
          }
          plan.chapters.forEach((planned, index) => {
            const chapterId = chapterIds[index] as string;
            for (const entry of planned.units) {
              const { lens: _lens, ...fields } = entry.fields;
              if (entry.id !== null) {
                const unit = state.units.find((candidate) => candidate.id === entry.id);
                if (unit) Object.assign(unit, fields, { chapter_id: chapterId, unit_no: entry.unit_no });
              } else {
                const unit = {
                  id: newId(),
                  chapter_id: chapterId,
                  unit_no: entry.unit_no,
                  week_no: fields.week_no ?? null,
                  kind: fields.kind ?? 'lesson',
                  title: fields.title ?? '',
                  objective: fields.objective ?? null,
                  stage: fields.stage ?? 'absorb',
                  periods: fields.periods ?? 1,
                  status: 'draft' as const,
                };
                state.units.push(unit);
                createdUnitIds.push(unit.id);
              }
            }
          });
        }
        const layoutOut = state.chapters
          .filter((chapter) => chapter.scheme_id === scheme.id)
          .sort((a, b) => a.number - b.number)
          .map((chapter) => ({
            chapter_id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            units: state.units
              .filter((unit) => unit.chapter_id === chapter.id && unit.status !== 'archived')
              .sort((a, b) => a.unit_no - b.unit_no)
              .map((unit) => ({ id: unit.id, unit_no: unit.unit_no })),
          }));
        return {
          chapters: layoutOut.length,
          units: layoutOut.reduce((sum, chapter) => sum + chapter.units.length, 0),
          ...plan.counts,
          created_unit_ids: createdUnitIds,
          created_chapter_ids: createdChapterIds,
          layout: layoutOut,
        };
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
          chapter: {
            id: chapter.id,
            number: chapter.number,
            title: chapter.title,
            scheme_id: chapter.scheme_id,
          },
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
            throw new AdminApiError(
              'forbidden',
              'reviewer_required',
              'Only a reviewer or a super admin can approve a version.',
              403,
            );
          }
        } else {
          throw conflict(
            'illegal_status_move',
            'That status change is not allowed from the version’s current status.',
          );
        }
        version.status = status;
      },
      async publishVersion(versionId) {
        needs('version.publish');
        const version = findVersion(versionId);
        if (version.status === 'superseded') {
          throw conflict(
            'unit_version_superseded',
            'That version has been replaced by a newer one.',
          );
        }
        if (version.status !== 'approved') {
          throw conflict('unit_version_not_approved', 'Only an approved version can be published.');
        }
        const unit = state.units.find((candidate) => candidate.id === version.unit_id);
        if (!unit) throw notFound('not_found', 'That unit no longer exists.');
        const chapter = chapterOf(state, unit);
        const count = state.units.filter(
          (candidate) => candidate.chapter_id === chapter.id && candidate.status !== 'archived',
        ).length;
        if (count < 3 || count > 5) {
          throw new AdminApiError(
            'invalid',
            'chapter_unit_count_invalid',
            'Every chapter needs 3 to 5 units.',
            400,
          );
        }
        const current = state.published.find(
          (entry) => entry.unit_id === unit.id && entry.is_current,
        );
        if (current && current.version_no >= version.version) {
          throw conflict(
            'unit_version_older_than_current',
            'A newer version of this unit is already published.',
          );
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
        if (!entry)
          throw notFound('published_unit_not_found', 'That published unit no longer exists.');
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
      async publishedHistory(unitId): Promise<PublishedSnapshot[]> {
        needs('content.view');
        return state.published
          .filter((entry) => entry.unit_id === unitId)
          .sort((a, b) => a.version_no - b.version_no)
          .map((entry) => ({
            id: entry.id,
            version_no: entry.version_no,
            is_current: entry.is_current,
            published_at: entry.published_at,
            content: structuredClone(findVersion(entry.unit_version_id).content),
          }));
      },
      async saveHumanVersion(input) {
        needs('unit.edit');
        const unit = state.units.find((candidate) => candidate.id === input.unitId);
        if (!unit) throw notFound('unit_not_found', 'That unit no longer exists.');
        if (unit.status === 'archived') {
          throw conflict('unit_not_editable', 'This unit was removed from its chapter, so it cannot get new versions.');
        }
        const content = input.content as { schema_version?: unknown; header?: unknown } | null;
        if (
          typeof content !== 'object' ||
          content === null ||
          typeof content.header !== 'object' ||
          content.header === null ||
          typeof content.schema_version !== 'number'
        ) {
          throw fromPostgrest({ message: 'invalid_unit_content' }, 'The server did not accept that content.');
        }
        const latest = latestVersionOf(state, unit.id);
        if ((input.baseVersionId ?? null) !== (latest?.id ?? null)) {
          throw conflict('stale_base', 'A newer version of this unit exists. Reload the page and try again.');
        }
        const created = {
          id: newId(),
          unit_id: unit.id,
          version: (latest?.version ?? 0) + 1,
          schema_version: content.schema_version,
          status: 'draft' as const,
          generated_by: 'human' as const,
          model: null,
          prompt_version: null,
          lint_report: structuredClone(input.lintReport) as unknown,
          base_version_id: input.baseVersionId,
          created_by: DEMO_USER_ID,
          created_at: now().toISOString(),
          content: structuredClone(input.content),
        };
        state.versions.push(created);
        return { id: created.id, version: created.version };
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
          throw new AdminApiError(
            'invalid',
            'invalid_traits',
            'The server rejected those traits. Check the age and gender.',
            400,
          );
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
          throw new AdminApiError(
            'invalid',
            'invalid_request',
            `The server rejected the value for ${key}.`,
            400,
          );
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
        for (const job of await allJobRows()) {
          jobsByStatus[job.status] = (jobsByStatus[job.status] ?? 0) + 1;
        }
        return {
          totals: { ...totals, jobs_by_status: jobsByStatus },
          by_day: [...byDay]
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([day, bucket]) => ({ day, ...bucket })),
          by_model: [...byModel].map(([model, bucket]) => ({ model, ...bucket })),
          by_kind: [...byKind].map(([kind, bucket]) => ({ kind, ...bucket })),
        };
      },
    },

    jobs,
  };

  return api;
}
