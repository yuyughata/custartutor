import { describe, expect, it } from 'vitest';
import {
  autosaveKey,
  browserStorage,
  clearAutosave,
  readAutosave,
  sameContent,
  writeAutosave,
  type StorageLike,
} from './autosave';

function memory(): StorageLike & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}

const saved = {
  savedAt: '2026-10-12T10:00:00Z',
  unitId: 'u1',
  baseVersionId: 'v1',
  content: { a: 1 },
};

describe('autosave', () => {
  it('is keyed by unit and base version', () => {
    expect(autosaveKey('u1', 'v1')).not.toBe(autosaveKey('u1', 'v2'));
    expect(autosaveKey('u1', 'v1')).not.toBe(autosaveKey('u2', 'v1'));
  });

  it('writes, reads and clears', () => {
    const storage = memory();
    expect(writeAutosave(storage, saved)).toEqual({ ok: true });
    expect(readAutosave(storage, 'u1', 'v1')).toEqual(saved);
    expect(readAutosave(storage, 'u1', 'v2')).toBeNull();
    clearAutosave(storage, 'u1', 'v1');
    expect(readAutosave(storage, 'u1', 'v1')).toBeNull();
  });

  it('works without storage and survives one that throws', () => {
    expect(writeAutosave(null, saved).ok).toBe(false);
    expect(readAutosave(null, 'u1', 'v1')).toBeNull();
    clearAutosave(null, 'u1', 'v1');
    const broken: StorageLike = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(writeAutosave(broken, saved)).toEqual({
      ok: false,
      reason: 'The browser had no room for the autosave.',
    });
    expect(readAutosave(broken, 'u1', 'v1')).toBeNull();
    expect(() => clearAutosave(broken, 'u1', 'v1')).not.toThrow();
  });

  it('ignores a stored value that is not an autosave of this unit and version', () => {
    const storage = memory();
    storage.setItem(autosaveKey('u1', 'v1'), 'not json');
    expect(readAutosave(storage, 'u1', 'v1')).toBeNull();
    storage.setItem(autosaveKey('u1', 'v1'), JSON.stringify({ ...saved, unitId: 'other' }));
    expect(readAutosave(storage, 'u1', 'v1')).toBeNull();
    storage.setItem(autosaveKey('u1', 'v1'), JSON.stringify({ ...saved, content: null }));
    expect(readAutosave(storage, 'u1', 'v1')).toBeNull();
  });

  it('browserStorage is null outside a browser', () => {
    expect(browserStorage()).toBeNull();
  });

  it('sameContent ignores key order', () => {
    expect(sameContent({ a: 1, b: [1, { c: 2, d: 3 }] }, { b: [1, { d: 3, c: 2 }], a: 1 })).toBe(
      true,
    );
    expect(sameContent({ a: 1 }, { a: 2 })).toBe(false);
    expect(sameContent([1, 2], [2, 1])).toBe(false);
  });
});
