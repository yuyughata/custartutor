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
| `src/tutor/`    | The tutor panel in the lesson player, the offline Tutor Lite runner, the turn state and its tests  |
| `src/consent/`  | The grown-ups AI tutor screen: consent wording and state, transcripts, the PIN gate for them       |

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

## The tutor (M3.3a)

Children reach the tutor from the lesson screen with **Ask my tutor**. It opens a full-screen sheet; closing it keeps the
conversation for as long as the lesson screen is open. Nothing a child types is stored on the phone or logged, and the
conversation is gone when the lesson is left.

| Situation                                      | What the child gets                                                                   |
| ---------------------------------------------- | ------------------------------------------------------------------------------------- |
| Online, consent on, tutor enabled on server    | The AI tutor: streamed replies (`runtime.tutor.sendTurn`), a calm "Thinking…" state   |
| Online, a grown-up has not turned it on        | "Ask a grown-up to turn on the tutor" (no PIN here) and the offline tutor             |
| Offline, or the server cannot be reached       | **Tutor Lite**: the unit's own `tutor_script`, run on the phone with no model         |
| `daily_limit`, `tutor_disabled`, `kill_switch` | A short calm card ("That is enough tutor chat for today") and the offline tutor       |
| A dropped stream                               | "Try again" asks `fetch_turn` first and only resends when the server has no such turn |

- **Tutor Lite** picks the part of the lesson the child last answered a question in, if it has a script; otherwise it asks
  "Which part?". The engine's own state is saved after every step in `tutor_lite_state` (learner-core migration 4), so a
  restart resumes. It never changes mastery and never writes a progress event: mastery stays with the lesson's mastery check.
- `pre_reader` children get big quick-reply buttons ("Say it again", "Tell me more", "I do not understand"; in Tutor Lite, the
  options of a multiple-choice question) and a labelled **Listen** button on every tutor bubble, read slowly; readers get a
  small speaker. The Listen buttons only appear when the voice seam (`useVoice`) says speech is available.
- **Demo mode** uses the in-memory `createDemoTutorApi` of tutor-core (loaded only in demo mode). A turn runs through the real
  redaction, rule list, router and sanitiser, so a crisis sentence gets the real fixed reply and is withheld from the transcript;
  only the tutor's wording is scripted, and the demo has no model to judge "off topic". Every tutor bubble carries "Demo tutor:
  not Claude", the panel says so, and a "Demo only" button pretends the internet is off so Tutor Lite can be tried. Nothing in
  demo mode is the real tutor.
- **Grown-ups** (`/grownups/tutor/<childId>`): the consent wording from `docs/tutor-consent-draft.md` (a "DRAFT WORDING: not
  final" banner shows while `CURRENT_TUTOR_CONSENT_VERSION` contains "draft"; `[bracketed]` placeholders are highlighted), a
  required checkbox that is never pre-ticked, Turn on (needs the PIN elevation) and Turn off, and read-only transcripts. A
  withheld part shows a neutral placeholder and "A CUSTAR reviewer is looking at this part." and nothing else. If the
  elevation has lapsed the screen asks for the PIN again. Offline it says these need the internet. There is no export and no
  delete in M3.

Live path (`src/platform/supabaseTutorApi.ts`): RPCs `get_tutor_consent`, `set_tutor_consent`, `list_tutor_sessions`,
`get_tutor_transcript`, and `POST {url}/functions/v1/tutor-chat` with the session's access token and the publishable key,
streamed through `expo/fetch` on native and the browser's fetch on the web. **It has not been run against Supabase or a
real network**; the tests use a fake client and a fake fetch.

### Tutor checks

```bash
npx vitest run apps/learner packages/learner-core        # unit tests (turn state, retry, Tutor Lite, consent, SSE client)
npm run build:web
node scripts/serve-dist.mjs dist 8126 &
node scripts/e2e-tutor.mjs <screenshot-dir> http://127.0.0.1:8126
```

`e2e-tutor.mjs` walks the whole tutor flow in demo mode in a real browser (consent, a lesson chat, redaction, the fixed safe
reply, the withheld transcript, offline Tutor Lite and resuming it) and saves a screenshot at each step, at 390 px wide and
at a larger size. It cannot check native keyboards, streaming over a mobile network or speech on a device.

## Helper mode, read-aloud and worksheets (M3.3b)

### Read-aloud (`src/voice/`)

`createExpoSpeechSynthesizer()` (`voice/expoSpeech.ts`, passed to `VoiceProvider` in `app/_layout.tsx`) is the real
`SpeechSynthesizer`. On Android and iOS it speaks through `expo-speech`; in a browser it uses the Web Speech API directly (not
`expo-speech`'s web module, whose voice lookup never answers in a browser with no voices). It picks the best installed voice
(`en-NG`, then nearby English, then plain `en`), strips `**` markers, reads long text as short pieces, stops what is speaking
before it starts something new, resolves when speech ends or is stopped, and **never throws**. A phone or browser with no voice
reports itself unavailable, and every speaker button then renders nothing.

- `useReadAloud({ readingMode })` (`voice/useReadAloud.ts`): `available`, `speak(text, key)`, `toggle(key, text)`, `stop()`,
  `speakingKey`. All buttons share one controller (`voice/readAloud/controller.ts`), so each knows whether _it_ is the one
  speaking. `speakingId` and `toggle(id, text)` match the tutor panel's own hook in `src/tutor/useReadAloud.ts`.
- `SpeakerButton` (48 px target, accessible name "Read this aloud", "Stop reading aloud" while it speaks) and `SpeedChoice`
  (Slow / Normal). A child who cannot read yet starts on Slow (rate 0.7); everyone else on Normal (1).
- **The speed choice is kept in memory only**: learner-core has no general settings store (its `meta` table takes only its own
  typed keys), so it returns to the default when the app restarts. To persist it, add a `META` key in learner-core and read and
  write it in `voice/readAloud/prefs.ts` (the only place that holds it).
- No voice input exists: the recognizer is still the no-op (M5).
- Wiring a speaker into the lesson player is three optional props on `UnitView` (all default to "nothing", so the player is
  unchanged until it passes them):

  ```tsx
  <UnitView
    renderSectionExtras={(s) => <SpeakerButton text={sectionSpeechText(s, lesson.unit.questions)} readingMode={mode} />}
    renderQuestionExtras={(q) => <SpeakerButton text={questionSpeechText(q)} readingMode={mode} />}
    largeTargets={mode === 'pre_reader'}
    ...
  />
  ```

  `sectionSpeechText` / `questionSpeechText` (in `@custar/lesson-renderer`) say headings, text, picture descriptions and a
  question's options, and never a hint, an explanation or an answer.

### Helper mode (`src/helper/`, routes `grownups/helper/[childId]` and `helper/[childId]/[unitId]`)

A grown-up (the guardian) starts a **helper session** for a child who cannot read yet and reads the lesson with them.

1. **Launcher** (`/grownups/helper/<childId>`, behind `GrownupGate`: the PIN is asked again when the grown-up elevation has
   lapsed). Lists the child's lessons (mastery locks respected), downloads a lesson or **its grown-up pack** when that is
   missing, and starts the session. Emphasised for `pre_reader` children, offered for every child.
2. **Get ready**: the NERDC objective, the materials (grown-up pack), the timing and the timetable of periods, the reading
   speed and, for a pre-reader on a phone that can speak, the narration switch (on by default).
3. **The session** runs in **child mode**: no back arrow; the iOS swipe-back is off; the Android back button asks for the PIN;
   the navigation stack is cleared on the way in, so the browser Back button cannot return to an unlocked grown-ups area; the
   only way out is **Finish**, which needs the PIN. One section at a time with a progress strip, **Previous / Next**, **Listen**
   (read this section aloud) and **I read it**. On a phone there are two tabs, **Helper script** (the helper's steps and the
   teacher's say / ask / watch-for, from the grown-up pack) and **the child's page** (the same renderer, student mode); on a wide
   screen they sit side by side. Pre-readers get big answer buttons with a shape on each ("tap the star").
4. **Narration** (pre-readers, switch on): each section is read aloud when it opens, **once**, with a Stop button, and only
   after the helper pressed "Start the lesson".
5. **The mastery check** is the normal one: every answer goes through `LessonSession`, is graded on the phone and queued as an
   ordinary event, and only `submitMasteryCheck()` can grant mastery. There is **no new event type and the wire contract is
   untouched**. "I read it" records the existing `section_completed` event. That a helper was present is local UI state only.

**Integration point for the tutor panel:** inside a helper session `useHelperPresent()` (`src/helper/HelperContext.tsx`) is
`true` and `useHelperPresence()` gives `{ childId, unitId, readingMode, sectionId }`; it is `false`/`null` everywhere else. The
tutor panel can read it to let the helper type the child's reply. It must not be sent to the server.

The grown-up pack is downloaded with the lesson by default (`DownloadManager`, `includeGrownup` defaults to true), so a phone
normally has both. If only the learner pack is there the launcher and the session show "Download the grown-up pack", which calls
`downloadUnit` again for the active version; verified files are kept and only the grown-up files are fetched.

### Worksheets (`src/worksheets/`, route `grownups/worksheets/[childId]`)

Printable A4 sheets, made on the phone from the lesson pack already downloaded, so they work offline. Per downloaded lesson:
**Worksheet (for the child)**, **Answers (for the grown-up)** and, under **More practice**, each reviewed `practice_variants` pool
as a worksheet with its answers (nothing is generated on demand).

- `buildWorksheetHtml.ts` is a **pure** module: lesson in, one HTML string out (A4 portrait, black on white, print CSS with
  `break-inside` rules, a CUSTAR header, "Name ____ Date ____" with the child's nickname optionally prefilled, the NERDC
  objective, intro, Tier 1/2/3, the 60-second drill as a grid, Take It Home; the answers sheet adds the answers, the answer
  note and the not-yet text). Every question kind has a printable form (mcq boxes, blanks as lines, match as two columns with
  numbers and letters, circle options, sort as a table, tap_image as a described picture task, draw box, ruled lines,
  "say it out loud" tick box). All lesson text is escaped; `**bold**` becomes `<strong>`. It uses only the **learner pack**
  (`workbook`, `questions`, `header`): that pack holds the answer specs the offline grader needs, so the answers sheet needs no
  grown-up pack and no network. Answer letters and numbers are the same ones the worksheet prints.
- **Print** (`expo-print`) and **Share as PDF** (`printToFileAsync` then `expo-sharing`) on a phone; in a browser, Print prints
  the sheet in a hidden frame (the browser offers Save as PDF) and there is an in-page preview. Buttons stay off while the sheet is
  being built or exported. Every failure is a plain sentence (`worksheets/printWorksheet.ts`); none throws.

### Checks

```bash
npx vitest run packages/lesson-renderer packages/learner-core apps/learner
npx expo export --platform web --output-dir dist && node scripts/serve-dist.mjs dist 8141 &
node scripts/e2e-helper.mjs <screenshot-dir> http://127.0.0.1:8141
```

`e2e-helper.mjs` runs four browser sessions in demo mode (helper session with the graded mastery check and the PIN to leave;
a **fake** speech engine for the read-aloud rules; a desktop-width session with a lapsed grown-up elevation; the browser Back
button) and exports the worksheet, answers and practice sheets to PDF with Playwright (checked with `pdfinfo` / `pdftotext`).
**It cannot prove**: real text-to-speech voices (the engine in it only records what it is asked to say), native printing and
sharing, the Android back button, or real touch input. Those need a real Android phone.
