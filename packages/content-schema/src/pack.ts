import { z } from 'zod';
import { normalizeDeep, parseUnitLenient } from './parse';
import { TeacherManual } from './unit';
import type { LessonUnit, UnitContent } from './unit';

/**
 * Lesson packs (ADR 0004). A published unit is delivered as an immutable manifest plus files:
 *
 *  - the LEARNER pack: the unit content that the child plays, including question answers (offline grading
 *    needs them; the threat model is a young child, not an attacker), tutor scripts and the media/audio;
 *  - the smaller GROWN-UP pack: the teacher's manual (script, theme map, mastery guidance, helper script).
 *
 * JSON content is stored UNCOMPRESSED (transport compression is HTTP's job; no unzip on the JS thread).
 * Media and audio are CONTENT-ADDRESSED: the device stores a file under `blobs/<sha256>`, so an unchanged
 * picture is never downloaded or stored twice, even across versions or units. The manifest's `path` for such
 * a file is only its logical name inside the pack (for example `media/zari_waves.webp`).
 *
 * Everything here is pure (Zod and plain functions) so the pack builder (Node), the publish job (Edge) and
 * the learner app can all use it.
 */

export const PACK_VERSION = 1;

const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'must be a lowercase SHA-256 hex digest');

/**
 * A safe relative path: slash-separated segments that each start with a letter or digit, so `..`, `.`,
 * absolute paths, hidden files and backslashes are all rejected (a hostile manifest must not escape its
 * directory on the device).
 */
export const PackPath = z
  .string()
  .max(256)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/,
    'must be a safe relative path (no "..", no leading "/" or ".")',
  );
export type PackPath = z.infer<typeof PackPath>;

/** App version in `major.minor.patch` form (minor and patch optional). */
export const AppVersion = z.string().regex(/^\d+(\.\d+){0,2}$/, 'must look like 1.2.3');

const Uuid = z.guid();

export const PackFileKind = z.enum(['content', 'media', 'audio']);
export type PackFileKind = z.infer<typeof PackFileKind>;

export const PackWhich = z.enum(['learner', 'grownup']);
export type PackWhich = z.infer<typeof PackWhich>;

export const PackFile = z.object({
  /** Logical path inside the pack. Content files are stored at this path; media/audio under `blobs/<sha256>`. */
  path: PackPath,
  sha256: Sha256Hex,
  bytes: z.number().int().min(0),
  kind: PackFileKind,
  pack: PackWhich,
  /** The content asset id (`illustration.asset_id`, `audio_refs[]`) this file is, for media and audio. */
  asset_id: z.string().min(1).max(128).optional(),
});
export type PackFile = z.infer<typeof PackFile>;

export const PackManifest = z.object({
  pack_version: z.literal(PACK_VERSION),
  unit_id: Uuid,
  version_no: z.number().int().min(1),
  /** Version of the unit content schema inside (see `CURRENT_SCHEMA_VERSION`). */
  schema_version: z.number().int().min(1),
  /** The oldest app build that can read this pack. */
  min_app_version: AppVersion,
  /** Hash of the unit content this pack was built from; equals `published.content_hash` on the server. */
  content_hash: Sha256Hex,
  files: z.array(PackFile).min(1).max(2000),
  /** Path (in `files`) of the learner content JSON. */
  learner_content_path: PackPath,
  /** Path (in `files`) of the grown-up content JSON, or null when the unit has no grown-up content. */
  grownup_content_path: PackPath.nullable(),
});
export type PackManifest = z.infer<typeof PackManifest>;

/** The files that belong to a pack (or to both packs). */
export function filesForPack(manifest: PackManifest, which: PackWhich | 'all'): PackFile[] {
  return manifest.files.filter((file) => which === 'all' || file.pack === which);
}

/**
 * Bytes that a download of `which` has to fetch. A media/audio file listed under several paths is stored
 * once on the device (content-addressed), so it is counted once.
 */
export function packTotalBytes(manifest: PackManifest, which: PackWhich | 'all'): number {
  const seen = new Set<string>();
  let total = 0;
  for (const file of filesForPack(manifest, which)) {
    const key = file.kind === 'content' ? `path:${file.path}` : `sha:${file.sha256}`;
    if (seen.has(key)) continue;
    seen.add(key);
    total += file.bytes;
  }
  return total;
}

/**
 * Structural checks that a shape check cannot express. Returns a list of problems (empty when sound);
 * the publish job refuses a manifest with problems and the download manager refuses to start on one.
 */
export function verifyManifestIntegrity(manifest: PackManifest): string[] {
  const issues: string[] = [];
  const byPath = new Map<string, PackFile>();
  const bytesBySha = new Map<string, number>();

  for (const file of manifest.files) {
    if (byPath.has(file.path)) issues.push(`duplicate path "${file.path}"`);
    byPath.set(file.path, file);
    if (file.kind === 'content' && file.bytes === 0) {
      issues.push(`content file "${file.path}" is empty`);
    }
    if (file.kind !== 'content') {
      if (file.path.startsWith('blobs/')) {
        issues.push(
          `media path "${file.path}" must not live under blobs/ (that is the device store)`,
        );
      }
      const known = bytesBySha.get(file.sha256);
      if (known !== undefined && known !== file.bytes) {
        issues.push(`blob ${file.sha256} is listed with two different sizes`);
      }
      bytesBySha.set(file.sha256, file.bytes);
    }
  }

  const expectContent = (path: string | null, which: PackWhich, label: string) => {
    if (path === null) return;
    const file = byPath.get(path);
    if (!file) {
      issues.push(`${label} "${path}" is not listed in files`);
    } else if (file.kind !== 'content' || file.pack !== which) {
      issues.push(`${label} "${path}" must be a ${which}-pack content file`);
    }
  };
  expectContent(manifest.learner_content_path, 'learner', 'learner_content_path');
  expectContent(manifest.grownup_content_path, 'grownup', 'grownup_content_path');

  const contentFiles = manifest.files.filter((file) => file.kind === 'content');
  const referenced = new Set([manifest.learner_content_path, manifest.grownup_content_path]);
  for (const file of contentFiles) {
    if (!referenced.has(file.path)) issues.push(`content file "${file.path}" is not referenced`);
  }
  if (manifest.grownup_content_path === null && manifest.files.some((f) => f.pack === 'grownup')) {
    issues.push('grownup_content_path is null but the manifest lists grown-up files');
  }
  if (manifest.learner_content_path === manifest.grownup_content_path) {
    issues.push('learner and grown-up content must be different files');
  }
  return issues;
}

/**
 * Compares two app versions numerically per segment (`1.10.0` is newer than `1.9.0`). Missing segments
 * count as 0. Returns a negative number, 0 or a positive number.
 */
export function compareAppVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** True when an app build of `appVersion` can read a pack that needs `minAppVersion`. */
export function appCanReadPack(appVersion: string, minAppVersion: string): boolean {
  return compareAppVersions(appVersion, minAppVersion) >= 0;
}

// ---------------------------------------------------------------------------------------------
// Splitting a unit into the two packs
// ---------------------------------------------------------------------------------------------

/** A lesson as the learner pack stores it: everything except the teacher's manual. */
export type LearnerLesson = Omit<LessonUnit, 'teacher_manual'>;

/** The learner pack's content JSON: a lesson without its manual, or any other unit kind unchanged. */
export type LearnerPackContent = LearnerLesson | Exclude<UnitContent, { kind: 'lesson' }>;

export const GrownupPackContent = z.object({
  schema_version: z.number().int().min(1),
  kind: z.literal('lesson'),
  teacher_manual: TeacherManual,
});
export type GrownupPackContent = z.infer<typeof GrownupPackContent>;

/**
 * Splits a parsed unit into the content of the two packs. Pure; the result shares structure with the input
 * (nothing is copied).
 *
 *  - `learner`: everything EXCEPT `teacher_manual`. Question answers, tutor scripts, the workbook and the
 *    practice-variant pool stay here on purpose: grading and "Tutor Lite" run offline and need them. Hiding
 *    answers from the device is a non-goal (ADR 0004: the threat model is a young child).
 *  - `grownup`: the teacher's manual (script, theme map, timing, materials, mastery guidance and the helper
 *    script for a pre-reader's co-pilot). Only lessons have one; every other unit kind returns `null`.
 */
export function splitUnitForPacks(unit: UnitContent): {
  learner: LearnerPackContent;
  grownup: GrownupPackContent | null;
} {
  if (unit.kind !== 'lesson') return { learner: unit, grownup: null };
  const { teacher_manual: teacherManual, ...learner } = unit;
  return {
    learner,
    grownup: { schema_version: unit.schema_version, kind: 'lesson', teacher_manual: teacherManual },
  };
}

/** Marker text of `STRIPPED_TEACHER_MANUAL`. */
const STRIPPED_NOTE = 'The teacher manual is in the grown-up pack.';

/**
 * Stand-in for the teacher's manual in a lesson read from the learner pack alone. `UnitContent` requires a
 * manual, so `parseLearnerContent` fills this empty one; use `hasTeacherManual` before showing it.
 */
export const STRIPPED_TEACHER_MANUAL: TeacherManual = {
  script: [],
  timing: STRIPPED_NOTE,
  materials: [],
  mastery_guidance: { got_it: [], not_yet: STRIPPED_NOTE },
  helper_script: [],
};

/** False for a lesson read from the learner pack alone (its manual is the empty stand-in). */
export function hasTeacherManual(unit: UnitContent): boolean {
  return unit.kind === 'lesson' && unit.teacher_manual.timing !== STRIPPED_NOTE;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses the learner pack's content JSON for READERS: a lesson without `teacher_manual` gets the empty
 * stand-in, then `parseUnitLenient` runs (migrations, NFC, unknown blocks degrade instead of failing).
 * Throws `UnitParseError` / `SchemaVersionError` like `parseUnitLenient`.
 */
export function parseLearnerContent(raw: unknown): UnitContent {
  if (isRecord(raw) && raw.kind === 'lesson' && raw.teacher_manual === undefined) {
    return parseUnitLenient({ ...raw, teacher_manual: STRIPPED_TEACHER_MANUAL });
  }
  return parseUnitLenient(raw);
}

/** Parses the grown-up pack's content JSON (NFC-normalised). Throws a ZodError when malformed. */
export function parseGrownupContent(raw: unknown): GrownupPackContent {
  return GrownupPackContent.parse(normalizeDeep(raw));
}

/** The inverse of `splitUnitForPacks`: puts the real manual back (helper mode, printing, tests). */
export function joinUnitFromPacks(
  learner: UnitContent,
  grownup: GrownupPackContent | null,
): UnitContent {
  if (learner.kind !== 'lesson' || grownup === null) return learner;
  return { ...learner, teacher_manual: grownup.teacher_manual };
}
