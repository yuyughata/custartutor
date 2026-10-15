/**
 * @custar/supabase: generated database types for the CUSTAR Tutor Supabase project (types only).
 *
 * `database.types.ts` is generated; regenerate it after EVERY migration (see
 * supabase/migrations/README.md). Everything else in this file is hand-written and mirrors CHECK
 * constraints and RPC behaviour that the generator cannot express (it types them as plain strings).
 */
import type { Database, Tables } from './database.types';

export type {
  CompositeTypes,
  Database,
  Enums,
  Json,
  Tables,
  TablesInsert,
  TablesUpdate,
} from './database.types';
export { Constants } from './database.types';

// RPC helpers -------------------------------------------------------------------------------------
type PublicFunctions = Database['public']['Functions'];

/** Names of the callable RPCs, e.g. `supabase.rpc('create_invite', ...)`. */
export type RpcName = keyof PublicFunctions;
export type RpcArgs<N extends RpcName> = PublicFunctions[N]['Args'];
export type RpcReturns<N extends RpcName> = PublicFunctions[N]['Returns'];

/**
 * The generator types RETURNS TABLE columns as non-null. `locked_until` is NULL when the PIN is not
 * locked, so use this type for `get_grownup_pin_status()` rows.
 */
export type GrownupPinStatus = {
  has_pin: boolean;
  locked_until: string | null;
  failed_attempts: number;
};

// Row aliases -------------------------------------------------------------------------------------
export type Child = Tables<'children'>;
export type Household = Tables<'households'>;
export type HouseholdMember = Tables<'household_members'>;
export type ChildAccess = Tables<'child_access'>;
export type Consent = Tables<'consents'>;
export type Level = Tables<'levels'>;
export type Subject = Tables<'subjects'>;
export type Chapter = Tables<'chapters'>;
export type Unit = Tables<'units'>;
export type UnitVersion = Tables<'unit_versions'>;
export type PublishedUnit = Tables<'published_units'>;
export type ProgressEvent = Tables<'progress_events'>;
export type UnitProgress = Tables<'unit_progress'>;
export type AppSetting = Tables<'app_settings'>;
/**
 * A content-engine job as a client may read it: `input`, `state`, `lease_token`, `params` and `idempotency_key`
 * are not granted to any API role (column privileges), so a `select` must name exactly these columns. The same
 * shape is what `create_ai_job` and `cancel_ai_job` return.
 */
export type AiJob = Pick<
  Tables<'ai_jobs'>,
  | 'id'
  | 'kind'
  | 'status'
  | 'progress'
  | 'result'
  | 'error'
  | 'attempts'
  | 'lease_until'
  | 'unit_id'
  | 'scheme_id'
  | 'created_by'
  | 'created_at'
  | 'updated_at'
  | 'finished_at'
>;
/** The columns of {@link AiJob}, for `select(AI_JOB_COLUMNS)`. */
export const AI_JOB_COLUMNS =
  'id,kind,status,progress,result,error,attempts,lease_until,unit_id,scheme_id,created_by,created_at,updated_at,finished_at';

// Column domains (mirror the CHECK constraints) --------------------------------------------------
export type AdminRole = 'super_admin' | 'content_editor' | 'reviewer' | 'support' | 'analyst';
export type HouseholdRole = 'guardian' | 'tutor';
export type MemberStatus = 'active' | 'removed';
export type ReadingMode = 'reader' | 'pre_reader';
export type LevelCode = 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6';
export type Stage = 'absorb' | 'connect' | 'express';
export type SubjectKind = 'core' | 'elective' | 'extracurricular';
export type CurriculumSource = 'nerdc' | 'global';
export type SchemeStatus = 'draft' | 'approved' | 'archived';
export type SchemeWeekKind =
  'teaching' | 'mid_term_exam' | 'break' | 'revision' | 'exam' | 'closing';
/** Status of `chapters` and `units`. `published` is reachable only through publish_unit_version. */
export type ContentStatus = 'draft' | 'published' | 'archived';
export type UnitKind = 'lesson' | 'mini_project' | 'term_project' | 'revision' | 'assessment';
export type UnitVersionStatus = 'draft' | 'in_review' | 'approved' | 'published' | 'superseded';
export type GeneratedBy = 'ai' | 'human';
export type ConsentAction = 'grant' | 'withdraw';
export type AiJobKind = 'scheme_ingest' | 'chapter_plan' | 'unit_generate' | 'unit_revise';
export type AiJobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
/** `ai_usage.task`: which model role made the call. */
export type AiTask = 'authoring' | 'tutor' | 'moderation';
/** The keys `app_settings` accepts (CHECK constraint); `set_app_setting` validates the value of each by shape. */
export type AppSettingKey =
  'ai.models' | 'ai.kill_switch' | 'ai.budget' | 'ai.prices' | 'ai.effort' | 'ai.prompt_version';
export type ProgressEventType =
  | 'unit_started'
  | 'section_completed'
  | 'question_answered'
  | 'mastery_check_completed'
  | 'unit_completed';
/** What the server stores in `unit_progress.status` (the device also computes `locked` / `available`). */
export type StoredUnitProgressStatus = 'in_progress' | 'mastered';
/** `reason` of a rejected row in the result of `ingest_progress_events` (a stable machine code). */
export type IngestRejectReason =
  | 'invalid_payload'
  | 'no_access_to_child'
  | 'child_deleted'
  | 'unknown_unit'
  | 'inconsistent_mastery'
  | 'rate_limited'
  | 'internal_error';

// Stable error messages raised by RPCs, triggers and guards (PostgREST `error.message`) -------------
export type DbErrorMessage =
  // generic
  | 'not_authenticated'
  | 'elevation_required'
  | 'not_a_guardian'
  | 'admin_role_required'
  // households, invites, tutors
  | 'invalid_household_name'
  | 'household_limit_reached'
  | 'invalid_role'
  | 'invalid_ttl'
  | 'guardian_invite_takes_no_children'
  | 'tutor_invite_needs_children'
  | 'unknown_child'
  | 'too_many_pending_invites'
  | 'invite_invalid'
  | 'invite_used'
  | 'invite_expired'
  | 'invite_children_unavailable'
  | 'already_guardian'
  | 'member_not_found'
  | 'last_guardian'
  | 'child_not_found'
  | 'tutor_not_in_household'
  | 'children_identity_immutable'
  // PIN and elevation
  | 'invalid_pin_format'
  | 'weak_pin'
  | 'pin_not_set'
  | 'invalid_device_id'
  // publishing and the review workflow
  | 'unit_version_not_found'
  | 'unit_version_not_approved'
  | 'unit_version_superseded'
  | 'unit_version_content_empty'
  | 'unit_version_older_than_current'
  | 'unit_not_publishable'
  | 'chapter_unit_count_invalid'
  | 'unit_version_must_start_as_draft'
  | 'unit_version_immutable'
  | 'unit_version_provenance_immutable'
  | 'approved_version_is_frozen'
  | 'reviewer_required'
  | 'use_publish_unit_version'
  | 'published_units_are_immutable'
  // sync, progress and packs
  | 'invalid_events'
  | 'batch_too_large'
  | 'invalid_cursor'
  | 'invalid_pack_request'
  | 'not_a_household_member'
  | 'pack_not_found'
  | 'published_unit_not_found'
  | 'invalid_pack_path'
  | 'invalid_content_hash'
  | 'pack_info_already_set'
  // content engine: jobs, settings, usage
  | 'kill_switch'
  | 'too_many_jobs'
  | 'job_not_found'
  | 'idempotency_key_reused'
  | 'invalid_idempotency_key'
  | 'invalid_job_kind'
  | 'invalid_job_input'
  | 'invalid_job_params'
  | 'unit_id_required'
  | 'scheme_id_required'
  | 'invalid_lease_seconds'
  | 'invalid_step'
  | 'invalid_progress'
  | 'invalid_usage'
  | 'invalid_setting_key'
  | 'invalid_setting_value'
  | 'invalid_range'
  // content engine: schemes, chapter plans, unit versions
  | 'unit_not_found'
  | 'scheme_not_found'
  | 'subject_not_found'
  | 'invalid_term'
  | 'invalid_level'
  | 'invalid_source_note'
  | 'invalid_scheme_weeks'
  | 'scheme_not_draft'
  | 'scheme_not_approved'
  | 'scheme_has_no_teaching_weeks'
  | 'invalid_chapter_plan'
  | 'duplicate_chapter_no'
  | 'duplicate_unit_no'
  | 'unknown_scheme_week'
  | 'unit_has_versions'
  | 'chapter_not_draft'
  // content engine: the unit layout (units added, removed and reordered by hand)
  | 'invalid_unit_layout'
  | 'invalid_layout_unit'
  | 'duplicate_unit_in_layout'
  | 'unit_not_in_scheme'
  | 'chapter_not_in_scheme'
  | 'chapter_order_changed'
  | 'layout_out_of_date'
  | 'layout_renumbers_versioned_units'
  | 'published_unit_cannot_move'
  | 'invalid_generated_by'
  | 'invalid_unit_content'
  | 'unit_content_too_large'
  | 'invalid_lint_report'
  | 'invalid_ai_provenance'
  | 'unit_not_editable'
  | 'stale_base'
  | 'invalid_status'
  | 'illegal_status_move';
