// Zod schema -> the JSON Schema subset the API accepts for structured outputs (`output_config.format`).
//
// What the API supports comes from the SDK's documentation and its own helper (`transformJSONSchema`,
// `zodOutputFormat` in @anthropic-ai/sdk): object nodes need `additionalProperties: false`; recursion is not
// allowed; numeric and most string and array constraints are not supported, and the SDK folds them into the
// `description` so the model still sees them while the Zod parse enforces them. `enum` and `const` are listed as
// supported, so unlike the SDK helper (which moves them into the description) they are kept as keywords.
// The reply is ALWAYS re-validated with the original Zod schema (see anthropic.ts), so anything dropped or
// softened here is still enforced afterwards.
import { z } from 'zod';
import { LlmRequestError } from './errors';

type Schema = Record<string, unknown>;

// Converting a big schema is not free and an edge function has about 2 s of CPU per request; the engine
// reuses the same schema objects for every call, so the result is kept per schema object.
const converted = new WeakMap<object, Schema>();

const SUPPORTED_STRING_FORMATS: ReadonlySet<string> = new Set([
  'date-time',
  'time',
  'date',
  'duration',
  'email',
  'hostname',
  'uri',
  'ipv4',
  'ipv6',
  'uuid',
]);

/**
 * Converts `schema` for use as a structured-output format. Throws `LlmRequestError` (a programmer error) when
 * the schema cannot be expressed, naming `schemaName` and the JSON pointer of the offending node.
 */
export function toStructuredJsonSchema(schema: z.ZodType, schemaName: string): Schema {
  const cached = converted.get(schema);
  if (cached) return cached;

  const fail = (path: string, why: string): never => {
    throw new LlmRequestError(
      `Schema "${schemaName}" cannot be sent as a structured output: ${path === '' ? '(root)' : path} ${why}`,
    );
  };

  let raw: unknown;
  try {
    // `io: 'input'`: the model produces what the schema ACCEPTS, so defaults stay optional and transforms are
    // fine. `reused: 'ref'` keeps big shared definitions (questions, blocks) from being repeated.
    raw = z.toJSONSchema(schema, { io: 'input', reused: 'ref' });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new LlmRequestError(
      `Schema "${schemaName}" cannot be expressed as JSON Schema: ${reason}`,
      { cause: error },
    );
  }

  const root = convertNode(raw, '', fail);
  if (root['type'] !== 'object' && root['$ref'] === undefined) {
    fail('', 'must be an object (wrap arrays and unions in an object with one property)');
  }
  assertAcyclic(root, fail);
  const result = inlineRefs(root);
  converted.set(schema, result);
  return result;
}

type Fail = (path: string, why: string) => never;

function convertNode(node: unknown, path: string, fail: Fail): Schema {
  if (!isRecord(node)) return fail(path, 'is not a schema object');
  const rest: Schema = { ...node };
  const take = (key: string): unknown => {
    const value = rest[key];
    delete rest[key];
    return value;
  };
  const out: Schema = {};

  // Annotations with no meaning for the model.
  delete rest['$schema'];
  delete rest['$id'];

  const defs = take('$defs');
  if (isRecord(defs)) {
    out['$defs'] = Object.fromEntries(
      Object.entries(defs).map(([name, def]) => [
        name,
        convertNode(def, `${path}/$defs/${name}`, fail),
      ]),
    );
  }

  const ref = take('$ref');
  if (typeof ref === 'string') {
    // Siblings of a $ref are dropped, as the SDK helper does.
    out['$ref'] = ref;
    return out;
  }

  const description = take('description');
  const title = take('title');
  const type = take('type');
  const anyOf = take('anyOf');
  const oneOf = take('oneOf');
  const allOf = take('allOf');

  if (Array.isArray(type)) {
    // `["string","null"]` is how Zod writes a nullable primitive. Spell it as anyOf, which is documented.
    if (anyOf !== undefined || oneOf !== undefined || allOf !== undefined) {
      return fail(path, 'mixes a type list with anyOf/oneOf/allOf');
    }
    out['anyOf'] = type.map((single, index) =>
      single === 'null'
        ? { type: 'null' }
        : convertNode({ ...rest, type: single }, `${path}/type/${index}`, fail),
    );
    return finish(out, rest, description, title);
  }

  if (Array.isArray(anyOf) && Array.isArray(oneOf)) return fail(path, 'has both anyOf and oneOf');
  const union = Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : undefined;
  if (union) out['anyOf'] = union.map((v, i) => convertNode(v, `${path}/anyOf/${i}`, fail));
  if (Array.isArray(allOf))
    out['allOf'] = allOf.map((v, i) => convertNode(v, `${path}/allOf/${i}`, fail));

  const hasValueKeyword = 'enum' in rest || 'const' in rest;
  if (typeof type === 'string') {
    out['type'] = type;
  } else if (type !== undefined) {
    return fail(path, 'has an unsupported "type"');
  } else if (!union && !Array.isArray(allOf) && !hasValueKeyword) {
    return fail(path, 'has no type (z.any/z.unknown/z.custom are not supported)');
  }
  if ('enum' in rest) out['enum'] = take('enum');
  if ('const' in rest) out['const'] = take('const');

  switch (type) {
    case 'object': {
      const properties = take('properties');
      out['properties'] = isRecord(properties)
        ? Object.fromEntries(
            Object.entries(properties).map(([key, value]) => [
              key,
              convertNode(value, `${path}/properties/${key}`, fail),
            ]),
          )
        : {};
      const required = take('required');
      if (Array.isArray(required) && required.length > 0) out['required'] = required;
      const extra = take('additionalProperties');
      if (isRecord(extra) && Object.keys(extra).length > 0) {
        return fail(
          path,
          'allows arbitrary keys (z.record or catchall); use a fixed set of properties',
        );
      }
      if (take('propertyNames') !== undefined) {
        return fail(path, 'allows arbitrary keys (z.record); use a fixed set of properties');
      }
      out['additionalProperties'] = false;
      break;
    }
    case 'array': {
      if (take('prefixItems') !== undefined)
        return fail(path, 'is a tuple; use an array of objects');
      const items = take('items');
      if (!isRecord(items)) return fail(path, 'is an array without an item schema');
      out['items'] = convertNode(items, `${path}/items`, fail);
      // Only 0 and 1 are supported; other bounds stay in `rest` and become description text.
      if (rest['minItems'] === 0 || rest['minItems'] === 1) out['minItems'] = take('minItems');
      break;
    }
    case 'string': {
      const format = rest['format'];
      if (typeof format === 'string' && SUPPORTED_STRING_FORMATS.has(format)) {
        out['format'] = take('format');
        // Zod adds a regex next to a format; the format already says it.
        delete rest['pattern'];
      }
      break;
    }
    case 'integer':
    case 'number': {
      // Zod writes the safe-integer range on every `.int()`; it says nothing useful to the model.
      for (const key of ['minimum', 'maximum'] as const) {
        const bound = rest[key];
        if (bound === Number.MAX_SAFE_INTEGER || bound === Number.MIN_SAFE_INTEGER)
          delete rest[key];
      }
      break;
    }
    default:
      break;
  }

  return finish(out, rest, description, title);
}

/** Folds every keyword that is not sent to the API into the description, then adds title and description. */
function finish(out: Schema, rest: Schema, description: unknown, title: unknown): Schema {
  const dropped = Object.entries(rest);
  let text = typeof description === 'string' && description !== '' ? description : undefined;
  if (dropped.length > 0) {
    const constraints = `{${dropped.map(([key, value]) => `${key}: ${JSON.stringify(value)}`).join(', ')}}`;
    text = text === undefined ? constraints : `${text}\n\n${constraints}`;
  }
  if (typeof title === 'string') out['title'] = title;
  if (text !== undefined) out['description'] = text;
  return out;
}

/** Structured outputs do not support recursion: reject cycles and dangling $refs before the API does. */
function assertAcyclic(root: Schema, fail: Fail): void {
  const defs = isRecord(root['$defs']) ? root['$defs'] : {};
  const prefix = '#/$defs/';

  const refsIn = (node: unknown, found: string[] = []): string[] => {
    if (Array.isArray(node)) {
      for (const item of node) refsIn(item, found);
    } else if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$defs') continue;
        if (key === '$ref' && typeof value === 'string') found.push(value);
        else refsIn(value, found);
      }
    }
    return found;
  };
  const targets = (node: unknown, where: string): string[] =>
    refsIn(node).map((ref) => {
      const name = ref.startsWith(prefix) ? ref.slice(prefix.length) : undefined;
      if (name === undefined || !(name in defs)) {
        return fail(
          where,
          `has a $ref (${ref}) that does not point into $defs (recursion is not supported)`,
        );
      }
      return name;
    });

  const edges = new Map<string, string[]>();
  for (const [name, def] of Object.entries(defs)) edges.set(name, targets(def, `${prefix}${name}`));
  const rootTargets = targets(root, '');

  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (name: string): void => {
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') {
      fail(`${prefix}${name}`, 'is recursive (recursion is not supported)');
    }
    state.set(name, 'visiting');
    for (const next of edges.get(name) ?? []) visit(next);
    state.set(name, 'done');
  };
  for (const name of rootTargets) visit(name);
  for (const name of edges.keys()) visit(name);
}

const DEFS_PREFIX = '#/$defs/';
/** A definition this small (and without further structure) reads better inline than behind a $ref. */
const INLINE_LEAF_CHARS = 160;

/**
 * Zod's `reused: 'ref'` turns every shared sub-schema, down to `{ "type": "string" }`, into a numbered
 * definition, which is noise for the model and for the API's schema compiler. Inline definitions that are used
 * once or are tiny leaves; keep the genuinely shared structures. The schema is acyclic here (assertAcyclic).
 */
function inlineRefs(root: Schema): Schema {
  const defs = root['$defs'];
  if (!isRecord(defs)) return root;

  const counts = new Map<string, number>();
  const countIn = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(countIn);
    else if (isRecord(node)) {
      for (const [key, value] of Object.entries(node)) {
        if (key === '$ref' && typeof value === 'string') {
          counts.set(value, (counts.get(value) ?? 0) + 1);
        } else if (key !== '$defs') countIn(value);
      }
    }
  };
  countIn(root);
  Object.values(defs).forEach(countIn);

  const isLeaf = (def: unknown): boolean =>
    isRecord(def) &&
    !['$ref', 'properties', 'items', 'anyOf', 'allOf'].some((key) => key in def) &&
    JSON.stringify(def).length <= INLINE_LEAF_CHARS;
  const inline = new Set(
    Object.entries(defs)
      .filter(([name, def]) => (counts.get(`${DEFS_PREFIX}${name}`) ?? 0) <= 1 || isLeaf(def))
      .map(([name]) => name),
  );

  const rewrite = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(rewrite);
    if (!isRecord(node)) return node;
    const ref = node['$ref'];
    if (typeof ref === 'string' && ref.startsWith(DEFS_PREFIX)) {
      const name = ref.slice(DEFS_PREFIX.length);
      return inline.has(name) ? rewrite(defs[name]) : node;
    }
    return Object.fromEntries(
      Object.entries(node)
        .filter(([key]) => key !== '$defs')
        .map(([key, value]) => [key, rewrite(value)]),
    );
  };

  const { $defs: _defs, ...body } = root;
  const kept = Object.entries(defs).filter(([name]) => !inline.has(name));
  const result = rewrite(body) as Schema;
  if (kept.length > 0) {
    return {
      $defs: Object.fromEntries(kept.map(([name, def]) => [name, rewrite(def)])),
      ...result,
    };
  }
  return result;
}

function isRecord(value: unknown): value is Schema {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
