// End-to-end check of the tutor in a real browser, in demo mode. It walks: a grown-up turns the tutor on (draft
// banner, required checkbox), a child asks the demo tutor about the lesson (streamed reply), something off topic,
// a phone number, a crisis sentence (the fixed safe reply), the grown-up reads the transcript (the crisis turn is
// withheld, the number is redacted), the child goes "offline" and runs Tutor Lite, leaves and comes back (resumes),
// and a pre-reader sees the big quick replies. Every step is saved as a screenshot, at 390 px wide.
//
// Usage (after `cd apps/learner && npm run build:web`):
//   node scripts/serve-dist.mjs dist 8126 &
//   node scripts/e2e-tutor.mjs <screenshot-dir> http://127.0.0.1:8126
//
// This is DEMO mode: the tutor here is the labelled stand-in, never the real one. It proves the screens and the
// flow, not the server, the model or a real network.
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
// Playwright is not a repo dependency: point PLAYWRIGHT_PATH at a node_modules that has it.
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const OUT = process.argv[2];
const BASE = process.argv[3];
if (!OUT || !BASE) {
  console.error('usage: node scripts/e2e-tutor.mjs <screenshot-dir> <base-url>');
  process.exit(2);
}
mkdirSync(OUT, { recursive: true });
// Start from clean screenshots so an old run never mixes with this one.
for (const file of readdirSync(OUT)) if (/^\d\d-.*\.png$/.test(file)) rmSync(`${OUT}/${file}`);

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
// A controllable clock (it still runs on its own), so the test can let the grown-up elevation lapse.
await page.clock.install();
const logs = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 200));
});
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message.slice(0, 300)));

let step = 0;
const shot = async (name, options = {}) => {
  step += 1;
  await page.waitForTimeout(options.wait ?? 500);
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png` });
  console.log('shot', String(step).padStart(2, '0'), name);
};
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok });
  console.log(ok ? 'PASS' : 'FAIL', name, ok ? '' : detail);
};
const btn = (name, exact = true) => page.getByRole('button', { name, exact });
const visible = async (locator, timeout = 8000) =>
  locator
    .first()
    .waitFor({ state: 'visible', timeout })
    .then(
      () => true,
      () => false,
    );
const back = () => page.locator('[role=button][aria-label="Go back"]:visible').last().click();

async function typeAndSend(text, label = 'Type your question') {
  await page.getByLabel(label).fill(text);
  await btn('Send').click();
}

// ---- sign in and set up --------------------------------------------------------------------------
await page.goto(BASE + '/');
await page.getByText('Welcome to CUSTAR Tutor').waitFor({ timeout: 20000 });
await page.getByLabel("Grown-up's email").fill('parent@example.com');
await btn('Send me a code').click();
await page.getByLabel('6-digit code').fill('123456');
await btn('Sign in').click();
await page.getByText('Enter your grown-up PIN').waitFor({ timeout: 20000 });
await page.getByLabel('Your PIN').fill('2468');
await btn('Continue').click();
await page.getByText('Who is learning today?').waitFor({ timeout: 20000 });

// ---- 1. a grown-up turns the tutor on for Ada and for Tobi -----------------------------------------
await btn('Grown-ups').click();
await page.getByText('Grown-ups only').waitFor();
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
await shot('grownups-dashboard');

async function turnOnTutorFor(alias, index) {
  await btn('AI tutor').nth(index).click();
  await page.getByText(`AI tutor for ${alias}`).first().waitFor({ timeout: 10000 });
  await page.getByText(`The AI tutor is OFF for ${alias}`).waitFor({ timeout: 10000 });
  return alias;
}

await turnOnTutorFor('Ada', 0);
check('draft banner is shown', await visible(page.getByText('DRAFT WORDING: not final')));
check('bracketed placeholders are shown', await visible(page.getByText('[the United States]')));
check(
  'child alias is used in the consent text',
  await visible(page.getByText('Turn on the AI tutor for Ada?')),
);
await shot('consent-top');
const box = page.getByRole('checkbox');
check('checkbox is NOT pre-ticked', (await box.getAttribute('aria-checked')) === 'false');
const turnOn = btn('Turn on the AI tutor');
check(
  'Turn on is disabled until the box is ticked',
  (await turnOn.getAttribute('aria-disabled')) === 'true',
);
await turnOn.scrollIntoViewIfNeeded();
await shot('consent-unticked');
await box.click();
check(
  'ticking the box enables Turn on',
  (await turnOn.getAttribute('aria-disabled')) !== 'true' &&
    (await box.getAttribute('aria-checked')) === 'true',
);
await shot('consent-ticked');
await turnOn.click();
check('the tutor is on for Ada', await visible(page.getByText('The AI tutor is ON for Ada.')));
await page.getByText('The AI tutor is ON for Ada.').scrollIntoViewIfNeeded();
await shot('consent-on');
check('conversations section is there', await visible(page.getByText('No conversations yet.')));
await back();
await page.getByText('Downloaded lessons').waitFor();
await turnOnTutorFor('Tobi', 1);
await box.click();
await turnOn.click();
check('the tutor is on for Tobi', await visible(page.getByText('The AI tutor is ON for Tobi.')));
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });

// ---- 2. Ada opens a lesson and asks the demo tutor ------------------------------------------------
await btn('Start as Ada').click();
await page.getByText('My lessons').waitFor();
await btn('Download to this phone').nth(1).click();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .waitFor({ timeout: 20000 });
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
check('"Ask my tutor" is on the lesson screen', await visible(btn('Ask my tutor')));
await shot('lesson-with-tutor-button');

await btn('Ask my tutor').click();
await page
  .getByText('This is a computer program, not a person. It can make mistakes.')
  .waitFor({ timeout: 10000 });
check('the panel says it is a computer program', true);
check('the panel says it is a demo tutor', await visible(page.getByText(/Demo tutor: not Claude/)));
check(
  'the model name is never shown',
  (await page.getByText(/claude|opus|sonnet|haiku|anthropic/i).count()) ===
    (await page.getByText(/Demo tutor: not Claude/).count()),
);
await shot('panel-open');

await typeAndSend('Where do we learn at school?');
check('the child message appears', await visible(page.getByText('Where do we learn at school?')));
await shot('asking', { wait: 150 });
check('a streamed demo reply arrives', await visible(page.locator('text=/classroom/i'), 15000));
await page.waitForTimeout(1500);
check(
  'the reply is tagged as the demo tutor',
  (await page.getByText('Demo tutor: not Claude').count()) >= 2,
);
await shot('lesson-question-answered');

await typeAndSend('Can we talk about football instead?');
await visible(page.locator('text=/lesson/i').last(), 15000);
await page.waitForTimeout(1500);
await shot('off-topic-steered');

await typeAndSend('My number is 08031234567');
await page.waitForTimeout(2500);
await shot('phone-number-sent');

await typeAndSend('I want to hurt myself');
check(
  'the fixed safe reply appears',
  await visible(page.getByText(/I am really glad you told me/), 15000),
);
await page.waitForTimeout(1500);
check(
  'no alarming error UI after the safe reply',
  (await page.getByText(/something went wrong|error/i).count()) === 0,
);
await shot('crisis-safe-reply');
check(
  'the input is usable again after the safe reply',
  await page.getByLabel('Type your question').isEditable(),
);

await btn('Close the tutor').click();
await page.waitForTimeout(600);
await shot('panel-closed-lesson-intact');

// ---- 3. the grown-up reads the transcript -------------------------------------------------------
await back(); // lesson -> child home
await page.getByText('My lessons').waitFor();
await back(); // child home -> picker
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });
await btn('Grown-ups').click();
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
await btn('AI tutor').nth(0).click();
await page.getByText('The AI tutor is ON for Ada.').waitFor({ timeout: 10000 });
check(
  'a conversation is listed',
  await visible(page.getByRole('button', { name: 'Read this conversation' })),
);
check(
  'the list says a reviewer is looking at part of it',
  await visible(page.getByText('A CUSTAR reviewer is looking at part of this conversation.')),
);
await btn('Read this conversation').first().click();
await page.getByText('Where do we learn at school?').waitFor({ timeout: 10000 });
check(
  'the number was removed from the saved text',
  (await page.getByText('08031234567').count()) === 0,
);
check('the crisis sentence is NOT shown', (await page.getByText(/hurt myself/i).count()) === 0);
check(
  'the held turn shows a neutral placeholder and the reviewer line',
  (await page.getByText('A CUSTAR reviewer is looking at this part.').count()) >= 1,
);
check(
  'the held reply text is not shown either',
  (await page.getByText(/I am really glad you told me/).count()) === 0,
);
await page.getByText('Conversations').first().scrollIntoViewIfNeeded();
await shot('transcript-top');
await page.getByText('A CUSTAR reviewer is looking at this part.').first().scrollIntoViewIfNeeded();
await shot('transcript');
await page.setViewportSize({ width: 1024, height: 900 });
await shot('transcript-wide');
await page.setViewportSize({ width: 390, height: 844 });
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });

// ---- 4. offline: Tutor Lite, leave, come back, resume ---------------------------------------------
await btn('Start as Ada').click();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .waitFor({ timeout: 20000 });
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
await btn('Ask my tutor').click();
await page.getByText('This is a computer program, not a person. It can make mistakes.').waitFor();
await btn('Demo only: pretend the internet is off').click();
check(
  'offline: the plain Tutor Lite notice shows',
  await visible(page.getByText('This is the offline tutor: it follows the lesson script.')),
);
check(
  'offline: asks which part',
  await visible(page.getByText('Which part do you want to talk about?')),
);
await shot('lite-which-part');
await btn('Places in Our School').click();
check('Tutor Lite asks the first question', await visible(page.getByText('Where do we learn?')));
check('Hint and Skip are offered', (await visible(btn('Hint'))) && (await visible(btn('Skip'))));
await shot('lite-first-question');
await typeAndSend('banana', 'Type your answer');
await page.waitForTimeout(600);
await shot('lite-wrong-answer');
await btn('Hint').click();
await page.waitForTimeout(500);
await shot('lite-hint');
await page.getByLabel('Type your answer').fill('classroom');
await btn('Send').click();
await page.waitForTimeout(700);
await shot('lite-correct');
await btn('Close the tutor').click();
check(
  'Tutor Lite does not unlock the lesson: "I\'m finished" is still disabled',
  (await btn("I'm finished: check my progress").getAttribute('aria-disabled')) === 'true',
);
await btn('Ask my tutor').click();
await btn('Another part').click();
check(
  '"Another part" goes back to the list',
  await visible(page.getByText('Which part do you want to talk about?')),
);
await btn('Places in Our School').click();
await btn('Close the tutor').click();
await back();
await page.getByText('My lessons').waitFor();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
await btn('Ask my tutor').click();
await btn('Demo only: pretend the internet is back')
  .waitFor({ timeout: 10000 })
  .catch(() => undefined);
await page.waitForTimeout(800);
await shot('lite-after-returning-which-part');
await btn('Places in Our School').click();
check('resumes: welcome back', await visible(page.getByText('Welcome back! Let us carry on.')));
await shot('lite-resumed');
await btn('Close the tutor').click();

// ---- 5. a pre-reader (Tobi) ----------------------------------------------------------------------
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });
await btn('Start as Tobi').click();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .waitFor({ timeout: 20000 });
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
await btn('Ask my tutor').click();
await page.waitForTimeout(800);
await btn('Demo only: pretend the internet is back').click();
await page.waitForTimeout(800);
check('pre-reader: big quick replies are offered', await visible(btn('Say it again')));
await shot('pre-reader-panel');
await btn('Say it again').click();
await page.waitForTimeout(2500);
await shot('pre-reader-after-quick-reply');
await page.setViewportSize({ width: 1024, height: 900 });
await shot('panel-wide');
await page.setViewportSize({ width: 390, height: 844 });
await btn('Close the tutor').click();

// ---- 6. the grown-up turns the tutor off again; the child is asked to find a grown-up -----------------
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });
await btn('Grown-ups').click();
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
await btn('AI tutor').nth(1).click();
await page.getByText('The AI tutor is ON for Tobi.').waitFor({ timeout: 10000 });
await btn('Turn off the AI tutor').click();
check('the tutor is off again', await visible(page.getByText('The AI tutor is now off.')));
check(
  'the checkbox is not pre-ticked after turning off',
  !(await page.getByRole('checkbox').isChecked()),
);
await shot('consent-turned-off');
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });
await btn('Start as Tobi').click();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .waitFor({ timeout: 20000 });
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
await btn('Ask my tutor').click();
check(
  'without consent the child is asked to find a grown-up',
  await visible(page.getByText('Ask a grown-up to turn on the tutor')),
);
check('no PIN is asked of the child here', (await page.getByLabel('Grown-up PIN').count()) === 0);
await shot('needs-consent');

// ---- 7. the elevation lapses: the screen asks for the PIN again instead of failing -----------------------
await btn('Close the tutor').click();
await back();
await back();
await page.getByText('Who is learning today?').waitFor({ timeout: 10000 });
await btn('Grown-ups').click();
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
await btn('AI tutor').nth(1).click();
await page.getByText('The AI tutor is OFF for Tobi.').waitFor({ timeout: 10000 });
await page.getByRole('checkbox').click();
await page.clock.fastForward('11:00'); // the elevation lasts about 10 minutes
await btn('Turn on the AI tutor').click();
check('a lapsed elevation asks for the PIN again', await visible(page.getByText('Enter your PIN')));
check(
  'and says so in plain words',
  await visible(page.getByText('Please enter your grown-up PIN again.')),
);
check('the ticked box is kept', await page.getByRole('checkbox').first().isChecked());
await shot('elevation-lapsed');
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Enter your PIN').waitFor({ state: 'hidden', timeout: 10000 });
await btn('Turn on the AI tutor').click();
check(
  'after the PIN the tutor can be turned on',
  await visible(page.getByText('The AI tutor is ON for Tobi.')),
);
await shot('elevation-renewed');

console.log('--- console issues ---');
console.log(logs.slice(0, 20).join('\n'));
const failed = checks.filter((c) => !c.ok);
console.log(`${checks.length - failed.length}/${checks.length} checks passed`);
await browser.close();
process.exit(failed.length ? 1 : 0);
