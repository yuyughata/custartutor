import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The content engine runs in Deno edge functions, in the admin app's browser demo mode and in Node scripts:
 * no Node built-ins, no React Native, Expo, Supabase or Anthropic SDK imports, no environment reads and no
 * logging (request bodies and the API key must never reach a log). Only test files may use Node.
 * The adapter takes an injected client instead of importing the SDK.
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

function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('platform neutrality', () => {
  it('finds the shipped sources, the fakes among them', () => {
    expect(shipped.length).toBeGreaterThan(8);
    expect(shipped.some((file) => file.includes('/fakes/'))).toBe(true);
    expect(shipped.some((file) => file.includes('/llm/'))).toBe(true);
    expect(shipped.some((file) => file.includes('/client/'))).toBe(true);
  });

  it.each(shipped.map((file) => [relative(SRC, file), file] as const))(
    '%s imports nothing platform specific',
    (_name, file) => {
      const text = strip(readFileSync(file, 'utf8'));
      expect(FORBIDDEN_IMPORT.exec(text)?.[0]).toBeUndefined();
      expect(NODE_GLOBALS.exec(text)?.[0]).toBeUndefined();
    },
  );

  it('never logs and never names the API key', () => {
    for (const file of shipped) {
      const text = strip(readFileSync(file, 'utf8'));
      expect(LOGGING.exec(text)?.[0], `${relative(SRC, file)} logs`).toBeUndefined();
      expect(SECRETS.exec(text)?.[0], `${relative(SRC, file)} names a secret`).toBeUndefined();
    }
  });

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

  it('imports only zod and the content schema from outside the package', () => {
    const bare = /from\s+'([^./][^']*)'/g;
    for (const file of shipped) {
      const text = strip(readFileSync(file, 'utf8'));
      for (const match of text.matchAll(bare)) {
        expect(
          ['zod', '@custar/content-schema'],
          `${relative(SRC, file)} imports ${match[1]}`,
        ).toContain(match[1]);
      }
    }
  });

  it('keeps the fakes out of the main entry point', () => {
    const index = readFileSync(join(SRC, 'index.ts'), 'utf8');
    expect(/from '\.\/fakes/.test(strip(index))).toBe(false);
  });
});
