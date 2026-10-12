// The live AdminApi: PostgREST reads, the m2-plan RPCs (exact `p_` names), Storage uploads and the `ai-job` /
// `publish-pack` edge functions. Every response is validated with Zod before the screens see it.
//
// UNVERIFIED against the real project (the sandbox cannot reach *.supabase.co): it is tested with a fake
// supabase-js client that records calls (supabaseAdminApi.test.ts). The RPC names and argument names follow
// docs/m2-plan.md and supabase/migrations/README.md; reconcile them with the final migrations.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { z } from 'zod';
import type { AiJobResponse, JobKind, JobRow } from '@custar/authoring-core';
import {
  AdminApiError,
  badResponse,
  fromEdgeFunction,
  fromNetwork,
  fromPostgrest,
  type PostgrestLike,
} from './errors';
import { validateJobParams } from './jobParams';
import {
  AiJobResponseSchema,
  AiSettingsSchema,
  ApplyPlanSchema,
  CharacterRow,
  ChapterListRow,
  JobRowLoose,
  JobSummaryRow,
  LevelRow,
  PackResultSchema,
  PublishedUnitRow,
  ReviewItemRow,
  SchemeDetailRow,
  SchemeListRow,
  SubjectRow,
  UnitContextRow,
  UnitVersionFullRow,
  UnitVersionSummaryRow,
  UsageSummarySchema,
  UuidResult,
  parseResponse,
} from './schemas';
import { createSupabaseAuth } from './supabaseAuth';
import type {
  AdminApi,
  AdminJobs,
  ChapterRow,
  HomeSummary,
  JobListFilter,
  JobSummary,
  ReviewItem,
  SchemeSummary,
  UnitContext,
  UnitVersionFull,
  UnitVersionSummary,
} from './types';

export const SCHEME_UPLOAD_BUCKET = 'scheme-uploads';

export interface LiveOptions {
  /** Project URL, for the edge functions. */
  url: string;
  /** The PUBLISHABLE key: the only key the admin app ever holds. */
  publishableKey: string;
  fetch?: typeof fetch;
  randomId?: () => string;
}

// ai_jobs without `input` and `state` (column-level grants keep those server-side).
const JOB_COLUMNS =
  'id,kind,status,progress,lease_until,attempts,error,result,unit_id,scheme_id,created_by,created_at,updated_at,finished_at';
const JOB_SUMMARY_COLUMNS = JOB_COLUMNS.replace(',result', '');

const SCHEME_COLUMNS = 'id,subject_id,level_code,term,status,source_note,created_at';
const UNIT_COLUMNS =
  'id,chapter_id,unit_no,week_no,kind,title,objective,stage,periods,status,deleted_at';
const VERSION_COLUMNS =
  'id,unit_id,version,schema_version,status,generated_by,model,prompt_version,lint_report,base_version_id,created_by,created_at';
const CHARACTER_COLUMNS = 'id,slug,name,traits,voice,active';

interface QueryResult<T> {
  data: T | null;
  error: PostgrestLike | null;
  count?: number | null;
}

function unwrap<T>(result: QueryResult<T>, fallback: string): T | null {
  if (result.error) throw fromPostgrest(result.error, fallback);
  return result.data;
}

function listOf<T>(result: QueryResult<T[]>, fallback: string): T[] {
  return unwrap(result, fallback) ?? [];
}

/** Storage keys: letters, digits, dot, dash, underscore. The display name travels separately in the job source. */
export function safeFileName(name: string): string {
  const cleaned = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/^[._]+/, '')
    .slice(-80);
  return cleaned === '' ? 'upload.pdf' : cleaned;
}

function toSchemeSummary(row: SchemeListRow): SchemeSummary {
  return {
    id: row.id,
    subject_id: row.subject_id,
    level_code: row.level_code,
    term: row.term,
    status: row.status,
    source_note: row.source_note,
    created_at: row.created_at,
    week_count: row.scheme_weeks.length,
    teaching_week_count: row.scheme_weeks.filter((week) => week.kind === 'teaching').length,
  };
}

function toReviewItem(row: ReviewItemRow): ReviewItem {
  return {
    version_id: row.id,
    version: row.version,
    status: row.status,
    unit_id: row.units.id,
    unit_no: row.units.unit_no,
    unit_title: row.units.title,
    created_at: row.created_at,
  };
}

export function createSupabaseAdminApi(supabase: SupabaseClient, options: LiveOptions): AdminApi {
  const fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const functionsUrl = `${options.url.replace(/\/+$/, '')}/functions/v1`;

  async function rpc<T>(
    name: string,
    args: Record<string, unknown>,
    schema: z.ZodType<T>,
    what: string,
  ): Promise<T> {
    const result = await supabase.rpc(name, args);
    if (result.error) throw fromPostgrest(result.error, `Could not ${what}.`);
    return parseResponse(schema, result.data, what);
  }

  async function rpcVoid(name: string, args: Record<string, unknown>, what: string): Promise<void> {
    const result = await supabase.rpc(name, args);
    if (result.error) throw fromPostgrest(result.error, `Could not ${what}.`);
  }

  async function accessToken(): Promise<string> {
    const { data, error } = await supabase.auth.getSession();
    if (error || !data.session) {
      throw new AdminApiError(
        'unauthenticated',
        'not_authenticated',
        'Your session has ended. Please sign in again.',
        401,
      );
    }
    return data.session.access_token;
  }

  async function callFunction(name: string, body: unknown): Promise<unknown> {
    const token = await accessToken();
    let response: Response;
    try {
      response = await fetchImpl(`${functionsUrl}/${name}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: options.publishableKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
    } catch (cause) {
      throw fromNetwork(cause);
    }
    const text = await response.text();
    let json: unknown = null;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    if (!response.ok) throw fromEdgeFunction(response.status, json);
    return json;
  }

  // --- jobs ---------------------------------------------------------------------------------------

  async function getJob(jobId: string): Promise<JobRow> {
    const result = await supabase.from('ai_jobs').select(JOB_COLUMNS).eq('id', jobId).maybeSingle();
    const row = unwrap(result as QueryResult<unknown>, 'Could not read the job.');
    if (!row) throw new AdminApiError('not_found', 'not_found', 'That job no longer exists.', 404);
    return parseResponse(JobRowLoose, row, 'the job') as JobRow;
  }

  const jobs: AdminJobs = {
    async create(kind: JobKind, params: Record<string, unknown>, idempotencyKey?: string) {
      const checked = validateJobParams(kind, params);
      const json = await callFunction('ai-job', {
        action: 'create',
        kind,
        params: checked,
        ...(idempotencyKey ? { idempotency_key: idempotencyKey } : {}),
      });
      return parseResponse(AiJobResponseSchema, json, 'the new job').job as JobRow;
    },
    async step(jobId: string): Promise<AiJobResponse> {
      const json = await callFunction('ai-job', { action: 'step', job_id: jobId });
      const parsed = parseResponse(AiJobResponseSchema, json, 'the job step');
      return {
        job: parsed.job as JobRow,
        ...(parsed.busy !== undefined ? { busy: parsed.busy } : {}),
      };
    },
    get: getJob,
    async cancel(jobId: string) {
      const json = await callFunction('ai-job', { action: 'cancel', job_id: jobId });
      return parseResponse(AiJobResponseSchema, json, 'the cancelled job').job as JobRow;
    },
    async list(filter: JobListFilter = {}): Promise<JobSummary[]> {
      let query = supabase
        .from('ai_jobs')
        .select(JOB_SUMMARY_COLUMNS)
        .order('created_at', { ascending: false })
        .limit(filter.limit ?? 50);
      if (filter.kind) query = query.eq('kind', filter.kind);
      if (filter.status && filter.status.length > 0) query = query.in('status', filter.status);
      if (filter.unitId) query = query.eq('unit_id', filter.unitId);
      if (filter.schemeId) query = query.eq('scheme_id', filter.schemeId);
      const rows = listOf(await query, 'Could not list jobs.');
      return rows.map((row) => parseResponse(JobSummaryRow, row, 'a job') as JobSummary);
    },
  };

  // --- schemes ------------------------------------------------------------------------------------

  async function listSchemes(): Promise<SchemeSummary[]> {
    const result = await supabase
      .from('schemes')
      .select(`${SCHEME_COLUMNS},scheme_weeks(week_no,kind)`)
      .order('created_at', { ascending: false });
    return listOf(result, 'Could not list schemes.').map((row) =>
      toSchemeSummary(parseResponse(SchemeListRow, row, 'a scheme')),
    );
  }

  // --- chapters and units -------------------------------------------------------------------------

  async function listChapters(schemeId: string): Promise<ChapterRow[]> {
    const result = await supabase
      .from('chapters')
      .select(
        `id,scheme_id,number,title,status,deleted_at,units(${UNIT_COLUMNS},unit_versions(id,version,status))`,
      )
      .eq('scheme_id', schemeId)
      .order('number', { ascending: true });
    return listOf(result, 'Could not list chapters.')
      .map((row) => parseResponse(ChapterListRow, row, 'a chapter'))
      .filter((chapter) => !chapter.deleted_at)
      .map((chapter) => ({
        id: chapter.id,
        scheme_id: chapter.scheme_id,
        number: chapter.number,
        title: chapter.title,
        status: chapter.status,
        units: chapter.units
          .filter((unit) => !unit.deleted_at)
          .sort((a, b) => a.unit_no - b.unit_no)
          .map((unit) => {
            const versions = [...unit.unit_versions].sort((a, b) => b.version - a.version);
            const latest = versions[0];
            return {
              id: unit.id,
              chapter_id: unit.chapter_id,
              unit_no: unit.unit_no,
              week_no: unit.week_no,
              kind: unit.kind,
              title: unit.title,
              objective: unit.objective,
              stage: unit.stage,
              periods: unit.periods,
              status: unit.status,
              version_count: versions.length,
              latest_version: latest?.version ?? null,
              latest_version_status: latest?.status ?? null,
            };
          }),
      }));
  }

  async function reviewQueue(status: 'in_review' | 'approved'): Promise<ReviewItem[]> {
    const result = await supabase
      .from('unit_versions')
      .select('id,version,status,created_at,units(id,unit_no,title)')
      .eq('status', status)
      .order('created_at', { ascending: false })
      .limit(50);
    return listOf(result, 'Could not read the review queue.').map((row) =>
      toReviewItem(parseResponse(ReviewItemRow, row, 'a version')),
    );
  }

  const api: AdminApi = {
    mode: 'live',
    auth: createSupabaseAuth(supabase),

    catalog: {
      async subjects() {
        const result = await supabase
          .from('subjects')
          .select('id,slug,name,sort')
          .eq('active', true)
          .is('deleted_at', null)
          .order('sort', { ascending: true });
        return listOf(result, 'Could not list subjects.').map((row) =>
          parseResponse(SubjectRow, row, 'a subject'),
        );
      },
      async levels() {
        const result = await supabase
          .from('levels')
          .select('code,name,sort')
          .is('deleted_at', null)
          .order('sort', { ascending: true });
        return listOf(result, 'Could not list levels.').map((row) =>
          parseResponse(LevelRow, row, 'a level'),
        );
      },
    },

    home: {
      async summary(): Promise<HomeSummary> {
        const [schemes, inReview, approved, activeJobs, unitCount] = await Promise.all([
          listSchemes(),
          reviewQueue('in_review'),
          reviewQueue('approved'),
          jobs.list({ status: ['queued', 'running', 'failed'], limit: 20 }),
          supabase
            .from('units')
            .select('id', { count: 'exact', head: true })
            .is('deleted_at', null),
        ]);
        if (unitCount.error) throw fromPostgrest(unitCount.error, 'Could not count units.');
        return {
          counts: {
            schemes: schemes.length,
            schemesApproved: schemes.filter((scheme) => scheme.status === 'approved').length,
            units: unitCount.count ?? 0,
            versionsInReview: inReview.length,
            versionsReadyToPublish: approved.length,
            jobsRunning: activeJobs.filter(
              (job) => job.status === 'running' || job.status === 'queued',
            ).length,
            jobsFailed: activeJobs.filter((job) => job.status === 'failed').length,
          },
          schemesAwaitingApproval: schemes.filter((scheme) => scheme.status === 'draft'),
          versionsInReview: inReview,
          versionsReadyToPublish: approved,
          jobsNeedingAttention: activeJobs,
        };
      },
    },

    schemes: {
      list: listSchemes,
      async get(schemeId) {
        const result = await supabase
          .from('schemes')
          .select(`${SCHEME_COLUMNS},scheme_weeks(week_no,kind,topic,subtopics)`)
          .eq('id', schemeId)
          .maybeSingle();
        const row = unwrap(result as QueryResult<unknown>, 'Could not read the scheme.');
        if (!row)
          throw new AdminApiError(
            'not_found',
            'scheme_not_found',
            'That scheme no longer exists.',
            404,
          );
        const parsed = parseResponse(SchemeDetailRow, row, 'the scheme');
        return {
          ...toSchemeSummary(parsed),
          weeks: [...parsed.scheme_weeks]
            .sort((a, b) => a.week_no - b.week_no)
            .map((week) => ({
              week_no: week.week_no,
              kind: week.kind,
              topic: week.topic,
              subtopics: week.subtopics,
            })),
        };
      },
      async uploadPdf(file) {
        const { data, error } = await supabase.auth.getSession();
        if (error || !data.session) {
          throw new AdminApiError(
            'unauthenticated',
            'not_authenticated',
            'Your session has ended. Please sign in again.',
            401,
          );
        }
        const path = `${data.session.user.id}/${randomId()}-${safeFileName(file.name)}`;
        const upload = await supabase.storage
          .from(SCHEME_UPLOAD_BUCKET)
          .upload(path, file.data, { contentType: 'application/pdf', upsert: false });
        if (upload.error) {
          const message = upload.error.message ?? '';
          if (/exceed|too large|maximum|payload/i.test(message)) {
            throw new AdminApiError(
              'invalid',
              'file_too_large',
              'That file is too large. The limit is 20 MB.',
              413,
              upload.error,
            );
          }
          throw fromPostgrest({ message }, 'Could not upload the file.');
        }
        return { path };
      },
      async saveDraft(input) {
        const schemeId = await rpc(
          'save_scheme_draft',
          {
            p_subject_id: input.subjectId,
            p_level_code: input.levelCode,
            p_term: input.term,
            p_weeks: input.weeks,
            p_source_note: input.sourceNote,
          },
          UuidResult,
          'save the scheme draft',
        );
        return { schemeId };
      },
      async approve(schemeId) {
        await rpcVoid('approve_scheme', { p_scheme_id: schemeId }, 'approve the scheme');
      },
    },

    chapters: {
      list: listChapters,
      async applyPlan(schemeId, plan) {
        const out = await rpc(
          'apply_chapter_plan',
          { p_scheme_id: schemeId, p_plan: plan },
          ApplyPlanSchema,
          'apply the chapter plan',
        );
        return { chapters: out.chapters, units: out.units };
      },
    },

    units: {
      async get(unitId): Promise<UnitContext> {
        const result = await supabase
          .from('units')
          .select(
            `${UNIT_COLUMNS},chapters(id,number,title,scheme_id,schemes(id,level_code,term,status,subject_id,subjects(id,slug,name)))`,
          )
          .eq('id', unitId)
          .maybeSingle();
        const row = unwrap(result as QueryResult<unknown>, 'Could not read the unit.');
        if (!row)
          throw new AdminApiError('not_found', 'not_found', 'That unit no longer exists.', 404);
        const parsed = parseResponse(UnitContextRow, row, 'the unit');
        return {
          unit: {
            id: parsed.id,
            chapter_id: parsed.chapter_id,
            unit_no: parsed.unit_no,
            week_no: parsed.week_no,
            kind: parsed.kind,
            title: parsed.title,
            objective: parsed.objective,
            stage: parsed.stage,
            periods: parsed.periods,
            status: parsed.status,
          },
          chapter: {
            id: parsed.chapters.id,
            number: parsed.chapters.number,
            title: parsed.chapters.title,
            scheme_id: parsed.chapters.scheme_id,
          },
          scheme: {
            id: parsed.chapters.schemes.id,
            level_code: parsed.chapters.schemes.level_code,
            term: parsed.chapters.schemes.term,
            status: parsed.chapters.schemes.status,
            subject_id: parsed.chapters.schemes.subject_id,
          },
          subject: parsed.chapters.schemes.subjects,
        };
      },
      async versions(unitId): Promise<UnitVersionSummary[]> {
        const result = await supabase
          .from('unit_versions')
          .select(VERSION_COLUMNS)
          .eq('unit_id', unitId)
          .order('version', { ascending: false });
        return listOf(result, 'Could not list versions.').map(
          (row) => parseResponse(UnitVersionSummaryRow, row, 'a version') as UnitVersionSummary,
        );
      },
      async version(versionId): Promise<UnitVersionFull> {
        const result = await supabase
          .from('unit_versions')
          .select(`${VERSION_COLUMNS},content`)
          .eq('id', versionId)
          .maybeSingle();
        const row = unwrap(result as QueryResult<unknown>, 'Could not read the version.');
        if (!row)
          throw new AdminApiError(
            'not_found',
            'unit_version_not_found',
            'That version no longer exists.',
            404,
          );
        return parseResponse(UnitVersionFullRow, row, 'the version') as UnitVersionFull;
      },
      async setVersionStatus(versionId, status) {
        await rpcVoid(
          'set_unit_version_status',
          { p_unit_version_id: versionId, p_status: status },
          'change the version status',
        );
      },
      async publishVersion(versionId) {
        const publishedUnitId = await rpc(
          'publish_unit_version',
          { p_unit_version_id: versionId },
          UuidResult,
          'publish the version',
        );
        return { publishedUnitId };
      },
      async buildPack(publishedUnitId) {
        const json = await callFunction('publish-pack', { published_unit_id: publishedUnitId });
        const parsed = parseResponse(PackResultSchema, json, 'the lesson pack');
        return {
          published_unit_id: parsed.published_unit_id,
          content_hash: parsed.content_hash,
          manifest_path: parsed.manifest_path,
          already_built: parsed.already_built,
          files: parsed.files ?? null,
        };
      },
      async publication(versionId) {
        const result = await supabase
          .from('published_units')
          .select(
            'id,unit_id,version_no,is_current,content_hash,pack_manifest_path,pack_built_at,published_at',
          )
          .eq('unit_version_id', versionId)
          .maybeSingle();
        const row = unwrap(result as QueryResult<unknown>, 'Could not read the publication.');
        return row ? parseResponse(PublishedUnitRow, row, 'the publication') : null;
      },
    },

    characters: {
      async list() {
        const result = await supabase
          .from('characters')
          .select(CHARACTER_COLUMNS)
          .order('name', { ascending: true });
        return listOf(result, 'Could not list characters.').map((row) =>
          parseResponse(CharacterRow, row, 'a character'),
        );
      },
      async save(character) {
        const result = await supabase
          .from('characters')
          .update({
            name: character.name,
            traits: character.traits,
            voice: character.voice,
            active: character.active,
          })
          .eq('id', character.id)
          .select(CHARACTER_COLUMNS)
          .single();
        const row = unwrap(result as QueryResult<unknown>, 'Could not save the character.');
        return parseResponse(CharacterRow, row, 'the saved character');
      },
    },

    settings: {
      async get() {
        return rpc('get_ai_settings', {}, AiSettingsSchema, 'read the AI settings');
      },
      async set(key, value) {
        await rpcVoid('set_app_setting', { p_key: key, p_value: value }, 'save the setting');
      },
    },

    usage: {
      async summary(range) {
        const parsed = await rpc(
          'get_ai_usage_summary',
          { p_from: range.from, p_to: range.to },
          UsageSummarySchema,
          'read the usage summary',
        );
        return parsed;
      },
    },

    jobs,
  };

  return api;
}

export { badResponse };
