// A local autosave of the working copy per (unit, base version), kept in the browser so a crashed tab, a reload or
// a closed laptop does not lose an hour of typing. It is a per-viewer convenience only: it never reaches the server
// or another person, it can be empty or blocked (private window, full quota), and every read and write is wrapped so
// the editor works the same without it. Saving to the server is the only thing that makes work safe.

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Autosaved {
  /** ISO time of the autosave. */
  savedAt: string;
  unitId: string;
  baseVersionId: string;
  content: unknown;
}

export function autosaveKey(unitId: string, baseVersionId: string): string {
  return `custar.editor.draft.${unitId}.${baseVersionId}`;
}

/** The browser's localStorage when it is usable, else null. Never throws. */
export function browserStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { localStorage?: StorageLike }).localStorage;
    if (!storage) return null;
    const probe = '__custar_probe__';
    storage.setItem(probe, '1');
    storage.removeItem(probe);
    return storage;
  } catch {
    return null;
  }
}

export function writeAutosave(
  storage: StorageLike | null,
  value: Autosaved,
): { ok: true } | { ok: false; reason: string } {
  if (!storage) return { ok: false, reason: 'This browser does not allow local autosave.' };
  try {
    storage.setItem(autosaveKey(value.unitId, value.baseVersionId), JSON.stringify(value));
    return { ok: true };
  } catch {
    return { ok: false, reason: 'The browser had no room for the autosave.' };
  }
}

export function readAutosave(
  storage: StorageLike | null,
  unitId: string,
  baseVersionId: string,
): Autosaved | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(autosaveKey(unitId, baseVersionId));
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Autosaved).savedAt === 'string' &&
      (parsed as Autosaved).unitId === unitId &&
      (parsed as Autosaved).baseVersionId === baseVersionId &&
      typeof (parsed as Autosaved).content === 'object' &&
      (parsed as Autosaved).content !== null
    ) {
      return parsed as Autosaved;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearAutosave(storage: StorageLike | null, unitId: string, baseVersionId: string): void {
  try {
    storage?.removeItem(autosaveKey(unitId, baseVersionId));
  } catch {
    // nothing to do: the autosave is a convenience
  }
}

/** Order-independent comparison of two JSON values, to tell whether autosaved work differs from the loaded version. */
export function sameContent(a: unknown, b: unknown): boolean {
  return canonical(a) === canonical(b);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const rec = value as Record<string, unknown>;
    return `{${Object.keys(rec)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(rec[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
