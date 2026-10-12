import {
  effectiveProgress,
  getChild,
  getHousehold,
  listChildProgress,
  listChildren,
  listPendingEvents,
  listSubjects,
  listUnits,
  outboxCounts,
  packStatuses,
  storageUsage,
  unlockStates,
  type LocalChild,
  type LocalSubject,
  type LocalUnit,
  type PackStatus,
  type StorageUsage,
  type UnitProgressStatus,
} from '@custar/learner-core';
import type { Runtime } from '../runtime/types';

export interface HomeUnit {
  unit: LocalUnit;
  state: UnitProgressStatus;
  score: number | null;
  pack: PackStatus | null;
}

export interface HomeGroup {
  subject: LocalSubject;
  units: HomeUnit[];
}

export interface Home {
  child: LocalChild;
  groups: HomeGroup[];
}

/**
 * What a child sees: their level's units per subject, in teaching order, with mastery-gated lock state.
 * Server progress is merged with events not yet synced, so a unit mastered offline unlocks the next one
 * immediately.
 */
export async function loadHome(runtime: Runtime, childId: string): Promise<Home | null> {
  const db = runtime.ports.db;
  const child = await getChild(db, childId);
  if (!child) return null;

  const [subjects, units, serverProgress, pending, statuses] = await Promise.all([
    listSubjects(db),
    listUnits(db, { levelCode: child.level_code }),
    listChildProgress(db, childId),
    listPendingEvents(db, childId),
    packStatuses(db),
  ]);
  const packByUnit = new Map(statuses.map((status) => [status.unitId, status]));

  const groups: HomeGroup[] = [];
  for (const subject of [...subjects].sort(
    (a, b) => a.sort - b.sort || a.name.localeCompare(b.name),
  )) {
    const subjectUnits = units.filter(
      (unit) => unit.subject_id === subject.id && packByUnit.has(unit.id),
    );
    if (subjectUnits.length === 0) continue;

    const effective = new Map(
      subjectUnits.flatMap((unit) => {
        const progress = effectiveProgress(
          serverProgress.get(unit.id) ?? null,
          pending.filter((event) => event.unit_id === unit.id),
        );
        return progress ? [[unit.id, progress] as const] : [];
      }),
    );
    const states = unlockStates(subjectUnits, effective);
    groups.push({
      subject,
      units: subjectUnits.map((unit) => ({
        unit,
        state: states.get(unit.id) ?? 'locked',
        score: effective.get(unit.id)?.mastery_score ?? null,
        pack: packByUnit.get(unit.id) ?? null,
      })),
    });
  }
  return { child, groups };
}

export async function loadChildList(runtime: Runtime): Promise<LocalChild[]> {
  return listChildren(runtime.ports.db);
}

export interface GrownupSummary {
  householdName: string | null;
  children: LocalChild[];
  pendingEvents: number;
  deadEvents: number;
  lastVerifiedAt: number | null;
  graceValid: boolean;
  storage: StorageUsage;
  packs: { unit: LocalUnit; pack: PackStatus }[];
}

export async function loadGrownupSummary(runtime: Runtime): Promise<GrownupSummary> {
  const db = runtime.ports.db;
  const [household, children, counts, storage, statuses, units] = await Promise.all([
    getHousehold(db),
    listChildren(db),
    outboxCounts(db),
    storageUsage(runtime.ports),
    packStatuses(db),
    listUnits(db),
  ]);
  const unitById = new Map(units.map((unit) => [unit.id, unit]));
  return {
    householdName: household?.name ?? null,
    children,
    pendingEvents: counts.pending,
    deadEvents: counts.dead,
    lastVerifiedAt: runtime.trusted.lastVerifiedAt(),
    graceValid: runtime.trusted.offlineGraceValid(),
    storage,
    packs: statuses.flatMap((pack) => {
      const unit = unitById.get(pack.unitId);
      return unit ? [{ unit, pack }] : [];
    }),
  };
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const AVATARS: Record<string, string> = {
  owl: '🦉',
  lion: '🦁',
  elephant: '🐘',
  parrot: '🦜',
  tortoise: '🐢',
  monkey: '🐵',
  fish: '🐟',
  star: '⭐',
};

export const AVATAR_CHOICES = Object.keys(AVATARS);

export function avatarEmoji(avatar: string | null): string {
  return (avatar && AVATARS[avatar]) || '🙂';
}
