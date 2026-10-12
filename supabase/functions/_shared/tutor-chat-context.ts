// What the `tutor-chat` function reads to build a turn, ALL WITH THE CALLER'S CLIENT, so row level security decides:
// the child (a guardian of the household only), the published unit, the cast, the names of the household and the
// level's stage. Pure (the client is injected), so it is unit tested with an in-memory fake.
//
// Privacy: of the child, only the ALIAS, the level and the reading mode are read into the turn. Nothing else about the
// child (no name, no photo, no avatar, no daily limit) leaves this file. The names of the household's grown-ups are
// read only to be REMOVED from what the child types (`known_names`); they are never sent to a model.

import { TutorHttpError, mapDbError } from './tutor-chat-errors.ts';
import type { DbClient, DbResult, Json, Parser, TutorTurnInput } from './tutor-chat-types.ts';

type Row = Record<string, unknown>;
type Log = (event: string, detail: Record<string, unknown>) => void;

export interface ChildContext {
  id: string;
  householdId: string;
  alias: string;
  levelCode: string;
  readingMode: 'reader' | 'pre_reader';
}

export interface UnitContext {
  content: unknown;
  /** The version that was found (the requested one when the caller may read it, else the current one). */
  versionNo: number;
  /** The requested version was not readable: the current one was used. */
  fallback: boolean;
  subjectSlug: string | null;
}

const isRecord = (value: unknown): value is Row =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function createTutorContextReader(options: {
  db: DbClient;
  userId: string;
  castTraits: Parser<Record<string, unknown>>;
  log: Log;
}) {
  const { db, userId, castTraits, log } = options;

  const unwrap = <T>(result: DbResult<T>): T | null => {
    if (result.error) throw mapDbError(result.error, log);
    return result.data;
  };

  /**
   * The child, if the caller is an active GUARDIAN of its household. Not the caller's, not a guardian (a granted
   * tutor), deleted or non-existent all give the same `forbidden`: the answer never says whether the id exists.
   */
  async function child(childId: string): Promise<ChildContext> {
    const found = unwrap(
      await db
        .from('children')
        .select('id,household_id,display_alias,level_code,reading_mode,deleted_at')
        .eq('id', childId)
        .maybeSingle(),
    );
    if (
      !found ||
      (found['deleted_at'] !== null && found['deleted_at'] !== undefined) ||
      typeof found['household_id'] !== 'string' ||
      typeof found['display_alias'] !== 'string' ||
      typeof found['level_code'] !== 'string'
    ) {
      throw new TutorHttpError('forbidden');
    }
    const membership = unwrap(
      await db
        .from('household_members')
        .select('role,status,deleted_at')
        .eq('household_id', found['household_id'])
        .eq('user_id', userId)
        .maybeSingle(),
    );
    if (
      !membership ||
      membership['role'] !== 'guardian' ||
      membership['status'] !== 'active' ||
      (membership['deleted_at'] !== null && membership['deleted_at'] !== undefined)
    ) {
      throw new TutorHttpError('forbidden');
    }
    return {
      id: childId,
      householdId: found['household_id'],
      alias: found['display_alias'],
      levelCode: found['level_code'],
      readingMode: found['reading_mode'] === 'pre_reader' ? 'pre_reader' : 'reader',
    };
  }

  /** The stage of the child's level (absorb | connect | express). */
  async function stage(levelCode: string): Promise<string> {
    const level = unwrap(
      await db.from('levels').select('code,stage').eq('code', levelCode).maybeSingle(),
    );
    if (!level || typeof level['stage'] !== 'string') {
      log('level_not_found', { level: levelCode });
      throw new TutorHttpError('internal');
    }
    return level['stage'];
  }

  /**
   * The published unit as the caller may read it: the requested version when it is readable, else the current one
   * (older snapshots are visible to content staff only). No snapshot at all is `unit_not_found`.
   */
  async function unit(unitId: string, requestedVersion: number): Promise<UnitContext> {
    const rows =
      unwrap(
        await db
          .from('published_units')
          .select('unit_id,version_no,content,is_current')
          .eq('unit_id', unitId),
      ) ?? [];
    const exact = rows.find((row) => row['version_no'] === requestedVersion);
    const current = rows.find((row) => row['is_current'] === true);
    const chosen = exact ?? current;
    if (!chosen || typeof chosen['version_no'] !== 'number') throw new TutorHttpError('unit_not_found');
    const header = isRecord(chosen['content']) ? chosen['content']['header'] : null;
    const slug = isRecord(header) && typeof header['subject_slug'] === 'string' ? header['subject_slug'] : null;
    return {
      content: chosen['content'],
      versionNo: chosen['version_no'],
      fallback: exact === undefined,
      subjectSlug: slug,
    };
  }

  async function subjectName(slug: string | null): Promise<string | undefined> {
    if (slug === null) return undefined;
    const subject = unwrap(await db.from('subjects').select('slug,name').eq('slug', slug).maybeSingle());
    return subject && typeof subject['name'] === 'string' ? subject['name'] : undefined;
  }

  /** The active cast (facts only). A character whose facts do not fit the cast bible is left out and reported. */
  async function cast(): Promise<TutorTurnInput['cast']> {
    const rows =
      unwrap(
        await db
          .from('characters')
          .select('slug,name,traits,voice')
          .eq('active', true)
          .order('slug', { ascending: true }),
      ) ?? [];
    const members: TutorTurnInput['cast'] = [];
    for (const row of rows) {
      if (typeof row['slug'] !== 'string' || typeof row['name'] !== 'string') continue;
      const traits = castTraits.safeParse(row['traits'] ?? {});
      if (!traits.success) {
        log('cast_member_skipped', { slug: row['slug'] });
        continue;
      }
      members.push({
        slug: row['slug'],
        name: row['name'],
        traits: traits.data,
        voice: isRecord(row['voice']) ? (row['voice'] as Record<string, Json>) : {},
      });
    }
    return members;
  }

  /** Display names of the household's members that the caller may see: removed from what the child types. */
  async function knownNames(householdId: string): Promise<string[]> {
    const rows =
      unwrap(
        await db
          .from('member_display')
          .select('display_name')
          .eq('household_id', householdId),
      ) ?? [];
    const names = new Set<string>();
    for (const row of rows) {
      const name = row['display_name'];
      if (typeof name === 'string' && name.trim() !== '') names.add(name.trim());
    }
    return [...names];
  }

  return { child, stage, unit, subjectName, cast, knownNames };
}
