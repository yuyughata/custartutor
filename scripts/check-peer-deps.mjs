#!/usr/bin/env node
// Shared packages must declare React / React Native / Expo modules as peerDependencies,
// never as dependencies. Otherwise the app bundles a second copy of React and hooks break
// with "Invalid hook call". Apps (apps/*) are allowed to depend on them directly.
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const packagesDir = join(root, 'packages');
const FORBIDDEN_AS_DEPENDENCY =
  /^(react|react-dom|react-native|react-native-web|expo|expo-.+|@expo\/.+)$/;

let failed = false;
for (const name of readdirSync(packagesDir)) {
  const pkgPath = join(packagesDir, name, 'package.json');
  if (!existsSync(pkgPath)) continue;
  const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
  for (const field of ['dependencies']) {
    for (const dep of Object.keys(pkg[field] ?? {})) {
      if (FORBIDDEN_AS_DEPENDENCY.test(dep)) {
        console.error(`packages/${name}: "${dep}" must be a peerDependency (found in ${field}).`);
        failed = true;
      }
    }
  }
}

if (failed) process.exit(1);
console.log('peer-deps check passed');
