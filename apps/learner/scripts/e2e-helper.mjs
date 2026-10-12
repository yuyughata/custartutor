/* global window, document */
// End-to-end check of HELPER MODE, READ-ALOUD and WORKSHEETS in a real browser (demo mode, no backend).
//
//   cd apps/learner && npx expo export --platform web --output-dir dist
//   node scripts/serve-dist.mjs dist 8141 &
//   node scripts/e2e-helper.mjs <screenshot-dir> http://127.0.0.1:8141
//
// Four browser runs (each a fresh in-memory demo household: sign in with any email, code 123456, PIN 2468):
//   1. Tobi (cannot read yet), a browser with NO voices (headless Chromium): helper session, tabs, navigation, big
//      buttons, the graded mastery check, leaving with the PIN, then worksheets, answers and a practice set exported to PDF;
//   2. Tobi again with a FAKE speech engine installed in the page: read-aloud available, narration starts only after the
//      lesson starts, once per section, with a stop button, slow by default, speed choice honoured;
//   3. Ada (reads and writes) at desktop width: two-column helper layout, no narration, no big buttons, and the PIN being
//      asked again after the grown-up elevation lapses (page clock moved on 11 minutes);
//   4. the browser Back button cannot get out of a helper session into the grown-ups area.
//
// WHAT THIS CANNOT PROVE: real text-to-speech voices (the engine in runs 2-3 is a fake that only records what it is
// asked to say), native printing and sharing (expo-print / expo-sharing on a phone), the Android back button, a real
// device's touch behaviour. Playwright's page.pdf() prints the HTML the app built, which proves the page, not the phone.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Playwright is not a repo dependency: point PLAYWRIGHT_PATH at a node_modules that has it.
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const OUT = process.argv[2];
const BASE = process.argv[3];
if (!OUT || !BASE) {
  console.error('usage: node scripts/e2e-helper.mjs <screenshot-dir> <base-url>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });

const failures = [];
const notes = [];
let step = 0;
const check = (ok, message) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${message}`);
  if (!ok) failures.push(message);
};
const note = (message) => {
  console.log(`NOTE  ${message}`);
  notes.push(message);
};

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});

/** A page with console collection, step screenshots and a few helpers. */
async function openPage({ width = 390, height = 844, fakeSpeech = false, clock = false } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  const logs = [];
  page.on('console', (m) => {
    if (['error', 'warning'].includes(m.type()))
      logs.push(`${m.type()}: ${m.text().slice(0, 240)}`);
  });
  page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message.slice(0, 300)}`));
  if (clock) await page.clock.install();
  if (fakeSpeech) {
    // A speech engine that only records what it is asked to say. It has one voice (en-NG) and "speaks" each piece for
    // window.__speakMs milliseconds. Real voices are NOT tested here.
    await page.addInitScript(() => {
      const spoken = [];
      window.__spoken = spoken;
      window.__speakMs = 250;
      window.__speakingNow = null;
      window.__cancels = 0;
      window.__cancelledSpeech = 0;
      let current = null;
      const voice = {
        voiceURI: 'fake-ng',
        name: 'Fake Ezinne',
        lang: 'en-NG',
        default: true,
        localService: true,
      };
      const synth = {
        speaking: false,
        getVoices: () => [voice],
        speak(u) {
          spoken.push({
            text: u.text,
            lang: u.lang,
            rate: u.rate,
            voice: u.voice && u.voice.voiceURI,
          });
          current = u;
          window.__speakingNow = u.text;
          u.__t = setTimeout(() => {
            if (current === u) current = null;
            window.__speakingNow = null;
            u.onend?.();
          }, window.__speakMs);
        },
        cancel() {
          window.__cancels += 1;
          if (!current) return;
          window.__cancelledSpeech += 1;
          const u = current;
          current = null;
          clearTimeout(u.__t);
          window.__speakingNow = null;
          u.onerror?.();
        },
        addEventListener() {},
        removeEventListener() {},
      };
      Object.defineProperty(window, 'speechSynthesis', { value: synth, configurable: true });
      window.SpeechSynthesisUtterance = function (text) {
        this.text = text;
        this.lang = '';
        this.rate = 1;
        this.voice = null;
      };
    });
  }
  const shot = async (name, opts = {}) => {
    step += 1;
    await page.waitForTimeout(400);
    await page.screenshot({
      path: join(OUT, `${String(step).padStart(2, '0')}-${name}.png`),
      ...opts,
    });
    console.log(`shot ${String(step).padStart(2, '0')}-${name}`);
  };
  const btn = (name, exact = true) => page.getByRole('button', { name, exact });
  const back = () => page.locator('[role=button][aria-label="Go back"]:visible').last().click();
  return { context, page, logs, shot, btn, back };
}

async function signIn({ page, btn }) {
  await page.goto(`${BASE}/`);
  await page.getByText('Welcome to CUSTAR Tutor').waitFor({ timeout: 30000 });
  await page.getByLabel("Grown-up's email").fill('parent@example.com');
  await btn('Send me a code').click();
  await page.getByLabel('6-digit code').fill('123456');
  await btn('Sign in').click();
  await page.getByText('Enter your grown-up PIN').waitFor({ timeout: 20000 });
  await page.getByLabel('Your PIN').fill('2468');
  await btn('Continue').click();
  await page.getByText('Who is learning today?').waitFor({ timeout: 20000 });
}

async function openGrownups({ page, btn }) {
  await btn('Grown-ups').click();
  await page.getByText('Grown-ups only').waitFor();
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Open').click();
  await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
}

/** The nth "Helper mode" / "Worksheets" button on the dashboard: children are listed Ada then Tobi. */
const CHILD = { ada: 0, tobi: 1 };

/** Waits until the fake speech engine has had nothing new to say for a moment. */
async function settleSpeech(page) {
  let last = -1;
  for (let i = 0; i < 40; i += 1) {
    const now = await page.evaluate(() => window.__spoken.length);
    const idle = await page.evaluate(() => window.__speakingNow === null);
    if (now === last && idle) return now;
    last = now;
    await page.waitForTimeout(700);
  }
  return last;
}

async function answerMasteryCheck({ page, btn }) {
  const sortItems = {
    classroom: 'At school',
    playground: 'At school',
    'staff room': 'At school',
    kitchen: 'At home',
    bedroom: 'At home',
    'living room': 'At home',
  };
  for (const [item, cat] of Object.entries(sortItems)) {
    const label = page.getByText(item, { exact: true }).last();
    const row = label.locator('xpath=following-sibling::div[1]');
    await row.getByRole('button', { name: cat, exact: true }).click();
  }
  for (const [l, r] of [
    ['At home', 'family'],
    ['At school', 'teachers and friends'],
    ['Near our home', 'neighbours'],
  ]) {
    await btn(l).last().click();
    await btn(r).last().click();
  }
  for (const o of [
    "Hold a grown-up's hand near the road",
    'Put rubbish in the bin',
    'Wash your hands after using the toilet',
  ])
    await btn(o).last().click();
  const checks = btn('Check');
  const n = await checks.count();
  for (const i of [n - 3, n - 2, n - 1]) await checks.nth(i).click();
}

async function sectionLabel(page) {
  return (
    (await page
      .getByText(/^Section \d+ of \d+$/)
      .first()
      .textContent()) ?? ''
  );
}

async function goToSection(page, btn, target) {
  for (let i = 0; i < 30; i += 1) {
    const label = await sectionLabel(page);
    if (label === `Section ${target} of 14`) return;
    await btn('Next').click();
    await page.waitForTimeout(80);
  }
  throw new Error(`could not reach section ${target}`);
}

// =============================================================================================================
// PDF helpers (Playwright prints the HTML the app built; poppler reads the result)
// =============================================================================================================
function sh(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8' });
  } catch (error) {
    return `ERROR ${error.message}`;
  }
}
const havePoppler = ['pdfinfo', 'pdftotext', 'pdftoppm'].every(
  (tool) => !sh('which', [tool]).startsWith('ERROR'),
);

async function exportPdf(context, html, name) {
  const pdfPage = await context.newPage();
  await pdfPage.setContent(html, { waitUntil: 'load' });
  await pdfPage.emulateMedia({ media: 'print' });
  const path = join(OUT, `${name}.pdf`);
  await pdfPage.pdf({ path, format: 'A4', printBackground: true, preferCSSPageSize: true });
  await pdfPage.close();
  const info = sh('pdfinfo', [path]);
  const pages = Number(/Pages:\s+(\d+)/.exec(info)?.[1] ?? 0);
  const size = /Page size:\s+(.*)/.exec(info)?.[1] ?? '';
  // one line of single-spaced words, so a line break or column gap in the PDF does not hide a phrase
  const text = sh('pdftotext', ['-layout', path, '-']).replace(/\s+/g, ' ');
  sh('pdftoppm', ['-png', '-r', '60', path, join(OUT, name)]);
  return { path, pages, size, text };
}

// =============================================================================================================
// RUN 1: Tobi, no voices in the browser. Helper session, graded mastery, PIN to leave, then worksheets.
// =============================================================================================================
async function run1() {
  console.log('\n=== RUN 1: Tobi (cannot read yet), a browser with no voices ===');
  const { context, page, logs, shot, btn, back } = await openPage();
  await signIn({ page, btn });
  await openGrownups({ page, btn });
  await shot('dashboard');

  // ---- launcher ----
  await btn('Helper mode').nth(CHILD.tobi).click();
  await page.getByText('Tobi cannot read yet, so helper mode is made for you both.').waitFor();
  check(true, 'launcher is emphasised for the pre-reader (Tobi)');
  check(
    await page.getByText('Reading aloud is not available on this phone').isVisible(),
    'no voices: the launcher says reading aloud is unavailable and offers no narration switch',
  );
  check(
    (await page.getByRole('switch').count()) === 0,
    'no narration switch is shown when the phone cannot speak',
  );
  check(
    (await page.getByRole('radio').count()) === 0,
    'no speed choice is shown when the phone cannot speak',
  );
  await shot('launcher-before-download');

  await btn('Download to this phone').nth(1).click(); // Basic Science (Maths is listed first)
  await btn('Start helper session').waitFor({ timeout: 20000 });
  check(
    (await btn('Start helper session').count()) === 1,
    'only the downloaded lesson can be started',
  );
  await shot('launcher-ready');

  // ---- get ready ----
  await btn('Start helper session').click();
  await page.getByText('Before you start').waitFor({ timeout: 20000 });
  check(
    await page.getByText(/Objective \(NERDC\):/).isVisible(),
    'get-ready page shows the NERDC objective',
  );
  check(
    await page.getByText('Chalk or marker and a board, to list places and people.').isVisible(),
    'get-ready page lists the materials from the grown-up pack',
  );
  check(
    await page.getByText(/Two 60-minute periods/).isVisible(),
    'get-ready page shows the manual timing note',
  );
  check(
    await page.getByText('Period 1 · 60 minutes').isVisible(),
    'get-ready page shows the session plan periods',
  );
  check(
    (await page.getByRole('switch').count()) === 0,
    'no narration switch on the get-ready page without a voice',
  );
  await page.getByRole('checkbox').first().click();
  await shot('get-ready');
  await page.mouse.wheel(0, 900);
  await shot('get-ready-bottom');

  // ---- child mode: no way out except the PIN ----
  check(
    (await page.locator('[role=button][aria-label="Go back"]:visible').count()) === 0,
    'helper session has no back arrow',
  );
  check(await btn('Finish helper session').isVisible(), 'helper session has a Finish button');

  // ---- section 1: helper script is visible, narration/speaker hidden ----
  await btn('Start the lesson').click();
  await page.getByText('Section 1 of 14').waitFor({ timeout: 10000 });
  check(
    await page.getByText('Read the story aloud, one paragraph at a time.').isVisible(),
    'helper steps are shown for the section',
  );
  check(
    await page.getByText('SAY', { exact: true }).isVisible(),
    'say / ask / watch-for lines are shown',
  );
  check(await page.getByText('WATCH FOR', { exact: true }).isVisible(), 'watch-for line is shown');
  check(
    (await page.getByRole('button', { name: 'Read this aloud' }).count()) === 0,
    'Listen / speaker buttons are hidden without a voice',
  );
  check(
    (await page.getByRole('tab', { name: 'Helper script' }).getAttribute('aria-selected')) ===
      'true',
    'the helper script tab is open first (no narration)',
  );
  await shot('section-1-helper');

  await btn('Show Tobi the page').click();
  await page.getByText('Zari and Zuri now know that their environment').waitFor();
  check(
    !(await page.getByText('For the helper').first().isVisible()),
    "the child's page shows no helper text",
  );
  await shot('section-1-child-page');

  // ---- navigation: I read it, next, previous ----
  await btn('I read it').click();
  await page.getByText('Section 2 of 14').waitFor();
  check(true, '"I read it" moves on to the next section');
  check(
    (await page.getByLabel(/^Section 2 of 14\. 1 read\./).count()) === 1,
    'the progress strip counts the section the helper has read',
  );
  await btn('Next').click();
  await btn('Next').click();
  await page.getByText('Section 4 of 14').waitFor();
  await btn('Previous').click();
  await page.getByText('Section 3 of 14').waitFor();
  check(true, 'next / previous move one section at a time');
  check(
    await page
      .getByText('Read each place aloud and point to the picture or the real place.')
      .isVisible(),
    'the helper steps change with the section',
  );
  await shot('section-3-helper');
  await page.getByRole('tab', { name: "Tobi's page" }).click();
  await shot('section-3-child-page');

  // ---- mastery check with big picture buttons ----
  await goToSection(page, btn, 14);
  check(await btn('Next').isDisabled(), 'Next is off on the last section');
  await page.getByRole('tab', { name: 'Helper script' }).click();
  check(
    await page.getByText('This is the mastery check.').isVisible(),
    'the mastery check carries a "no hints" note for the helper',
  );
  check(
    await page.getByText('Do not give hints or answers during the check.').isVisible(),
    'the helper script itself says not to give hints during the check',
  );
  await shot('mastery-helper');
  await page.getByRole('tab', { name: "Tobi's page" }).click();
  check(
    (await page.getByText('●', { exact: true }).count()) > 0,
    'a pre-reader gets a shape on each big answer button',
  );
  check(
    await btn("I'm finished: check my progress").isDisabled(),
    'the check button is off until every question has an answer',
  );
  const tap = await page
    .getByRole('button', { name: 'At school', exact: true })
    .first()
    .boundingBox();
  check(
    tap !== null && tap.height >= 72,
    `answer buttons are big (${Math.round(tap?.height ?? 0)}px tall)`,
  );
  await shot('mastery-child-page');
  await answerMasteryCheck({ page, btn });
  check(
    await btn("I'm finished: check my progress").isEnabled(),
    'the check button turns on once every question is answered',
  );
  await shot('mastery-answered');
  await btn("I'm finished: check my progress").click();
  await page.getByText('Well done!').waitFor({ timeout: 10000 });
  check(true, 'the graded mastery check passed (80% or more) through the normal lesson session');
  await shot('result-passed');

  // ---- leaving needs the PIN ----
  await btn('Finish helper session').last().click();
  await page.getByText('Enter the grown-up PIN to leave.').waitFor();
  await shot('finish-pin');
  await page.getByLabel('Grown-up PIN').fill('1111');
  await btn('Finish and go to Grown-ups').click();
  await page.getByText('That PIN is not right.').waitFor();
  check(true, 'a wrong PIN does not end the helper session');
  await shot('finish-wrong-pin');
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Finish and go to Grown-ups').click();
  await page.getByText('Grown-ups only').waitFor({ timeout: 10000 });
  check(page.url().endsWith('/grownups'), 'the right PIN returns to the grown-ups area');
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Open').click();
  await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });

  // ---- the mastery went through the normal events ----
  await btn('Sync now').click();
  await page
    .getByText(/Synced\./)
    .first()
    .waitFor({ timeout: 10000 });
  check(
    (await page.getByText('0 update(s) waiting to send').count()) === 1,
    "the helper session's events (ordinary lesson events) have all synced",
  );

  // ---- worksheets ----
  await btn('Worksheets').nth(CHILD.tobi).click();
  await btn('Worksheet (for the child)').waitFor({ timeout: 10000 });
  check(
    await page.getByText('Unit 2: Exploring Our Environment (Part 2)').last().isVisible(),
    'worksheets list the downloaded lesson that has a workbook',
  );
  // (the grown-ups dashboard stays mounted underneath and lists every lesson, so count only what is on screen)
  const visibleMarketDay = await page
    .getByText(/Market Day/)
    .evaluateAll((els) => els.filter((el) => el.getClientRects().length > 0).length);
  check(visibleMarketDay === 0, 'a lesson that is not downloaded is not listed');
  check(
    (await page.getByText('More practice 1 · 3 questions').count()) === 1,
    'reviewed practice pools are offered as More practice',
  );
  await shot('worksheets-list');

  const sheets = [];
  const grab = async (label, open, name) => {
    await open();
    await page.getByTestId('worksheet-preview').waitFor({ timeout: 10000 });
    await page.waitForFunction(() =>
      document.querySelector('[data-testid=worksheet-preview]')?.getAttribute('srcdoc'),
    );
    const html = await page.getByTestId('worksheet-preview').getAttribute('srcdoc');
    await shot(name);
    sheets.push({ label, html, name });
    return html;
  };

  await grab('worksheet', () => btn('Worksheet (for the child)').click(), 'worksheet-preview');
  check(await btn('Print').isEnabled(), 'Print is on once the sheet is built');
  check(
    (await btn('Share as PDF').count()) === 0,
    'a browser has no separate Share button (Print offers Save as PDF)',
  );
  await btn('Print').click();
  await page.getByText('The print window is open.').waitFor({ timeout: 5000 });
  check(
    true,
    'Print opens the print window for the sheet in a frame (headless Chromium ignores the dialog)',
  );
  // the Name line can be left empty
  await page.getByRole('switch').click();
  await page.waitForFunction(
    () =>
      !document
        .querySelector('[data-testid=worksheet-preview]')
        ?.getAttribute('srcdoc')
        ?.includes('>Tobi<'),
  );
  check(true, 'turning the name switch off removes the nickname from the Name line');
  await page.getByRole('switch').click();
  await page.waitForFunction(() =>
    document
      .querySelector('[data-testid=worksheet-preview]')
      ?.getAttribute('srcdoc')
      ?.includes('>Tobi<'),
  );
  await btn('← All worksheets').click();

  await grab('answers', () => btn('Answers (for the grown-up)').click(), 'answers-preview');
  check(
    (await page.getByRole('switch').count()) === 0,
    'the answers sheet has no Name-line switch',
  );
  await btn('← All worksheets').click();
  await grab('practice', () => btn('More practice 1: worksheet').click(), 'practice-preview');
  await btn('← All worksheets').click();
  await grab(
    'practice answers',
    () => btn('More practice 1: answers').click(),
    'practice-answers-preview',
  );

  // ---- export each sheet to PDF with Playwright and read it ----
  if (!havePoppler)
    note(
      'poppler (pdfinfo, pdftotext, pdftoppm) is not installed: PDF page counts and images were skipped',
    );
  const byName = Object.fromEntries(sheets.map((s) => [s.label, s]));
  const pdfs = {};
  for (const sheet of sheets) {
    const slug = sheet.label.replace(/\s+/g, '-');
    pdfs[sheet.label] = await exportPdf(context, sheet.html, `pdf-${slug}`);
    console.log(
      `PDF ${sheet.label}: ${pdfs[sheet.label].pages} page(s), ${pdfs[sheet.label].size}`,
    );
  }
  const w = pdfs.worksheet;
  check(/A4/.test(w.size) || /595/.test(w.size), `the worksheet prints on A4 (${w.size.trim()})`);
  check(w.pages >= 2 && w.pages <= 4, `the worksheet is ${w.pages} A4 pages`);
  for (const needle of [
    'CUSTAR',
    'Basic Science',
    'Primary 1',
    'Unit 2: Exploring Our Environment (Part 2)',
    'Name: Tobi',
    'Date:',
    'Objective (NERDC):',
    'Tier 1',
    'Tier 2',
    'Tier 3',
    'Quick-Answer Drill (60 seconds)',
    'Take It Home',
  ]) {
    check(w.text.includes(needle), `worksheet PDF contains "${needle}"`);
  }
  check(
    !/Kitchen\s*[–-]\s*Cook|Answer note/.test(w.text),
    'the worksheet PDF does not contain the answers',
  );
  const a = pdfs.answers;
  check(a.pages >= 1 && a.pages <= 3, `the answers sheet is ${a.pages} A4 page(s)`);
  check(
    /answers \(for the grown-up\)/i.test(a.text),
    'answers PDF is headed "Answers (for the grown-up)"',
  );
  for (const needle of [
    'Answer note:',
    'If a child has not got it yet:',
    'Take another short',
    'kitchen',
    'teacher, friend, classmate',
  ]) {
    check(a.text.includes(needle), `answers PDF contains "${needle}"`);
  }
  check(!/Name:/.test(a.text), 'the answers PDF has no Name line');
  const p = pdfs.practice;
  check(p.pages >= 1 && p.pages <= 2, `the practice worksheet is ${p.pages} page(s)`);
  check(
    p.text.includes('More practice 1') && p.text.includes('Name: Tobi'),
    'the practice PDF has its label and the Name line',
  );
  check(
    pdfs['practice answers'].text.includes('More practice 1: answers'),
    'the practice answers PDF is labelled',
  );
  writeFileSync(join(OUT, 'worksheet.html'), byName.worksheet.html);
  writeFileSync(join(OUT, 'answers.html'), byName.answers.html);

  // ---- back to the child: mastered ----
  await back();
  await page.waitForTimeout(300);
  await back();
  await page.getByText('Who is learning today?').waitFor({ timeout: 15000 });
  await btn('Start as Tobi').click();
  await page.getByText('My lessons').waitFor();
  await page.waitForTimeout(600);
  check(
    (await page.getByText(/Mastered/).count()) > 0,
    "the unit shows Mastered on the child's own lesson list",
  );
  await shot('child-home-mastered');

  reportLogs('run 1', logs);
  await context.close();
}

function reportLogs(label, logs) {
  const errors = logs.filter((l) => l.startsWith('PAGEERROR') || l.startsWith('error'));
  check(
    errors.length === 0,
    `${label}: no page errors or console errors${errors.length ? ` (${errors.slice(0, 3).join(' | ')})` : ''}`,
  );
  const warnings = logs.filter((l) => l.startsWith('warning'));
  if (warnings.length)
    note(`${label}: ${warnings.length} console warning(s), first: ${warnings[0]}`);
}

// =============================================================================================================
// RUN 2: Tobi with a fake speech engine: read-aloud availability, narration rules, speed
// =============================================================================================================
async function run2() {
  console.log('\n=== RUN 2: Tobi, a page with a (fake) speech engine ===');
  const { context, page, logs, shot, btn } = await openPage({ fakeSpeech: true });
  await signIn({ page, btn });
  await openGrownups({ page, btn });
  await btn('Helper mode').nth(CHILD.tobi).click();
  await page.getByText('Tobi cannot read yet, so helper mode is made for you both.').waitFor();
  await btn('Download to this phone').nth(1).click();
  await btn('Start helper session').waitFor({ timeout: 20000 });

  // ---- launcher with a voice ----
  const toggle = page.getByRole('switch', { name: 'Read each part aloud when it opens' });
  await toggle.waitFor({ timeout: 5000 });
  check(
    (await toggle.getAttribute('aria-checked')) === 'true',
    'narration is on by default for a child who cannot read yet',
  );
  check(
    (await page
      .getByRole('radio', { name: 'Reading speed: Slow' })
      .getAttribute('aria-checked')) === 'true',
    'a pre-reader starts on the Slow reading speed',
  );
  check(
    (await page.evaluate(() => window.__spoken.length)) === 0,
    'nothing is spoken on the launcher',
  );
  await shot('launcher-with-voice');

  // ---- nothing is spoken until the helper starts the lesson ----
  await btn('Start helper session').click();
  await page.getByText('Before you start').waitFor({ timeout: 20000 });
  await page.waitForTimeout(1200);
  check(
    (await page.evaluate(() => window.__spoken.length)) === 0,
    'nothing is spoken on the get-ready page: narration waits for "Start the lesson"',
  );
  const narrate = page.getByRole('switch', { name: 'Read each part aloud when it opens' });
  check(
    (await narrate.getAttribute('aria-checked')) === 'true',
    'the get-ready page shows narration on',
  );
  await shot('get-ready-with-voice');

  await page.evaluate(() => {
    window.__speakMs = 700;
  });
  await btn('Start the lesson').click();
  await page.getByText('Section 1 of 14').waitFor({ timeout: 10000 });
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 8000 });
  const first = await page.evaluate(() => window.__spoken[0]);
  check(
    first.text.startsWith('Come and Explore! (Our Story).'),
    `narration starts with the section heading ("${first.text.slice(0, 40)}...")`,
  );
  check(first.rate === 0.7, `a pre-reader is read to slowly (rate ${first.rate})`);
  check(
    first.lang === 'en-NG' && first.voice === 'fake-ng',
    `English for Nigeria is asked for and its voice is picked (${first.lang}, ${first.voice})`,
  );
  check(!first.text.includes('**'), 'bold markers are not spoken');
  check(
    (await page.getByRole('tab', { name: "Tobi's page" }).getAttribute('aria-selected')) === 'true',
    "with narration on, the child's page is shown first so they can watch the pictures",
  );
  const stopButton = page.getByRole('button', { name: 'Stop reading aloud' });
  check((await stopButton.count()) === 1, 'while narrating, the Listen button is a Stop button');
  await shot('narrating-section-1');
  await stopButton.click();
  await page.waitForFunction(() => window.__speakingNow === null);
  check(
    (await page.evaluate(() => window.__cancelledSpeech)) >= 1,
    'Stop cancels the speech that is playing',
  );
  check(
    (await page.getByRole('button', { name: 'Read this aloud' }).count()) === 1,
    'after Stop the button offers to read again',
  );
  await shot('stopped');

  // read once per section
  await page.evaluate(() => {
    window.__speakMs = 150;
  });
  const afterStop = await settleSpeech(page);
  await btn('Next').click();
  const strip = await page.locator('[aria-label^="Section 2 of 14."]').textContent();
  const heading2 = (strip ?? '').split('·')[1]?.trim() ?? '';
  const countAfterNext = await settleSpeech(page);
  const second = await page.evaluate((i) => window.__spoken[i], afterStop);
  check(countAfterNext > afterStop, 'opening the next section narrates it');
  check(
    second?.text.startsWith(heading2.replace(/\*\*/g, '')),
    `the second section is narrated from its own heading ("${heading2}")`,
  );
  await btn('Previous').click();
  const countAfterBack = await settleSpeech(page);
  check(
    countAfterBack === countAfterNext,
    'going back to a narrated section does not narrate it again (once per section)',
  );
  await btn('Read this aloud').click(); // Listen, by hand
  const countAfterListen = await settleSpeech(page);
  check(countAfterListen > countAfterBack, 'Listen reads the section again when the helper asks');

  // ---- per-question speaker on the mastery check, never reads answers ----
  await goToSection(page, btn, 14);
  await settleSpeech(page);
  await page.evaluate(() => {
    window.__speakMs = 100;
  });
  const before = await page.evaluate(() => window.__spoken.length);
  await page.getByRole('button', { name: 'Read this aloud' }).nth(0).click();
  await settleSpeech(page);
  const questionSpoken = await page.evaluate(
    (i) =>
      window.__spoken
        .slice(i)
        .map((s) => s.text)
        .join(' '),
    before,
  );
  check(
    /classroom/.test(questionSpoken) && /At school/.test(questionSpoken),
    'the question speaker reads the question with its words and categories',
  );
  check(!/Think about where you find each place/.test(questionSpoken), 'the hint is not read out');
  await shot('mastery-with-speakers');

  // ---- speed choice ----
  await btn('Finish helper session').click();
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Finish and go to Grown-ups').click();
  await page.getByText('Grown-ups only').waitFor({ timeout: 10000 });
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Open').click();
  await page.getByText('Downloaded lessons').waitFor();
  await btn('Helper mode').nth(CHILD.tobi).click();
  await page.getByRole('radio', { name: 'Reading speed: Normal' }).click();
  check(
    (await page
      .getByRole('radio', { name: 'Reading speed: Normal' })
      .getAttribute('aria-checked')) === 'true',
    'the grown-up can choose Normal speed',
  );
  await btn('Start helper session').click();
  await page.getByText('Before you start').waitFor();
  await page.evaluate(() => {
    window.__spoken.length = 0;
  });
  await btn('Start the lesson').click();
  await page.waitForFunction(() => window.__spoken.length >= 1, null, { timeout: 8000 });
  const normal = await page.evaluate(() => window.__spoken[0]);
  check(normal.rate === 1, `the chosen speed is used (rate ${normal.rate})`);
  check(
    (await page.evaluate(() => window.__spoken.length)) >= 1 &&
      normal.text.startsWith('Come and Explore!'),
    'the new session narrates from its first section',
  );
  await shot('normal-speed');

  reportLogs('run 2', logs);
  await context.close();
}

// =============================================================================================================
// RUN 3: Ada (reads and writes), desktop width, the PIN asked again after the elevation lapses
// =============================================================================================================
async function run3() {
  console.log('\n=== RUN 3: Ada (reads and writes), desktop width, lapsed elevation ===');
  const { context, page, logs, shot, btn } = await openPage({
    width: 1100,
    height: 820,
    fakeSpeech: true,
    clock: true,
  });
  await signIn({ page, btn });
  await openGrownups({ page, btn });

  // The grown-up elevation lasts ten minutes. Move the page clock on eleven.
  await page.clock.fastForward('11:00');
  await btn('Helper mode').nth(CHILD.ada).click();
  await page.getByText('Enter your PIN to start a helper session.').waitFor({ timeout: 10000 });
  check(true, 'when the grown-up elevation has lapsed, the helper launcher asks for the PIN again');
  await shot('lapsed-pin-prompt');
  await page.getByLabel('Grown-up PIN').fill('1111');
  await btn('Open').click();
  await page.getByText('That PIN is not right.').waitFor();
  await page.getByLabel('Grown-up PIN').fill('2468');
  await btn('Open').click();
  await page.getByRole('heading', { name: 'Helper mode' }).first().waitFor({ timeout: 10000 });
  await page.getByText('Ada reads and writes.').waitFor();
  check(true, 'the right PIN opens the launcher for a child who reads');
  check(
    (await page.getByRole('switch').count()) === 0,
    'no narration switch for a child who reads',
  );
  check(
    (await page
      .getByRole('radio', { name: 'Reading speed: Normal' })
      .getAttribute('aria-checked')) === 'true',
    'a child who reads starts on the Normal reading speed',
  );
  await btn('Download to this phone').nth(1).click();
  await btn('Start helper session').waitFor({ timeout: 20000 });
  await shot('launcher-ada');

  await btn('Start helper session').click();
  await page.getByText('Before you start').waitFor();
  await btn('Start the lesson').click();
  await page.getByText('Section 1 of 14').waitFor();
  await page.waitForTimeout(1200);
  check(
    (await page.evaluate(() => window.__spoken.length)) === 0,
    'no narration for a child who reads',
  );
  check(
    (await page.getByRole('tab').count()) === 0,
    'on a wide screen the script and the page show side by side, with no tabs',
  );
  check(
    await page.getByText('Read the story aloud, one paragraph at a time.').isVisible(),
    'the helper script is beside the page',
  );
  check(
    await page.getByText('Zari and Zuri now know that their environment').isVisible(),
    "the child's page is beside the script",
  );
  check(
    (await page.getByRole('button', { name: 'Read this aloud' }).count()) === 1,
    'the speaker is offered (a voice exists) but nothing plays by itself',
  );
  await shot('wide-section-1');
  await goToSection(page, btn, 14);
  check(
    (await page.getByText('●', { exact: true }).count()) === 0,
    'a child who reads gets the normal answer buttons, not the big picture ones',
  );
  await shot('wide-mastery');

  reportLogs('run 3', logs);
  await context.close();
}

// =============================================================================================================
// RUN 4: Back button cannot leave the helper session
// =============================================================================================================
async function run4() {
  console.log('\n=== RUN 4: browser Back inside a helper session ===');
  const { context, page, logs, btn } = await openPage();
  await signIn({ page, btn });
  await openGrownups({ page, btn });
  await btn('Helper mode').nth(CHILD.tobi).click();
  await btn('Download to this phone').nth(1).click();
  await btn('Start helper session').waitFor({ timeout: 20000 });
  await btn('Start helper session').click();
  await page.getByText('Before you start').waitFor();
  await page.goBack();
  await page.waitForTimeout(1200);
  const body = await page.locator('body').innerText();
  check(
    !body.includes('Downloaded lessons'),
    'browser Back does not reveal an unlocked grown-ups area',
  );
  check(
    !body.includes('Remove from this phone'),
    'browser Back does not reveal grown-ups settings',
  );
  reportLogs('run 4', logs);
  await context.close();
}

try {
  await run1();
  await run2();
  await run3();
  await run4();
} catch (error) {
  console.error('\nE2E ABORTED:', error);
  failures.push(`aborted: ${error?.message ?? error}`);
} finally {
  await browser.close();
}

console.log('\n--- screenshots ---');
console.log(
  readdirSync(OUT).filter((f) => f.endsWith('.png') && /^\d\d-/.test(f)).length,
  'step screenshots in',
  OUT,
);
console.log(
  `\n${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED`}`,
);
for (const message of failures) console.log(`  - ${message}`);
console.log(
  '\nNot verified here: real text-to-speech voices, native printing/sharing (expo-print, expo-sharing), the Android back button, real touch.',
);
process.exit(failures.length === 0 ? 0 : 1);
