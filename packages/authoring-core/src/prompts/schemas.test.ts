import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { toStructuredJsonSchema } from '../llm/structuredSchema';
import { AUTHORING_SCHEMAS } from './schemas';

/** Keywords the structured-output API does not support (or that signal a union / recursion we avoid). */
const FORBIDDEN = [
  'pattern',
  'oneOf',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'maxItems',
  'multipleOf',
  'format',
];

function keys(node: unknown, found: Set<string> = new Set()): Set<string> {
  if (Array.isArray(node)) node.forEach((item) => keys(item, found));
  else if (typeof node === 'object' && node !== null) {
    for (const [key, value] of Object.entries(node)) {
      found.add(key);
      keys(value, found);
    }
  }
  return found;
}

describe('authoring schemas', () => {
  const entries = Object.entries(AUTHORING_SCHEMAS);

  it.each(entries)(
    '%s converts with the adapter and uses no unsupported keyword',
    (name, schema) => {
      // the adapter's own converter rejects records, unknowns, tuples and recursion
      const converted = toStructuredJsonSchema(schema, name);
      expect(converted['type']).toBe('object');
      const raw = z.toJSONSchema(schema, { io: 'input' });
      const found = keys(raw);
      for (const word of FORBIDDEN) {
        // property NAMES can collide with keywords (none do today), so look at keyword positions only
        expect(found.has(word) ? word : null, `${name} uses "${word}"`).toBeNull();
      }
      // report the size so a reviewer can see how compact each step's schema is
      const size = JSON.stringify(converted).length;
      expect(size).toBeGreaterThan(50);
      expect(size).toBeLessThan(9000);
    },
  );
});
