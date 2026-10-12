import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The core and the fakes run in Hermes/Metro and in the browser (demo mode): no Node built-ins, no React
 * Native, Expo or Supabase. Only `src/testing` (the node:sqlite driver) and test files may use Node.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const shipped = walk(SRC).filter((file) => {
  const rel = relative(SRC, file);
  return (
    file.endsWith('.ts') &&
    !file.endsWith('.test.ts') &&
    !rel.startsWith('testing') &&
    rel !== 'test-helpers.ts'
  );
});

const FORBIDDEN_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"](node:[^'"]*|fs|path|os|crypto|child_process|stream|buffer|url|util|zlib|react|react-native|expo[^'"]*|@supabase\/[^'"]*|@react-native[^'"]*)['"]/;
const NODE_GLOBALS = /\b(Buffer\.|process\.(env|cwd|platform)|__dirname|__filename|require\()/;

describe('platform neutrality', () => {
  it('finds the shipped sources', () => {
    expect(shipped.length).toBeGreaterThan(30);
    expect(shipped.some((f) => f.includes('/fakes/'))).toBe(true);
  });

  it.each(shipped.map((file) => [relative(SRC, file), file] as const))(
    '%s imports nothing platform specific',
    (_name, file) => {
      const text = readFileSync(file, 'utf8');
      const stripped = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(FORBIDDEN_IMPORT.exec(stripped)?.[0]).toBeUndefined();
      expect(NODE_GLOBALS.exec(stripped)?.[0]).toBeUndefined();
    },
  );

  it('keeps relative imports extensionless', () => {
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8');
      expect(/from '\.{1,2}\/[^']*\.(js|ts)'/.test(text), relative(SRC, file)).toBe(false);
    }
  });

  it('has no default exports', () => {
    for (const file of shipped) {
      expect(/export default/.test(readFileSync(file, 'utf8')), relative(SRC, file)).toBe(false);
    }
  });
});
