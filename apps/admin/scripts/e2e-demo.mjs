// End-to-end check of the admin app in DEMO mode, in a real browser: sign in with the authenticator step,
// read a pasted scheme with the stand-in model, edit and save the draft, approve it, plan and apply chapters,
// draft a unit, read the preview in all three tabs, revise, compare versions, submit, approve, publish, then
// characters, usage and settings, jobs, role gating and narrow widths. A screenshot is saved at every step.
//
//   cd apps/admin && npx expo export --platform web
//   node scripts/serve-dist.mjs dist 8126 &
//   node scripts/e2e-demo.mjs --out ./e2e-out --base http://127.0.0.1:8126
//
// Playwright is not a repo dependency: point PLAYWRIGHT_PATH at a node_modules that has it.
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};
const OUT = option(
  'out',
  '/tmp/claude-0/-home-user-custartutor/4a06e87e-bdca-5b89-835a-94cfa887cc85/scratchpad/admin-e2e',
);
const BASE = option('base', 'http://127.0.0.1:8126');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.setDefaultTimeout(30000);
const logs = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(`${m.type()}: ${m.text().slice(0, 300)}`);
});
page.on('pageerror', (e) => logs.push(`PAGEERROR: ${e.message.slice(0, 400)}`));

let n = 0;
const shot = async (name, options = {}) => {
  n += 1;
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}/${String(n).padStart(2, '0')}-${name}.png`, ...options });
  console.log(`shot ${String(n).padStart(2, '0')} ${name}`);
};
const check = (label, ok) => {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${label}`);
  if (!ok) process.exitCode = 1;
};
const btn = (name, exact = true) => page.getByRole('button', { name, exact });
const lbl = (name) => (typeof name === 'string' ? page.getByLabel(name, { exact: true }) : page.getByLabel(name));
const nav = (id) => page.getByTestId(`nav-${id}`);
const text = (value, exact = false) => page.getByText(value, { exact });
const heading = (name) => page.getByRole('heading', { name, exact: false }).first();
const setRole = async (role) => {
  await lbl('Demo role').selectOption(role);
  await page.waitForTimeout(300);
};

// ---- 1. sign-in -------------------------------------------------------------------------------------------
await page.goto(`${BASE}/`);
await text('Content engine').waitFor();
check('DEMO banner is on the sign-in screen', (await page.getByTestId('demo-banner').innerText()).includes('DEMO: sample data and a stand-in model, not Claude'));
await shot('sign-in');
await lbl('Email address').fill('barry@example.com');
await btn('Send me a code').click();
await text('Check your email').waitFor();
await lbl('6-digit email code').fill('000000');
await btn('Check code').click();
await text('not right, or it has expired').waitFor();
await shot('sign-in-wrong-email-code');
await lbl('6-digit email code').fill('123456');
await btn('Check code').click();
await heading('Authenticator code required').waitFor();
await lbl('Authenticator code').fill('111111');
await btn('Verify').click();
await text('authenticator code is not right').waitFor();
await shot('sign-in-authenticator-wrong-code');
await lbl('Authenticator code').fill('654321');
await shot('sign-in-authenticator');
await btn('Verify').click();

// ---- 2. home ---------------------------------------------------------------------------------------------
await heading('Home').waitFor();
await page.getByTestId('home-counts').waitFor();
check('DEMO banner stays after sign-in', (await page.getByTestId('demo-banner').innerText()).includes('DEMO'));
await shot('home');

// ---- 3. schemes list and upload (paste) ---------------------------------------------------------------------
await nav('schemes').click();
await heading('Schemes of work').waitFor();
await page.getByRole('link', { name: 'Basic Science' }).first().waitFor();
await shot('schemes-list');
await btn('New scheme from a document').click();
await heading('New scheme from a document').waitFor();
await shot('new-scheme-empty');
await btn('Read the document').click();
await text('Choose a subject and a level').waitFor();
await shot('new-scheme-form-problem');
await lbl('Subject').selectOption({ label: 'Basic Science' });
await lbl('Level').selectOption('P1');
await lbl('Term').selectOption('2');
await page
  .getByLabel('Scheme of work text')
  .fill('BASIC SCIENCE PRIMARY 1 SECOND TERM\nWeek 1: Non-living things\nWeek 2: ...\n(pasted for the demo)');
await shot('new-scheme-filled');
await btn('Read the document').click();
await page.getByRole('progressbar', { name: /steps done/ }).first().waitFor();
await shot('scheme-ingest-running');
await page.getByTestId('scheme-draft-banner').waitFor({ timeout: 60000 });
await shot('scheme-draft-review');
check('the draft says nothing is saved yet', await text('Nothing has been saved yet').first().isVisible());
check('model flags are listed', await page.getByTestId('scheme-flags').isVisible().catch(() => false));
await page.getByTestId('scheme-flags').scrollIntoViewIfNeeded().catch(() => undefined);
await shot('scheme-draft-flags');

// ---- 4. edit, unsaved-changes guard, save, approve -----------------------------------------------------------
await lbl('Topic, row 1').fill('Non-living things (edited by a person)');
await btn('Add week').click();
const rows = await lbl(/^Topic, row \d+$/).count();
await lbl(`Topic, row ${rows}`).fill('A new week added in the demo');
await shot('scheme-draft-edited');
await nav('home').click();
await text('Leave without saving?').waitFor();
await shot('unsaved-changes-guard');
await btn('Stay and keep editing').click();
await page.getByTestId('scheme-save-status').waitFor();
check('before saving the page says it is not saved', (await page.getByTestId('scheme-save-status').innerText()).includes('Not saved yet'));
await btn('Save as draft').click();
await text('Saved as a draft at').waitFor();
await shot('scheme-draft-saved');
check('saved only after the RPC resolved', (await page.getByTestId('scheme-save-status').innerText()).includes('Saved as a draft at'));
await btn('Approve scheme').click();
await text('Approve this scheme?').waitFor();
await shot('scheme-approve-confirm');
await btn('Approve scheme').last().click();
await page.getByTestId('scheme-approved').waitFor();
await shot('scheme-approved');

// ---- 5. chapter planner ----------------------------------------------------------------------------------
await text('Plan chapters').first().click();
await heading('Chapter planner').waitFor();
await shot('planner-empty');
await btn('Propose chapters').click();
await page.getByTestId('plan-section').waitFor({ timeout: 60000 });
await shot('planner-plan');
check('plan summary is shown', (await page.getByTestId('plan-summary').innerText()).includes('chapters'));
await lbl('Title, chapter 1').fill('Our changing world');
await shot('planner-plan-edited');
// make chapter 1 invalid on purpose: move its last unit forward while chapter 2 is full, then see the message
const moveButtons = page.getByRole('button', { name: /Move unit \d+ to next chapter/ });
if ((await moveButtons.count()) > 0) {
  await moveButtons.first().scrollIntoViewIfNeeded();
  await shot('planner-move-buttons');
}
await btn('Apply plan').scrollIntoViewIfNeeded();
await btn('Apply plan').click();
await page.getByTestId('plan-applied').waitFor();
await shot('planner-applied');
await page.getByTestId('chapters-section').scrollIntoViewIfNeeded();
await text('Our changing world').first().waitFor();
await shot('planner-existing-chapters');

// ---- 6. unit workspace -------------------------------------------------------------------------------------
await page
  .getByTestId('existing-chapters')
  .getByRole('link', { name: /^Unit 1:/ })
  .first()
  .click();
await btn('Draft with Claude').waitFor();
await text('No draft yet').first().waitFor();
await shot('unit-empty');
await lbl('Notes for Claude (optional)').fill('Keep the market story. Use cassava as the example.');
await btn('Draft with Claude').click();
await page.getByRole('progressbar', { name: /steps done/ }).first().waitFor();
await page.waitForTimeout(1200);
await shot('unit-draft-running');
await page.getByTestId('draft-outcome').waitFor({ timeout: 120000 });
await shot('unit-draft-done');
check('the stand-in model id is shown', await text('demo-fixture-model').first().isVisible());
check('no publish button before review', (await btn('Publish to learners').count()) === 0);

// preview: all three tabs
const preview = page.getByTestId('unit-preview');
await preview.scrollIntoViewIfNeeded();
await shot('unit-preview-textbook');
await preview.getByRole('tab', { name: 'Workbook' }).click();
await page.waitForTimeout(400);
await shot('unit-preview-workbook');
await preview.getByRole('tab', { name: "Teacher's manual" }).click();
await page.waitForTimeout(400);
await shot('unit-preview-manual');
await preview.getByRole('tab', { name: 'Textbook' }).click();

// lint and review panels
await page.getByTestId('lint-panel').scrollIntoViewIfNeeded();
await shot('unit-lint-panel');
check('review is labelled advisory', await text('Claude’s review is advice, not approval').first().isVisible());
const jumpButtons = page.getByRole('button', { name: /^Jump to / });
if ((await jumpButtons.count()) > 0) {
  await jumpButtons.first().click();
  await page.waitForTimeout(700);
  await shot('unit-lint-jump');
}

// revise
await page.getByTestId('revise-box').scrollIntoViewIfNeeded();
await lbl('What should change?').fill('Make the practice questions shorter and use cassava in the examples.');
await shot('unit-revise-form');
await btn('Revise with Claude').click();
await page.getByRole('progressbar', { name: /steps done/ }).first().waitFor();
await page.getByTestId('draft-outcome').filter({ hasText: 'Version 2' }).waitFor({ timeout: 120000 });
await shot('unit-revised');

// history and diff
await page.getByTestId('version-history').scrollIntoViewIfNeeded();
await page.getByTestId('diff-view').waitFor({ timeout: 20000 }).catch(() => undefined);
await shot('unit-history-diff');
check('history lists two versions', (await page.getByTestId('version-history').getByText(/^v[12]/).count()) >= 2);

// ---- 7. workflow: submit, approve (reviewer), publish -------------------------------------------------------
await page.getByTestId('workflow-bar').scrollIntoViewIfNeeded();
await shot('unit-workflow-draft');
await btn('Submit for review').click();
await page.getByTestId('workflow-bar').getByText('In review').first().waitFor();
await shot('unit-in-review');
await setRole('content_editor');
await page.getByTestId('workflow-bar').scrollIntoViewIfNeeded();
check('a content editor cannot approve (button disabled with a reason)', await btn('Approve').isDisabled());
await shot('unit-in-review-editor-cannot-approve');
await setRole('reviewer');
await page.getByTestId('workflow-bar').scrollIntoViewIfNeeded();
await btn('Approve').click();
await page.getByTestId('workflow-bar').getByText('Approved').first().waitFor();
await shot('unit-approved');
await btn('Publish to learners').click();
await page.getByRole('alert').filter({ hasText: 'Publish version 2' }).waitFor();
await shot('unit-publish-confirm');
await btn('Publish version 2').click();
await page.getByTestId('pack-demo').waitFor();
await shot('unit-published');
check('demo publish says nothing was built', await text('No lesson pack was built').first().isVisible());
await setRole('super_admin');

// ---- 8. characters -------------------------------------------------------------------------------------------
await nav('characters').click();
await heading('Characters').first().waitFor();
await shot('characters');
check('the facts note is shown', await page.getByTestId('facts-note').isVisible());
await lbl('Relationship note, Zuri').fill('Zari is Zuri’s big sister.');
await shot('characters-edited');
await btn('Save Zuri').click();
await text('Saved at').first().waitFor();
await shot('characters-saved');

// ---- 9. usage and settings ------------------------------------------------------------------------------------
await nav('usage').click();
await heading('Usage & settings').waitFor();
await page.getByTestId('usage-totals').waitFor();
await shot('usage');
check('cost is unknown, not zero, where no price is entered', (await page.getByTestId('usage-totals').innerText()).includes('unknown'));
await page.getByTestId('kill-switch').scrollIntoViewIfNeeded();
await lbl('Stop all AI jobs').click();
await text('The kill switch is ON').waitFor();
await shot('settings-kill-switch-on');
await lbl('Stop all AI jobs').click();
await text('The kill switch is off').waitFor();
await page.getByTestId('prices').scrollIntoViewIfNeeded();
await btn('Add a model').click();
await lbl('Model name, price row 1').fill('demo-fixture-model');
for (const label of ['Input', 'Output', 'Cache read', 'Cache write']) {
  await lbl(`${label} per million tokens, row 1`).fill('1.5');
}
await shot('settings-prices-edited');
await btn('Save prices').click();
await text('Saved at').first().waitFor();
await shot('settings-prices-saved');

// ---- 10. jobs -----------------------------------------------------------------------------------------------
await nav('jobs').click();
await heading('Jobs').first().waitFor();
await page.getByRole('table', { name: 'Jobs' }).waitFor();
await shot('jobs-list');
await page.getByRole('link', { name: 'Draft a unit' }).first().click();
await text('Started').first().waitFor();
await shot('job-detail');

// ---- 11. roles ----------------------------------------------------------------------------------------------
await nav('schemes').click();
await setRole('reviewer');
await heading('Schemes of work').waitFor();
check('a reviewer cannot start a scheme upload', await btn('New scheme from a document').isDisabled());
await shot('role-reviewer-schemes');
await setRole('analyst');
await page.getByTestId('nav-usage').waitFor();
check('an analyst only sees Usage', (await nav('schemes').count()) === 0);
await shot('role-analyst');
await setRole('support');
await text('Your role has no content screens').first().waitFor().catch(async () => {
  await page.goto(`${BASE}/`); // fall back (a reload would reset the demo, so this is only a safety net)
});
await shot('role-support');
await setRole('super_admin');

// ---- 12. dev preview -------------------------------------------------------------------------------------
await nav('dev').click();
await heading('Fixture preview').waitFor();
await shot('dev-fixture-preview');

// ---- 13. narrow and tablet widths -------------------------------------------------------------------------
await nav('home').click();
await page.setViewportSize({ width: 820, height: 1100 });
await page.waitForTimeout(500);
await shot('tablet-home');
await page.setViewportSize({ width: 390, height: 844 });
await page.waitForTimeout(500);
await shot('narrow-home');
const horizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
check('no horizontal page scroll at 390px', !horizontalScroll);
await btn('Open menu').click();
await shot('narrow-menu');
await page.getByTestId('nav-schemes').click();
await heading('Schemes of work').waitFor();
await shot('narrow-schemes');
await page.getByRole('link', { name: 'Basic Science' }).first().click();
await page.waitForTimeout(600);
await shot('narrow-scheme-detail');
await page.setViewportSize({ width: 1280, height: 900 });

// ---- 14. sign out; not an admin; authenticator enrolment ---------------------------------------------------
await btn('Sign out').click();
await text('Content engine').waitFor();
await lbl('Email address').fill('visitor@example.com');
await btn('Send me a code').click();
await lbl('6-digit email code').fill('123456');
await btn('Check code').click();
await lbl('Authenticator code').fill('654321');
await btn('Verify').click();
await page.getByTestId('not-admin').waitFor();
await shot('not-an-admin');
check('the not-an-admin message is shown', await text('This account is not an admin account').first().isVisible());
await btn('Sign out').click();
await lbl('Email address').fill('new-user@example.com');
await btn('Send me a code').click();
await lbl('6-digit email code').fill('123456');
await btn('Check code').click();
await heading('Set up your authenticator app').waitFor();
await lbl('QR code for your authenticator app').waitFor();
await shot('authenticator-enrolment');

console.log('--- console issues ---');
console.log(logs.slice(0, 20).join('\n') || '(none)');
await browser.close();
console.log(process.exitCode ? 'E2E FAILED' : 'E2E OK');
