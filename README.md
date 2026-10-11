# CUSTAR Tutor

An LMS with an interactive AI tutor for Nigerian Primary 1-6 pupils. Lessons follow the NERDC scheme of work and
are enriched using the Master Development Brief. Built with Expo (React Native), Supabase and Claude.

- Build plan: [docs/plan.md](docs/plan.md)
- Architecture decisions: [docs/adr/](docs/adr/README.md)
- Content brief (source of truth for lessons): [docs/brief/master-development-brief.md](docs/brief/master-development-brief.md)
- Contributor and AI-agent rules: [CLAUDE.md](CLAUDE.md)

## Repository layout

| Path                       | What                                                               |
| -------------------------- | ------------------------------------------------------------------ |
| `apps/admin`               | Expo web-first admin (content engine, users, analytics, support)   |
| `apps/learner`             | Expo app for children, guardians and tutors (added in M1)          |
| `packages/content-schema`  | Zod schemas, lint rules, grading and migrations for lesson content |
| `packages/lesson-renderer` | React Native components that render a unit                         |
| `packages/design-tokens`   | Colours, type and spacing from the unit template                   |
| `packages/supabase`        | Generated database types                                           |
| `supabase/`                | Migrations, pgTAP tests, seeds, edge functions                     |

## Getting started

```bash
npm install
npm run typecheck && npm run lint && npm test
npm run vendor          # regenerate the Deno bundle of content-schema
cd apps/admin && npx expo start --web
```

Environment: Node 22+. Supabase project: **CUSTAR Tutor** (dev). Secrets such as `ANTHROPIC_API_KEY` live only in
Supabase Edge Function secrets, never in the repo.

## Status

M0 (foundation) in progress. See the roadmap in [docs/plan.md](docs/plan.md#10-roadmap-revised-after-review-smaller-m0-offline-de-risked-early).
