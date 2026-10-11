/** Test helpers. Not exported from the package. */

/** Deep copy of JSON-like data, typed as the input. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

type Path = readonly (string | number)[];
type Node = Record<string | number, unknown>;

/** Deep copy typed as `unknown`, for tests that corrupt JSON on purpose. */
export function rawClone(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

export function getAt(root: unknown, path: Path): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (typeof cursor !== 'object' || cursor === null) return undefined;
    cursor = (cursor as Node)[key];
  }
  return cursor;
}

export function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (typeof parent !== 'object' || parent === null || key === undefined) {
    throw new Error(`cannot set ${path.join('.')}`);
  }
  (parent as Node)[key] = value;
}

export function removeAt(root: unknown, path: Path): void {
  const parent = getAt(root, path.slice(0, -1));
  const key = path[path.length - 1];
  if (typeof parent !== 'object' || parent === null || key === undefined) {
    throw new Error(`cannot remove ${path.join('.')}`);
  }
  delete (parent as Node)[key];
}

export function pushAt(root: unknown, path: Path, ...values: unknown[]): void {
  const target = getAt(root, path);
  if (!Array.isArray(target)) throw new Error(`${path.join('.')} is not an array`);
  target.push(...values);
}
