# ADR 0001: Monorepo with two Expo apps and shared packages

Status: accepted (M0)

## Context

CUSTAR Tutor needs a child/guardian/tutor app on iOS and Android, and a dense admin tool (scheme ingestion, unit
diffs, analytics, support). The brief requires Expo / React Native. Edge Functions (Deno) must validate the same
lesson content schema the apps use. Admin code must not reach children's phones.

## Decision

- One npm-workspaces monorepo. `apps/learner` (iOS/Android; web only for grown-ups) and `apps/admin` (Expo,
  web-first, deployed separately as a static site).
- Shared packages: `content-schema` (pure TS, Zod), `lesson-renderer` (React Native components), `design-tokens`,
  `supabase` (generated types).
- Shared packages that import React Native or Expo declare them as `peerDependencies`, never `dependencies`
  (enforced by `scripts/check-peer-deps.mjs`). This avoids a second copy of React and "Invalid hook call".
- Deno cannot import from outside `supabase/functions`, so `content-schema` is bundled by esbuild into
  `supabase/functions/_shared/vendor/content-schema.js` (`npm run vendor`). CI runs `npm run vendor:check` and fails
  on drift.
- Admin uses Expo web. Web-only components (`*.web.tsx`) are allowed for tables and diffs. If Expo web proves
  inadequate for the admin tool, only the admin shell changes; the renderer and schema are unaffected.

## Consequences

Admin and learner share one renderer, so admin previews match what children see. Two deployables to maintain.
The vendored bundle is a generated artefact that must be regenerated when the schema changes.
