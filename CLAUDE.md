# CUSTAR Tutor

An LMS with an interactive AI tutor for Nigerian Primary 1-6 pupils (home learning: guardians, tutors, human
helpers; children have no accounts). Lessons follow the NERDC scheme of work and are enriched per the
Master Development Brief (`docs/brief/master-development-brief.md`). The build plan lives in
`docs/plan.md`; decisions in `docs/adr/`.

## Layout

- `apps/learner` - Expo app (iOS/Android; web only for grown-ups). Child area + PIN-elevated grown-ups area.
- `apps/admin` - Expo web-first admin (content engine, users, analytics, support). Never shipped to phones.
- `packages/content-schema` - Zod schemas, lint rules, `migrate_vN` for lesson content. Pure TS, no RN imports.
- `packages/lesson-renderer` - React Native components rendering unit content (learner app + admin preview).
- `packages/design-tokens` - colours, type, spacing from the unit template (CORE teal, ENRICH amber).
- `packages/supabase` - generated DB types and typed RPC wrappers.
- `supabase/` - migrations, pgTAP tests, seeds, edge functions (`_shared/vendor` is generated).
- `scripts/` - `vendor-schema` (bundles content-schema for Deno), `check-peer-deps`.

## Commands

- `npm run typecheck` / `npm run lint` / `npm test` / `npm run format:check` - all must pass before a commit.
- `npm run vendor` - regenerate `supabase/functions/_shared/vendor/content-schema.js`; CI fails on drift.
- Supabase project: **CUSTAR Tutor** (`kjmjyxherydvefwtzmez`, eu-west-1). It is the dev database until real
  families onboard; production gets a separate project.

## Rules that must not be broken

1. **NERDC is the backbone.** The scheme objective is always fully covered and visibly dominant. Enrichment adds
   depth and never replaces or dilutes an objective (brief section 3). A lesson uses 2 to 5 enrichment sections:
   the unit template wins over the brief's "2 to 3" (ADR 0006).
2. **AI never auto-publishes.** Claude drafts; a human reviews and approves. The review UI must render every
   field the tutor will consume (tutor_script, alt text, helper script).
3. **Children's data is minimal.** No child accounts or emails. The child's real name/photo never goes to
   Claude (alias only); redact PII before any LLM call and before storing tutor input.
4. **Mastery is deterministic.** Only graded `mastery_check` items grant mastery. Tutor "evidence" is advisory.
5. **Religion-neutral, inclusive content.** Values are framed as shared virtues (brief section 14).
6. **No secrets in the repo.** `ANTHROPIC_API_KEY` exists only as a Supabase Edge Function secret.

## Database conventions

- Git is the source of truth for schema. Write `supabase/migrations/<version>_<name>.sql`; after applying
  through the Supabase MCP, run `list_migrations` and rename the file to the version the server assigned.
- Every table has RLS enabled. Helper functions are `SECURITY DEFINER`, `search_path = ''`, in the `private`
  schema, and use `(select auth.uid())`. Child-data rows carry denormalised `household_id` and `child_id`.
- Append-only tables (`progress_events`, `audit_log`, `consents`) get `REVOKE UPDATE, DELETE`.
- Draft content (`unit_versions`) is admin-only; learners read only `published_units`.
- Run `get_advisors` (security and performance) after every migration.
- Sync uses a server `sync_seq` plus tombstones, never `updated_at` cursors.

## Claude usage (edge functions)

- Models are per-task in `app_settings`: authoring `claude-opus-5-5`, tutor `claude-sonnet-5-5`,
  moderation `claude-haiku-5-5`. Set `effort` explicitly. No prefill or forced `tool_choice`.
- Use structured outputs with per-section schemas, prompt caching for the stable prefix, and log every call
  to `ai_usage`. Re-read the SDK docs for exact syntax before writing a call.
