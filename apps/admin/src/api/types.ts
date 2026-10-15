// The admin app's port: everything the screens call. Implementations are `createSupabaseAdminApi` (live) and
// `createDemoAdminApi` (demo, in memory). Screens never import supabase-js or the demo store.
import type {
  AiSettings,
  AppSettingKey,
  CastTraits,
  ChapterPlan,
  JobApi,
  JobKind,
  JobRow,
  Json,
  StoredLintReport,
} from '@custar/authoring-core';
import type { LevelCode, SchemeWeek, Stage, UnitKind } from '@custar/content-schema';
import type { AdminRole } from '../lib/roles';
import type { LayoutDoc } from '../lib/unitLayout';
import type { VersionStatus } from '../lib/workflow';

export type { AdminRole } from '../lib/roles';
export type TermNumber = 1 | 2 | 3;

// --- authentication -------------------------------------------------------------------------------

/** Where the sign-in has got to. The app only shows its screens at `ready`. */
export type AuthState =
  | { step: 'signed_out' }
  /** Signed in with the email code (aal1) and has a verified authenticator: ask for its code. */
  | { step: 'mfa_challenge'; email: string; factorId: string }
  /** Signed in with the email code (aal1) and has no authenticator yet: enrol one. */
  | { step: 'mfa_enrol'; email: string }
  /** aal2, but the account has no row in admin_users. */
  | { step: 'not_admin'; email: string }
  | { step: 'ready'; email: string; userId: string; role: AdminRole };

export interface TotpEnrolment {
  factorId: string;
  /** The shared secret, for typing into an authenticator app by hand. */
  secret: string;
  /** otpauth:// URI. */
  uri: string;
  /** An SVG data URI of the QR code, ready for an <Image>. */
  qrCode: string;
}

export interface AdminAuth {
  /** Reads the current session and works out the step. */
  state(): Promise<AuthState>;
  subscribe(listener: (state: AuthState) => void): () => void;
  /** Emails a 6-digit code to an existing user (never creates one). */
  sendCode(email: string): Promise<void>;
  verifyCode(email: string, code: string): Promise<AuthState>;
  startEnrolment(): Promise<TotpEnrolment>;
  /** Challenge and verify an authenticator code; on success the session is aal2. */
  verifyTotp(factorId: string, code: string): Promise<AuthState>;
  signOut(): Promise<void>;
  /** Demo mode only: switch the signed-in role to show role-gated buttons. */
  setDemoRole?(role: AdminRole): void;
}

// --- reference data -------------------------------------------------------------------------------

export interface Subject {
  id: string;
  slug: string;
  name: string;
  sort: number;
}

export interface Level {
  code: LevelCode;
  name: string;
  sort: number;
}

// --- schemes --------------------------------------------------------------------------------------

export type SchemeStatus = 'draft' | 'approved' | 'archived';

export interface SchemeSummary {
  id: string;
  subject_id: string;
  level_code: LevelCode;
  term: TermNumber;
  status: SchemeStatus;
  source_note: string | null;
  created_at: string;
  week_count: number;
  teaching_week_count: number;
}

export interface SchemeDetail extends SchemeSummary {
  weeks: SchemeWeek[];
}

export interface SaveSchemeDraftInput {
  subjectId: string;
  levelCode: LevelCode;
  term: TermNumber;
  weeks: SchemeWeek[];
  sourceNote: string;
}

/** A file chosen by the person, already read into memory. */
export interface UploadableFile {
  name: string;
  mimeType: string;
  size: number;
  data: ArrayBuffer;
}

// --- chapters and units ---------------------------------------------------------------------------

export type ContentStatus = 'draft' | 'published' | 'archived';

export interface UnitRow {
  id: string;
  chapter_id: string;
  unit_no: number;
  week_no: number | null;
  kind: UnitKind;
  title: string;
  objective: string | null;
  stage: Stage;
  periods: number;
  status: ContentStatus;
  version_count: number;
  latest_version: number | null;
  latest_version_status: VersionStatus | null;
}

export interface ChapterRow {
  id: string;
  scheme_id: string;
  number: number;
  title: string;
  status: ContentStatus;
  units: UnitRow[];
}

export interface ApplyPlanResult {
  chapters: number;
  units: number;
}

/** What apply_unit_layout returns: counts, the ids it created and the resulting layout. */
export interface ApplyLayoutResult {
  chapters: number;
  units: number;
  units_created: number;
  units_updated: number;
  units_moved: number;
  units_renumbered: number;
  units_archived: number;
  chapters_created: number;
  created_unit_ids: string[];
  created_chapter_ids: string[];
  layout: {
    chapter_id: string;
    number: number;
    title: string;
    units: { id: string; unit_no: number }[];
  }[];
}

/** One snapshot from the unit's published history (immutable; content staff can read all of them). */
export interface PublishedSnapshot {
  id: string;
  version_no: number;
  is_current: boolean;
  published_at: string;
  content: Json;
}

export interface SaveHumanVersionInput {
  unitId: string;
  content: Json;
  /** The deterministic lint of the saved content (no model review). */
  lintReport: StoredLintReport;
  /** The latest version the person loaded; null only for a unit without versions. */
  baseVersionId: string | null;
}

/** A unit with the chapter, scheme and subject around it, for the workspace header. */
export interface UnitContext {
  unit: Omit<UnitRow, 'version_count' | 'latest_version' | 'latest_version_status'>;
  chapter: { id: string; number: number; title: string; scheme_id: string };
  scheme: {
    id: string;
    level_code: LevelCode;
    term: TermNumber;
    status: SchemeStatus;
    subject_id: string;
  };
  subject: { id: string; slug: string; name: string };
}

export interface UnitVersionSummary {
  id: string;
  unit_id: string;
  version: number;
  schema_version: number;
  status: VersionStatus;
  generated_by: 'ai' | 'human';
  model: string | null;
  prompt_version: string | null;
  /** The stored report (StoredLintReport for AI drafts). Read with `buildLintView`. */
  lint_report: unknown;
  base_version_id: string | null;
  created_by: string | null;
  created_at: string;
}

export interface UnitVersionFull extends UnitVersionSummary {
  content: Json;
}

export interface PublishedInfo {
  id: string;
  unit_id: string;
  version_no: number;
  is_current: boolean;
  content_hash: string | null;
  pack_manifest_path: string | null;
  pack_built_at: string | null;
  published_at: string;
}

export interface PackResult {
  published_unit_id: string;
  content_hash: string;
  manifest_path: string;
  already_built: boolean;
  files: number | null;
  /** Demo mode: nothing was built or published; this only records the click. */
  demo?: true;
}

export interface ReviewItem {
  version_id: string;
  version: number;
  status: VersionStatus;
  unit_id: string;
  unit_no: number;
  unit_title: string;
  created_at: string;
}

// --- characters -----------------------------------------------------------------------------------

export interface CharacterRecord {
  id: string;
  slug: string;
  name: string;
  traits: CastTraits;
  /** Free-form; the editor edits `voice.notes` and leaves other keys alone. */
  voice: Record<string, Json>;
  active: boolean;
}

// --- usage and settings ---------------------------------------------------------------------------

export interface UsageBucket {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_creation_tokens: number;
  /** Null when no price was entered for the model(s): shown as "unknown", never 0. */
  est_cost_usd: number | null;
  /** Calls without a price (only when some calls were priced and some were not). */
  unpriced_calls: number;
}

export interface UsageSummary {
  totals: UsageBucket & { jobs_by_status: Record<string, number> };
  by_day: (UsageBucket & { day: string })[];
  by_model: (UsageBucket & { model: string })[];
  by_kind: (UsageBucket & { kind: string })[];
}

export interface UsageRange {
  /** ISO timestamps; `to` is exclusive. */
  from: string;
  to: string;
}

// --- jobs -----------------------------------------------------------------------------------------

export type JobSummary = Omit<JobRow, 'result'>;

export interface JobListFilter {
  kind?: JobKind;
  status?: JobRow['status'][];
  unitId?: string;
  schemeId?: string;
  limit?: number;
}

export interface AdminJobs extends JobApi {
  list(filter?: JobListFilter): Promise<JobSummary[]>;
}

// --- home -----------------------------------------------------------------------------------------

export interface HomeSummary {
  counts: {
    schemes: number;
    schemesApproved: number;
    units: number;
    versionsInReview: number;
    versionsReadyToPublish: number;
    jobsRunning: number;
    jobsFailed: number;
  };
  schemesAwaitingApproval: SchemeSummary[];
  versionsInReview: ReviewItem[];
  versionsReadyToPublish: ReviewItem[];
  /** Running and recently failed jobs. */
  jobsNeedingAttention: JobSummary[];
}

// --- the port ---------------------------------------------------------------------------------------

export interface AdminApi {
  readonly mode: 'demo' | 'live';
  readonly auth: AdminAuth;
  readonly catalog: {
    subjects(): Promise<Subject[]>;
    levels(): Promise<Level[]>;
  };
  readonly home: { summary(): Promise<HomeSummary> };
  readonly schemes: {
    list(): Promise<SchemeSummary[]>;
    get(schemeId: string): Promise<SchemeDetail>;
    /** Uploads a PDF to the private bucket; the job then references the returned path. */
    uploadPdf(file: UploadableFile): Promise<{ path: string }>;
    /** save_scheme_draft: creates or replaces the DRAFT scheme for (subject, level, term). Returns its id. */
    saveDraft(input: SaveSchemeDraftInput): Promise<{ schemeId: string }>;
    /** approve_scheme: draft -> approved. */
    approve(schemeId: string): Promise<void>;
  };
  readonly chapters: {
    list(schemeId: string): Promise<ChapterRow[]>;
    /** apply_chapter_plan: creates chapters and draft units. */
    applyPlan(schemeId: string, plan: ChapterPlan): Promise<ApplyPlanResult>;
    /**
     * apply_unit_layout: one atomic call that adds, removes (archives) and reorders units and sets their numbers.
     * Without `confirmRenumber` it refuses (`layout_renumbers_versioned_units`) when a unit that already has
     * versions would change number or chapter.
     */
    applyLayout(
      schemeId: string,
      layout: LayoutDoc,
      options?: { confirmRenumber?: boolean },
    ): Promise<ApplyLayoutResult>;
  };
  readonly units: {
    get(unitId: string): Promise<UnitContext>;
    versions(unitId: string): Promise<UnitVersionSummary[]>;
    version(versionId: string): Promise<UnitVersionFull>;
    /** set_unit_version_status. Publishing is not a status move: use publishVersion. */
    setVersionStatus(versionId: string, status: 'draft' | 'in_review' | 'approved'): Promise<void>;
    /** publish_unit_version: approved -> published snapshot. Returns the published unit id. */
    publishVersion(versionId: string): Promise<{ publishedUnitId: string }>;
    /** The publish-pack edge function: builds the lesson pack of a published snapshot. */
    buildPack(publishedUnitId: string): Promise<PackResult>;
    publication(versionId: string): Promise<PublishedInfo | null>;
    /** Every published snapshot of the unit, oldest first, with its content (for the stable-id rule). */
    publishedHistory(unitId: string): Promise<PublishedSnapshot[]>;
    /**
     * create_unit_version_draft as a person: a new draft version (generated_by 'human', no model, no prompt version).
     * `stale_base` when `baseVersionId` is no longer the latest version. Never edits a version in place and never
     * approves or publishes anything.
     */
    saveHumanVersion(input: SaveHumanVersionInput): Promise<{ id: string; version: number }>;
  };
  readonly characters: {
    list(): Promise<CharacterRecord[]>;
    save(character: CharacterRecord): Promise<CharacterRecord>;
  };
  readonly settings: {
    get(): Promise<AiSettings>;
    set(key: AppSettingKey, value: Json): Promise<void>;
  };
  readonly usage: { summary(range: UsageRange): Promise<UsageSummary> };
  readonly jobs: AdminJobs;
}
