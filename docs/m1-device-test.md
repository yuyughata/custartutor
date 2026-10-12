# M1 device test: checklist

Goal (M1 exit criterion): on a real budget Android phone, a guardian signs in, creates a child and a PIN,
downloads Unit 2 on Wi-Fi, switches to airplane mode, plays the unit, passes the mastery check (which unlocks
the next unit), reconnects, and the progress syncs to the server.

Everything marked **you** needs your accounts or your phone. I cannot do these from the build environment
(outbound traffic to Supabase and Expo is blocked there, and the steps need your logins).

## A. One-time server setup (you, about 20 minutes)

1. **Email sign-in codes.** Supabase dashboard, Authentication, Email: keep the email provider on, and edit the
   _Magic Link_ and _Confirm signup_ templates so they include the six-digit code, `{{ .Token }}`. The default
   template sends a link, which the app does not use. Set up custom SMTP (Authentication, SMTP settings): the
   built-in mailer allows only a few emails an hour.
2. **First admin.** Sign up once with your own email in the dashboard, then enrol TOTP MFA for that account
   (every admin policy needs `aal2`). In the SQL editor run:
   `insert into public.admin_users (user_id, role) values ('<your auth user id>', 'super_admin');`
3. **Deploy the edge functions from the repo with the CLI** (the copies deployed so far use a trimmed bundle):
   `supabase login`, `supabase link --project-ref kjmjyxherydvefwtzmez`, `supabase functions deploy get-pack-download publish-pack`.
4. **Build the golden pack.** Signed in as that admin at `aal2`, call
   `POST https://kjmjyxherydvefwtzmez.supabase.co/functions/v1/publish-pack` with body
   `{"published_unit_id": "31f5546d-79dd-475e-bd8b-402d3f38a835"}` and your session token. A successful call
   returns the manifest hash; the unit then appears in `sync_pull`.
5. Tell me when 1 to 4 are done and I will run the server-side checks (`sync_pull` showing the pack, and a
   `get-pack-download` call), or send me any error text you see.

## B. Build the app (you)

1. `npm install -g eas-cli`, `eas login`, then in `apps/learner`: `eas init` (creates your Expo project id).
2. Set the two public variables for the build (the key is the project's **publishable** key, shown in the
   dashboard under Project Settings, API Keys):
   `eas env:create --name EXPO_PUBLIC_SUPABASE_URL --value https://kjmjyxherydvefwtzmez.supabase.co --environment preview --visibility plaintext`
   `eas env:create --name EXPO_PUBLIC_SUPABASE_KEY --value <publishable key> --environment preview --visibility plaintext`
   (Flags differ between eas-cli versions; `eas env:create --help` shows yours. I could not run `eas` here.)
3. `eas build --platform android --profile preview`. When it finishes, open the link on the phone and install
   the APK (allow installs from your browser when asked).

## C. The test run (you, on the phone)

| #   | Do this                                                                               | Expect                                                                         |
| --- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| 1   | Open the app on Wi-Fi. Enter your email, then the 6-digit code from the email.        | You land on "Set up your family".                                              |
| 2   | Name the family. Create a PIN (4 digits).                                             | You reach "Who is learning today?" (no children yet).                          |
| 3   | Grown-ups, enter the PIN, Add a child (a nickname, Primary 1).                        | The child appears. A wrong PIN is rejected.                                    |
| 4   | Back to the child picker, pick the child. Tap "Download to this phone" on Unit 2.     | The lesson shows "saved on this phone".                                        |
| 5   | Switch on **airplane mode**. Close the app completely, then open it again.            | It opens straight to the children; the lesson still plays.                     |
| 6   | Play Unit 2. Answer the "Have I Got It?" questions, press Check on each, then finish. | "Well done" at 80% or more; Unit 4 unlocks. A low score shows "Not yet".       |
| 7   | Still offline, open Grown-ups, enter the PIN.                                         | It opens; the page says some changes need the internet; updates are "waiting". |
| 8   | Switch airplane mode off. Grown-ups, "Sync now".                                      | "Synced", and the waiting count goes to 0.                                     |
| 9   | Tell me the child's name; I check the server shows the unit as mastered.              | One `unit_progress` row, status `mastered`.                                    |

Also note: how long the download took, whether anything felt slow, the phone model and Android version, and any
screen that looked wrong. Budget phones are the point of this test.

## What this test cannot cover yet

No tutor chat, voice or worksheets. Illustrations are dashed placeholders. Only one real unit exists on the
server. Entitlements and billing do not exist, so any signed-in household can download any built pack.
