# M2 live test: checklist

Goal (M2 exit criterion): Claude drafts the Primary 1 Basic Science Term 1 units from the uploaded scheme, you
review them, and the approved ones are published and packed through the M1 path.

Everything in M2 was built and tested against a fake model (the sandbox has no Anthropic key and cannot reach
`*.supabase.co`). **No prompt has run against real Claude yet**, so expect to iterate on the first results; that is
normal and the report below tells me what to change. Steps marked **you** need your accounts.

## A. One-time setup (you)

1. **Admin account.** Same as M1 step 2 in [m1-device-test.md](m1-device-test.md): an account with TOTP in
   `admin_users`. Admin sign-in uses the email code, so the _Magic Link_ email template must contain `{{ .Token }}`.
2. **Anthropic key as an Edge Function secret** (dashboard, Edge Functions, Secrets): `ANTHROPIC_API_KEY`. Also
   `ALLOWED_ORIGINS` = the origin your admin app is served from (comma-separated; `http://localhost:<port>` is always
   allowed for development). **Never paste the key in chat.**
3. **Deploy from the repo with the CLI** (the bundles are too large for the MCP deploy):
   `supabase functions deploy ai-job get-pack-download publish-pack`.
4. **Spending guard, before the first run:** open the admin app, Usage and settings, and set a **per-job cap** and a
   **daily cap** (US dollars) you are comfortable with, and enter the **price per million tokens** for the models you
   use (the app never guesses prices; unpriced calls show as "unknown" and are not counted against the caps). The
   kill switch stops every new step immediately.
5. Optional, so I can run the live evaluation from my cloud session: add the same key as an **environment secret**
   (the cloud environment's settings, then start a new session). I never need it in chat.

## B. Run the admin app (you)

```bash
cd apps/admin
cp .env.example .env     # set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_KEY (the publishable key)
npm run web
```

## C. The walk-through (you)

| #   | Do this                                                                                                                                        | Expect                                                                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| 1   | Sign in (email code, then authenticator code).                                                                                                 | Home. No "DEMO" banner.                                                                             |
| 2   | Characters: check Zari (female, 7) and Zuri (male, almost 5). Fill the relationship and personality only if you decide.                        | Only the facts you entered are used by the generator.                                               |
| 3   | Schemes, New scheme: Basic Science, Primary 1, Term 1 (use another term if Term 1 is already seeded) and the scheme PDF from `docs/reference`. | The job reads the PDF. A draft of the weeks appears with flags. Compare it to the PDF line by line. |
| 4   | Fix anything wrong, **Save as draft**, then **Approve** (reviewer or super admin).                                                             | Status approved.                                                                                    |
| 5   | Chapter planner: Propose chapters, edit, **Apply plan**.                                                                                       | Chapters of 3 to 5 units each.                                                                      |
| 6   | Open one unit and **Draft with Claude**. Do ONE unit first.                                                                                    | A progress list of about 19 steps, then a draft with a lint panel and review flags.                 |
| 7   | Read the whole draft in all three tabs. Try **Revise with Claude** ("make the opener shorter").                                                | A new version with a section-level diff.                                                            |
| 8   | Submit for review, approve, publish, then build the pack.                                                                                      | The M1 learner app can download it.                                                                 |

## D. What to send me

- The job's final state if it fails (Jobs, open it: step name and message; no secrets are in it).
- Lint errors and review flags of the first draft, and three places you disliked the writing or the facts. Those drive
  the prompt changes (the prompt version is stored on every draft).
- Usage and cost for the first unit, so we can calibrate the plan's estimate.

## E. Housekeeping (you, once)

Two superseded functions could not be dropped through the MCP; run as the database owner in the SQL editor, then I
regenerate the types:

```sql
drop function public.ai_job_fail_step_deprecated(uuid, uuid, text, jsonb, boolean);
drop function private.ai_job_fail_step_deprecated(uuid, uuid, text, jsonb, boolean);
```

## What this cannot cover yet

Illustrations are still descriptions (placeholders). Real Claude quality, the request parameters against the live API
and the deployed function are unverified until you run this. Reviewer and subject-matter sign-off of the drafted
units is a human step; Claude's own review flags are advisory.
