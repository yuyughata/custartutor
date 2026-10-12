import {
  PackManifest,
  appCanReadPack,
  parseGrownupContent,
  parseLearnerContent,
} from '@custar/content-schema';
import type { GrownupPackContent, LessonUnit, UnitContent } from '@custar/content-schema';
import { getActivePack } from '../db/packs';
import { IntegrityError, PackNotFoundError, PackTooNewError } from '../errors';
import type { Ports } from '../ports';
import { blobPath, manifestPath, versionDir } from './paths';

type LoadPorts = Pick<Ports, 'db' | 'files'>;

export interface LoadedUnit {
  unitId: string;
  versionNo: number;
  /** The learner content, parsed leniently (unknown block types degrade to `unknown` blocks). */
  unit: UnitContent;
  manifest: PackManifest;
  /** Where an asset's file is on the device (a path in the file store), or null if the pack has no such asset. */
  assetPath(assetId: string): string | null;
}

export interface LoadedLesson extends LoadedUnit {
  unit: LessonUnit;
}

/**
 * Reads the ACTIVE pack of a unit. Refuses (with `PackTooNewError`) a pack whose `min_app_version` is above
 * `appVersion`: the app must update first. Throws `PackNotFoundError` when nothing is downloaded and
 * `IntegrityError` when a file the bookkeeping calls verified has vanished or changed size.
 */
export async function loadActiveUnit(
  ports: LoadPorts,
  appVersion: string,
  unitId: string,
): Promise<LoadedUnit> {
  const active = await getActivePack(ports.db, unitId);
  if (!active) throw new PackNotFoundError(unitId);
  const { version_no: versionNo } = active;

  let manifest: PackManifest;
  try {
    manifest = PackManifest.parse(
      JSON.parse(await ports.files.readText(manifestPath(unitId, versionNo))),
    );
  } catch (error) {
    throw new IntegrityError(
      'manifest.json',
      'The stored lesson manifest is missing or damaged',
      undefined,
      undefined,
      {
        cause: error,
      },
    );
  }
  if (!appCanReadPack(appVersion, manifest.min_app_version)) {
    throw new PackTooNewError(manifest.min_app_version, appVersion);
  }

  const contentFile = manifest.files.find((f) => f.path === manifest.learner_content_path);
  const learnerPath = `${versionDir(unitId, versionNo)}/${manifest.learner_content_path}`;
  const size = await ports.files.size(learnerPath);
  if (!contentFile || size !== contentFile.bytes) {
    throw new IntegrityError(
      manifest.learner_content_path,
      'The lesson file is missing or damaged',
    );
  }
  const unit = parseLearnerContent(JSON.parse(await ports.files.readText(learnerPath)));

  const assets = new Map<string, string>();
  for (const file of manifest.files) {
    if (file.kind === 'content') continue;
    const id = file.asset_id ?? file.path.replace(/^.*\//, '').replace(/\.[^.]+$/, '');
    assets.set(id, blobPath(file.sha256));
  }
  return { unitId, versionNo, unit, manifest, assetPath: (id) => assets.get(id) ?? null };
}

/** Like `loadActiveUnit`, for callers that need a lesson (the `LessonSession`). */
export async function loadActiveLesson(
  ports: LoadPorts,
  appVersion: string,
  unitId: string,
): Promise<LoadedLesson> {
  const loaded = await loadActiveUnit(ports, appVersion, unitId);
  if (loaded.unit.kind !== 'lesson') {
    throw new Error(`Unit ${unitId} is a ${loaded.unit.kind}, not a lesson`);
  }
  return { ...loaded, unit: loaded.unit };
}

/** The grown-up pack (teacher's manual, helper script) of the active version, or null if not downloaded. */
export async function loadGrownupContent(
  ports: LoadPorts,
  unitId: string,
): Promise<GrownupPackContent | null> {
  const active = await getActivePack(ports.db, unitId);
  if (!active) throw new PackNotFoundError(unitId);
  let manifest: PackManifest;
  try {
    manifest = PackManifest.parse(
      JSON.parse(await ports.files.readText(manifestPath(unitId, active.version_no))),
    );
  } catch {
    return null;
  }
  if (manifest.grownup_content_path === null) return null;
  const path = `${versionDir(unitId, active.version_no)}/${manifest.grownup_content_path}`;
  if (!(await ports.files.exists(path))) return null;
  return parseGrownupContent(JSON.parse(await ports.files.readText(path)));
}
