import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The learner app imports `@custar/tutor-core/client`. That bundle must stay small and free of model code: it may
 * hold the contract, the voice interfaces, Tutor Lite and the SSE codec, and nothing that reaches the pipeline,
 * the prompts, the adapters, the classifier, the patterns or the redactor. This test walks the RUNTIME import graph
 * from client.ts (type-only imports are erased and do not count) and fails if it touches any of them.
 */

const SRC = dirname(fileURLToPath(import.meta.url));
const FORBIDDEN_DIRS = ['pipeline', 'prompt', 'llm', 'safety', 'redact', 'fakes', 'evals'];
const ALLOWED_PACKAGES = new Set(['zod', '@custar/content-schema']);

function strip(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Runtime imports of a file: `import x from`, `export ... from`, side-effect imports; `import type` is skipped. */
function runtimeImports(file: string): string[] {
  const text = strip(readFileSync(file, 'utf8'));
  const found: string[] = [];
  const statement = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(statement)) {
    if (match[2] === undefined) found.push(match[4] as string);
  }
  for (const match of text.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm))
    found.push(match[1] as string);
  return found;
}

function resolveRelative(from: string, specifier: string): string {
  const base = resolve(dirname(from), specifier);
  for (const candidate of [`${base}.ts`, join(base, 'index.ts')])
    if (existsSync(candidate)) return candidate;
  throw new Error(`cannot resolve ${specifier} from ${from}`);
}

function walkGraph(entry: string): { files: string[]; packages: string[] } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop() as string;
    if (files.has(file)) continue;
    files.add(file);
    for (const specifier of runtimeImports(file)) {
      if (specifier.startsWith('.')) queue.push(resolveRelative(file, specifier));
      else packages.add(specifier);
    }
  }
  return { files: [...files].map((file) => relative(SRC, file)), packages: [...packages] };
}

describe('client.ts', () => {
  const graph = walkGraph(join(SRC, 'client.ts'));

  it('reaches the contract, voice, Tutor Lite and the SSE codec', () => {
    expect(graph.files).toEqual(
      expect.arrayContaining([
        'contract.ts',
        'voice.ts',
        'lite/engine.ts',
        'lite/match.ts',
        'lite/response.ts',
        'stream/sse.ts',
      ]),
    );
  });

  it('never reaches the pipeline, prompts, adapters, classifier, patterns, redactor or fakes', () => {
    const bad = graph.files.filter((file) =>
      FORBIDDEN_DIRS.some((dir) => file.startsWith(`${dir}/`)),
    );
    expect(bad).toEqual([]);
  });

  it('imports only zod and the content schema from outside the package', () => {
    expect(graph.packages.filter((name) => !ALLOWED_PACKAGES.has(name))).toEqual([]);
  });

  it('is small', () => {
    expect(graph.files.length).toBeLessThan(12);
  });

  it('the walker itself sees a forbidden import when there is one', () => {
    const full = walkGraph(join(SRC, 'index.ts'));
    expect(full.files.some((file) => file.startsWith('pipeline/'))).toBe(true);
    expect(full.packages).toContain('@custar/authoring-core');
  });
});
