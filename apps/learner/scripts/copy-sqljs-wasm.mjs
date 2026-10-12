// The web build (demo mode) runs SQLite through sql.js. Its wasm binary is served from /sql-wasm.wasm.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const source = join(dirname(require.resolve('sql.js')), 'sql-wasm.wasm');
mkdirSync(new URL('../public/', import.meta.url), { recursive: true });
copyFileSync(source, new URL('../public/sql-wasm.wasm', import.meta.url));
console.log('copied sql-wasm.wasm to public/');
