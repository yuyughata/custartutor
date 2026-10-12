// End-to-end check of the demo flow in a real browser: sign in, set up the PIN, download a lesson, play it,
// master the check, open grown-ups, sync. Usage (after `npm run build:web`):
//   node scripts/serve-dist.mjs dist 8125 &
//   node scripts/e2e-demo.mjs ./e2e-out http://127.0.0.1:8125
import { createRequire } from 'node:module';
// Playwright is not a repo dependency: point PLAYWRIGHT_PATH at a node_modules that has it.
const require = createRequire(process.env.PLAYWRIGHT_PATH ?? '/opt/node-tools/node_modules/');
const { chromium } = require('playwright');
const OUT = process.argv[2];
const BASE = process.argv[3];
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
const logs = [];
page.on('console', (m) => {
  if (['error', 'warning'].includes(m.type())) logs.push(m.type() + ': ' + m.text().slice(0, 200));
});
page.on('pageerror', (e) => logs.push('PAGEERROR: ' + e.message.slice(0, 300)));
let step = 0;
const shot = async (name) => {
  step += 1;
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${String(step).padStart(2, '0')}-${name}.png` });
  console.log('shot', name);
};
const btn = (name, exact = true) => page.getByRole('button', { name, exact });

await page.goto(BASE + '/');
await page.getByText('Welcome to CUSTAR Tutor').waitFor({ timeout: 20000 });
await shot('sign-in');
await page.getByLabel("Grown-up's email").fill('parent@example.com');
await btn('Send me a code').click();
await page.getByLabel('6-digit code').fill('123456');
await shot('verify');
await btn('Sign in').click();
await page.getByText('Enter your grown-up PIN').waitFor({ timeout: 20000 });
await page.getByLabel('Your PIN').fill('2468');
await shot('pin-adopt');
await btn('Continue').click();
await page.getByText('Who is learning today?').waitFor({ timeout: 20000 });
await shot('child-picker');
await btn('Start as Ada').click();
await page.getByText('My lessons').waitFor();
await shot('child-home-before-download');
const dl = btn('Download to this phone');
console.log('download buttons:', await dl.count());
await dl.nth(1).click();
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .waitFor({ timeout: 20000 });
await shot('child-home-after-download');
await page
  .getByRole('button', { name: /^(Start|Continue)$/ })
  .first()
  .click();
await page.getByText('Objective (NERDC):').waitFor({ timeout: 20000 });
await shot('lesson-top');
// ---- mastery check (last section): sort, match, circle ----
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
await page.getByText("I'm finished: check my progress").scrollIntoViewIfNeeded();
await shot('lesson-mastery-answered');
await btn("I'm finished: check my progress").click();
await page.getByText('Well done!').waitFor({ timeout: 10000 });
await shot('mastered');
await btn('Back to my lessons').click();
await page.getByRole('heading', { name: 'My lessons' }).first().waitFor();
await page.waitForTimeout(800);
await shot('child-home-mastered');
console.log('Mastered text visible:', await page.getByText(/Mastered/).count());
console.log(
  'Colour chart locked still:',
  await page.getByText('Finish the lesson before this one to open it.').count(),
);
// ---- grown-ups, through the UI (a reload would reset the in-memory demo) ----
await page.locator('[role=button][aria-label="Go back"]:visible').last().click();
await page
  .locator('h1:visible', { hasText: 'Who is learning today?' })
  .waitFor({ timeout: 5000 })
  .catch(() => console.log('picker heading not found'));
await btn('Grown-ups').click();
await page.getByText('Grown-ups only').waitFor();
await shot('grownups-gate');
await page.getByLabel('Grown-up PIN').fill('1111');
await btn('Open').click();
await page.getByText('That PIN is not right.').waitFor();
await shot('grownups-wrong-pin');
await page.getByLabel('Grown-up PIN').fill('2468');
await btn('Open').click();
await page.getByText('Downloaded lessons').waitFor({ timeout: 10000 });
await shot('grownups-dashboard');
await btn('Sync now').click();
await page.getByText(/Synced\./).waitFor({ timeout: 10000 });
console.log(
  'sync message:',
  await page
    .getByText(/Synced\./)
    .first()
    .textContent(),
);
console.log(
  'pending text:',
  await page
    .getByText(/waiting to send/)
    .first()
    .textContent(),
);
await shot('grownups-synced');
console.log('--- console issues ---');
console.log(logs.slice(0, 15).join('\n'));
await browser.close();
