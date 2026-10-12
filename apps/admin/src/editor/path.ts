// Immutable path-based edits over plain JSON. Every function returns a NEW root and shares whatever it did not
// touch, so a React state holding the working copy changes identity only along the edited path. Containers that
// do not exist yet are created on the way (an array when the next key is a number, else an object), which is what
// lets the editor repair a draft that is missing a whole part. No React, no I/O.

export type Segment = string | number;
export type Path = readonly Segment[];

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getAt(root: unknown, path: Path): unknown {
  let current: unknown = root;
  for (const segment of path) {
    if (Array.isArray(current)) {
      if (typeof segment !== 'number') return undefined;
      current = current[segment];
    } else if (isRec(current)) {
      current = current[String(segment)];
    } else {
      return undefined;
    }
  }
  return current;
}

/** The value at `path` as an array (an empty one when it is missing or not a list). */
export function listAt<T = unknown>(root: unknown, path: Path): T[] {
  const value = getAt(root, path);
  return Array.isArray(value) ? (value as T[]) : [];
}

export function textAt(root: unknown, path: Path): string {
  const value = getAt(root, path);
  return typeof value === 'string' ? value : '';
}

function emptyFor(next: Segment | undefined): unknown[] | Rec {
  return typeof next === 'number' ? [] : {};
}

function setIn(node: unknown, path: Path, depth: number, value: unknown): unknown {
  const segment = path[depth];
  if (segment === undefined) return value;
  const next = path[depth + 1];
  if (typeof segment === 'number') {
    const list = Array.isArray(node) ? node : [];
    const copy = list.slice();
    const child = depth + 1 >= path.length ? value : setIn(list[segment] ?? emptyFor(next), path, depth + 1, value);
    copy[segment] = child;
    return copy;
  }
  const rec = isRec(node) ? node : {};
  const child = depth + 1 >= path.length ? value : setIn(rec[segment] ?? emptyFor(next), path, depth + 1, value);
  return { ...rec, [segment]: child };
}

/** Sets the value at `path`. Setting `undefined` removes an object key (a list slot is left as is). */
export function setAt<T>(root: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T;
  if (value === undefined) return removeAt(root, path);
  if (Object.is(getAt(root, path), value)) return root;
  return setIn(root, path, 0, value) as T;
}

/** Removes an object key or a list item. A path that does not exist is left alone. */
export function removeAt<T>(root: T, path: Path): T {
  if (path.length === 0) return root;
  const parentPath = path.slice(0, -1);
  const last = path[path.length - 1] as Segment;
  const parent = getAt(root, parentPath);
  if (Array.isArray(parent)) {
    if (typeof last !== 'number' || last < 0 || last >= parent.length) return root;
    return setIn(root, parentPath, 0, parent.filter((_, index) => index !== last)) as T;
  }
  if (isRec(parent)) {
    if (!(String(last) in parent)) return root;
    const { [String(last)]: _removed, ...rest } = parent;
    return (parentPath.length === 0 ? rest : setIn(root, parentPath, 0, rest)) as T;
  }
  return root;
}

export function updateAt<T>(root: T, path: Path, fn: (current: unknown) => unknown): T {
  return setAt(root, path, fn(getAt(root, path)));
}

/** Inserts `item` into the list at `listPath` so that it ends up at `index` (clamped to the ends). */
export function insertAt<T>(root: T, listPath: Path, index: number, item: unknown): T {
  const list = listAt(root, listPath);
  const at = Math.max(0, Math.min(index, list.length));
  return setAt(root, listPath, [...list.slice(0, at), item, ...list.slice(at)]);
}

export function appendAt<T>(root: T, listPath: Path, item: unknown): T {
  return insertAt(root, listPath, Number.MAX_SAFE_INTEGER, item);
}

/** Moves the item at `from` to position `to` in the list at `listPath` (both clamped). */
export function moveItem<T>(root: T, listPath: Path, from: number, to: number): T {
  const list = listAt(root, listPath);
  if (from < 0 || from >= list.length) return root;
  const target = Math.max(0, Math.min(to, list.length - 1));
  if (target === from) return root;
  const copy = list.slice();
  const [item] = copy.splice(from, 1);
  copy.splice(target, 0, item);
  return setAt(root, listPath, copy);
}

/** `['sections', 2, 'blocks', 0, 'text']` -> `sections[2].blocks[0].text`. Keys that are not identifiers use brackets. */
export function pathKey(path: Path): string {
  return path.reduce<string>((out, segment) => {
    if (typeof segment === 'number') return `${out}[${segment}]`;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(segment)) return `${out}[${JSON.stringify(segment)}]`;
    return out === '' ? segment : `${out}.${segment}`;
  }, '');
}

export function samePath(a: Path, b: Path): boolean {
  return a.length === b.length && a.every((segment, index) => segment === b[index]);
}

export function startsWithPath(path: Path, prefix: Path): boolean {
  return prefix.length <= path.length && prefix.every((segment, index) => segment === path[index]);
}
