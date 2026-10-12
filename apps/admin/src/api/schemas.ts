// Zod schemas for everything the live adapter reads from the server. Every response crosses this boundary
// before the rest of the app sees it; a mismatch becomes a typed `bad_response` error, never a crash later.
import { z } from 'zod';
import { AiSettings, CastTraits, JobRow, type Json } from '@custar/authoring-core';
import { LevelCode, Stage, UnitKind, WeekKind } from '@custar/content-schema';
import { badResponse } from './errors';

export function parseResponse<T>(schema: z.ZodType<T>, data: unknown, what: string): T {
  const result = schema.safeParse(data);
  if (!result.success) throw badResponse(what, result.error);
  return result.data;
}

/** A number that PostgREST may send as a string (bigint and numeric columns). */
export const numeric = z.union([
  z.number(),
  z
    .string()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);

const nullableNumeric = numeric.nullable().optional();
const Id = z.string().min(1);
const Iso = z.string().min(1);
const TermNumberSchema = z.union([z.literal(1), z.literal(2), z.literal(3)]);
const SchemeStatusSchema = z.enum(['draft', 'approved', 'archived']);
const VersionStatusSchema = z.enum(['draft', 'in_review', 'approved', 'published', 'superseded']);
const ContentStatusSchema = z.enum(['draft', 'published', 'archived']);

export const SubjectRow = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  sort: z.number(),
});
export const LevelRow = z.object({ code: LevelCode, name: z.string(), sort: z.number() });

export const SchemeListRow = z.object({
  id: Id,
  subject_id: Id,
  level_code: LevelCode,
  term: TermNumberSchema,
  status: SchemeStatusSchema,
  source_note: z.string().nullable(),
  created_at: Iso,
  scheme_weeks: z.array(z.object({ week_no: z.number(), kind: z.string() })).default([]),
});
export type SchemeListRow = z.infer<typeof SchemeListRow>;

export const SchemeDetailRow = SchemeListRow.extend({
  scheme_weeks: z
    .array(
      z.object({
        week_no: z.number().int(),
        kind: WeekKind,
        topic: z
          .string()
          .nullable()
          .transform((value) => value ?? ''),
        subtopics: z
          .array(z.string())
          .nullable()
          .transform((value) => value ?? []),
      }),
    )
    .default([]),
});
export type SchemeDetailRow = z.infer<typeof SchemeDetailRow>;

const UnitVersionStub = z.object({
  id: Id,
  version: z.number().int(),
  status: VersionStatusSchema,
});

export const UnitRowSchema = z.object({
  id: Id,
  chapter_id: Id,
  unit_no: z.number().int(),
  week_no: z.number().int().nullable(),
  kind: UnitKind,
  title: z.string(),
  objective: z.string().nullable(),
  stage: Stage,
  periods: z.number().int(),
  status: ContentStatusSchema,
  deleted_at: z.string().nullable().optional(),
});

export const ChapterListRow = z.object({
  id: Id,
  scheme_id: Id,
  number: z.number().int(),
  title: z.string(),
  status: ContentStatusSchema,
  deleted_at: z.string().nullable().optional(),
  units: z
    .array(UnitRowSchema.extend({ unit_versions: z.array(UnitVersionStub).default([]) }))
    .default([]),
});
export type ChapterListRow = z.infer<typeof ChapterListRow>;

export const UnitContextRow = UnitRowSchema.extend({
  chapters: z.object({
    id: Id,
    number: z.number().int(),
    title: z.string(),
    scheme_id: Id,
    schemes: z.object({
      id: Id,
      level_code: LevelCode,
      term: TermNumberSchema,
      status: SchemeStatusSchema,
      subject_id: Id,
      subjects: z.object({ id: Id, slug: z.string(), name: z.string() }),
    }),
  }),
});
export type UnitContextRow = z.infer<typeof UnitContextRow>;

export const UnitVersionSummaryRow = z.object({
  id: Id,
  unit_id: Id,
  version: z.number().int(),
  schema_version: z.number().int(),
  status: VersionStatusSchema,
  generated_by: z.enum(['ai', 'human']),
  model: z.string().nullable(),
  prompt_version: z.string().nullable(),
  lint_report: z.unknown().nullable().default(null),
  base_version_id: Id.nullable(),
  created_by: Id.nullable(),
  created_at: Iso,
});

export const UnitVersionFullRow = UnitVersionSummaryRow.extend({
  content: z.custom<Json>((value) => value !== undefined),
});

export const PublishedUnitRow = z.object({
  id: Id,
  unit_id: Id,
  version_no: z.number().int(),
  is_current: z.boolean(),
  content_hash: z.string().nullable(),
  pack_manifest_path: z.string().nullable(),
  pack_built_at: z.string().nullable(),
  published_at: Iso,
});

export const ReviewItemRow = z.object({
  id: Id,
  version: z.number().int(),
  status: VersionStatusSchema,
  created_at: Iso,
  units: z.object({ id: Id, unit_no: z.number().int(), title: z.string() }),
});
export type ReviewItemRow = z.infer<typeof ReviewItemRow>;

export const CharacterRow = z.object({
  id: Id,
  slug: z.string(),
  name: z.string(),
  traits: z.record(z.string(), z.unknown()).pipe(CastTraits),
  voice: z.record(
    z.string(),
    z.custom<Json>((value) => value !== undefined),
  ),
  active: z.boolean(),
});

/** `ai_jobs` as clients read it. A freshly queued job may have an empty `progress`; that is not an error. */
export const JobRowLoose = JobRow.extend({
  progress: z
    .object({
      done: z.array(z.string()).default([]),
      next: z.string().nullable().default(null),
      total: z.number().int().default(0),
    })
    .default({ done: [], next: null, total: 0 }),
  attempts: z.number().int().nonnegative().default(0),
  error: JobRow.shape.error.default(null),
});

export const JobSummaryRow = JobRowLoose.omit({ result: true });

export const AiJobResponseSchema = z.object({ job: JobRowLoose, busy: z.boolean().optional() });

export const AdminUserRow = z.object({
  role: z.enum(['super_admin', 'content_editor', 'reviewer', 'support', 'analyst']),
});

export const ApplyPlanSchema = z.object({ chapters: numeric, units: numeric });

export const ApplyLayoutSchema = z.object({
  chapters: numeric,
  units: numeric,
  units_created: numeric,
  units_updated: numeric,
  units_moved: numeric,
  units_renumbered: numeric,
  units_archived: numeric,
  chapters_created: numeric,
  created_unit_ids: z.array(z.string()).default([]),
  created_chapter_ids: z.array(z.string()).default([]),
  layout: z
    .array(
      z.object({
        chapter_id: Id,
        number: z.number().int(),
        title: z.string(),
        units: z.array(z.object({ id: Id, unit_no: z.number().int() })),
      }),
    )
    .default([]),
});

export const PublishedSnapshotRow = z.object({
  id: Id,
  version_no: z.number().int(),
  is_current: z.boolean(),
  published_at: Iso,
  content: z.custom<Json>((value) => value !== undefined && value !== null),
});

export const CreatedVersionSchema = z.object({ id: Id, version: z.number().int() });

export const PackResultSchema = z.object({
  published_unit_id: Id,
  unit_id: Id.optional(),
  version_no: z.number().int().optional(),
  manifest_path: z.string(),
  content_hash: z.string().min(1),
  already_built: z.boolean(),
  files: z.number().int().optional(),
});

const UsageBucketBase = {
  calls: numeric.default(0),
  input_tokens: numeric.default(0),
  output_tokens: numeric.default(0),
  cache_read_tokens: numeric.default(0),
  cache_creation_tokens: numeric.default(0),
  est_cost_usd: nullableNumeric.transform((value) => value ?? null),
  unpriced_calls: numeric.default(0),
};

export const UsageSummarySchema = z.object({
  totals: z
    .object({
      ...UsageBucketBase,
      jobs_by_status: z.record(z.string(), numeric).default({}),
      jobs: z.record(z.string(), numeric).optional(),
    })
    .transform(({ jobs, jobs_by_status, ...rest }) => ({
      ...rest,
      jobs_by_status: Object.keys(jobs_by_status).length > 0 ? jobs_by_status : (jobs ?? {}),
    })),
  by_day: z.array(z.object({ ...UsageBucketBase, day: z.string() })).default([]),
  by_model: z.array(z.object({ ...UsageBucketBase, model: z.string() })).default([]),
  by_kind: z.array(z.object({ ...UsageBucketBase, kind: z.string() })).default([]),
});

export const AiSettingsSchema = AiSettings;

export const UuidResult = z.string().min(1);
