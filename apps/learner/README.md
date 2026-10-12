# CUSTAR learner app

The offline-first app for children, guardians and tutors (Expo SDK 57, expo-router). It runs on the engine in
`packages/learner-core` and renders lessons with `packages/lesson-renderer`.

## Run it

```bash
npm install                     # from the repo root
cd apps/learner
npm run web                     # browser, demo mode (no backend needed)
npx expo start                  # native: scan the QR code with a development build
```

**Demo mode** is used whenever `EXPO_PUBLIC_SUPABASE_URL` / `EXPO_PUBLIC_SUPABASE_KEY` are not set. The server is
an in-memory fake seeded with a family (Ada and Tobi, PIN `2468`) and three units built from the content fixtures.
Sign in with any email and the code `123456`. In a browser the data lives in memory, so reloading starts over.

**Live mode** talks to the Supabase project. Create `apps/learner/.env`:

```
EXPO_PUBLIC_SUPABASE_URL=https://<project-ref>.supabase.co
EXPO_PUBLIC_SUPABASE_KEY=<publishable key>
```

Only the publishable key belongs here. Never put the service role key or any Anthropic key in the app.

## Layout

| Path            | What                                                                                               |
| --------------- | -------------------------------------------------------------------------------------------------- |
| `src/app/`      | Screens (expo-router): sign-in, verify, family setup, PIN, children, child home, player, grown-ups |
| `src/runtime/`  | Builds the engine from the platform adapters (live or demo) and provides it to the screens         |
| `src/platform/` | Adapters for expo-sqlite (sql.js on web), expo-file-system, expo-crypto, SecureStore, Supabase     |
| `src/data/`     | Queries that turn the local database into screen data                                              |
| `src/ui/`       | Buttons, text fields, cards and the top bar                                                        |

## Checks

```bash
npx tsc --noEmit
npm run build:web
node scripts/serve-dist.mjs dist 8125 &
PLAYWRIGHT_PATH=/path/to/node_modules/ node scripts/e2e-demo.mjs ./e2e-out http://127.0.0.1:8125
```

The browser run walks sign-in, PIN, download, play, mastery and sync and saves a screenshot at each step. It
cannot verify native behaviour (WAL, exclusive transactions, process death, the Keystore), which needs a real
Android phone (docs/m1-plan.md, M1.4).
