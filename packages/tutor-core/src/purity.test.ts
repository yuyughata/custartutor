import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The tutor runs in Deno edge functions, in the learner app (demo mode and Tutor Lite) and in Node scripts: no Node
 * built-ins, no React Native, Expo, Supabase or Anthropic SDK imports, no environment reads, no logging (a child's
 * words and the API key must never reach a log), no randomness and no hidden clock in the logic. Only test files
 * may use Node. The streaming adapter takes an injected client instead of importing the SDK.
 */

const SRC = dirname(fileURLToPath(import.meta.url));

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

const shipped = walk(SRC).filter((file) => file.endsWith('.ts') && !file.endsWith('.test.ts'));

const FORBIDDEN_IMPORT =
  /(?:from|import|require)\s*\(?\s*['"](node:[^'"]*|fs|path|os|crypto|child_process|stream|buffer|url|util|zlib|http|https|net|tls|worker_threads|react|react-dom|react-native|expo[^'"]*|@supabase\/[^'"]*|@react-native[^'"]*|@anthropic-ai\/[^'"]*|npm:[^'"]*|jsr:[^'"]*)['"]/;
const NODE_GLOBALS = /\b(Buffer\.|process\.(env|cwd|platform|argv)|__dirname|__filename|require\()/;
const LOGGING = /\bconsole\.(log|debug|info|warn|error|trace|dir)\b/;
const SECRETS = /ANTHROPIC_API_KEY|sk-ant-[A-Za-z0-9_-]{20,}/;
const RANDOM = /\bMath\.random\b|crypto\.randomUUID|\bnew Date\(\)/;

function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('platform neutrality', () => {
  it('finds the shipped sources, the fakes, the llm adapter and the pipeline among them', () => {
    expect(shipped.length).toBeGreaterThan(30);
    for (const part of ['/fakes/', '/llm/', '/pipeline/', '/safety/', '/redact/', '/lite/', '/stream/']) {
      expect(shipped.some((file) => file.includes(part)), part).toBe(true);
    }
  });

  it.each(shipped.map((file) => [relative(SRC, file), file] as const))(
    '%s imports nothing platform specific',
    (_name, file) => {
      const text = strip(readFileSync(file, 'utf8'));
      expect(FORBIDDEN_IMPORT.exec(text)?.[0]).toBeUndefined();
      expect(NODE_GLOBALS.exec(text)?.[0]).toBeUndefined();
    },
  );

  it('never logs, never names the API key, never reads the clock or randomness by itself', () => {
    for (const file of shipped) {
      const text = strip(readFileSync(file, 'utf8'));
      const name = relative(SRC, file);
      expect(LOGGING.exec(text)?.[0], `${name} logs`).toBeUndefined();
      expect(SECRETS.exec(text)?.[0], `${name} names a secret`).toBeUndefined();
      expect(RANDOM.exec(text)?.[0], `${name} is not deterministic`).toBeUndefined();
      // the only default clock is the adapter's, used to read an HTTP-date retry-after
      if (!name.endsWith('llm/anthropicStream.ts')) {
        expect(/Date\.now/.test(text), `${name} reads the clock`).toBe(false);
      }
    }
  });

  it('keeps relative imports extensionless and has no default exports', () => {
    for (const file of shipped) {
      const text = readFileSync(file, 'utf8');
      expect(/from '\.{1,2}\/[^']*\.(js|ts)'/.test(text), relative(SRC, file)).toBe(false);
      expect(/export default/.test(text), relative(SRC, file)).toBe(false);
    }
  });

  it('imports only zod, the content schema and the model port from outside the package', () => {
    const bare = /from\s+'([^./][^']*)'/g;
    for (const file of shipped) {
      const text = strip(readFileSync(file, 'utf8'));
      const allowed = file.includes('/fakes/')
        ? ['zod', '@custar/content-schema', '@custar/content-schema/fixtures', '@custar/authoring-core']
        : ['zod', '@custar/content-schema', '@custar/authoring-core'];
      for (const match of text.matchAll(bare)) {
        expect(allowed, `${relative(SRC, file)} imports ${match[1]}`).toContain(match[1]);
      }
    }
  });

  it('keeps the fakes out of the main entry point and the client entry point', () => {
    for (const entry of ['index.ts', 'client.ts']) {
      expect(/from '\.\/fakes/.test(strip(readFileSync(join(SRC, entry), 'utf8')))).toBe(false);
    }
  });
});
