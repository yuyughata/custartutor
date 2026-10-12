// Client-side check of job params before anything is sent (live) or run (demo). The contract's Zod schemas are
// the single definition; the edge function validates again, this just fails early with readable messages.
import {
  ChapterPlanParams,
  SchemeIngestParams,
  UnitGenerateParams,
  UnitReviseParams,
  type JobKind,
  type JobParams,
} from '@custar/authoring-core';
import type { z } from 'zod';
import { AdminApiError } from './errors';

const SCHEMAS: { [K in JobKind]: z.ZodType<JobParams[K]> } = {
  scheme_ingest: SchemeIngestParams,
  chapter_plan: ChapterPlanParams,
  unit_generate: UnitGenerateParams,
  unit_revise: UnitReviseParams,
};

export function validateJobParams<K extends JobKind>(kind: K, params: unknown): JobParams[K] {
  const schema = SCHEMAS[kind] as z.ZodType<JobParams[K]>;
  const result = schema.safeParse(params);
  if (result.success) return result.data;
  const first = result.error.issues[0];
  const where = first && first.path.length > 0 ? ` (${first.path.join('.')})` : '';
  throw new AdminApiError(
    'invalid',
    'invalid_request',
    `The job request is not valid${where}: ${first?.message ?? 'unknown problem'}.`,
    undefined,
    result.error,
  );
}
