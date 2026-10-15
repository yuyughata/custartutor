// End-to-end check of "Edit by hand" and the unit layout planner, in DEMO mode, in a real browser:
// open a drafted unit in the editor, type, bold, add things, see the checks, try an answer with the real marker,
// undo, save as a new human version, read the history and diff, restore an autosave, read-only for a reviewer,
// then in the chapter planner add a fifth unit, be refused a sixth, remove a unit without versions and apply
// the layout. A screenshot is saved at every step.
//
//   cd apps/admin && npx expo export --platform web
//   node scripts/serve-dist.mjs dist 8126 &
//   node scripts/e2e-editor.mjs --out ./e2e-editor-out --base http://127.0.0.1:8126
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
  '/tmp/claude-0/-home-user-custartutor/4a06e87e-bdca-5b89-835a-94cfa887cc85/scratchpad/admin-editor-e2e',
);
const BASE = option('base', 'http://127.0.0.1:8126');
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--no-sandbox'],
});
const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await context.newPage();
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
const lbl = (name) =>
  typeof name === 'string' ? page.getByLabel(name, { exact: true }) : page.getByLabel(name);
const text = (value, exact = false) => page.getByText(value, { exact });
const heading = (name) => page.getByRole('heading', { name, exact: false }).first();
const tid = (id) => page.getByTestId(id);
// Scrolls a locator to just under the sticky toolbar, then waits for the page to settle.
const bringIntoView = async (locator) => {
  await locator.evaluate((el) => {
    el.style.scrollMarginTop = '190px';
    el.scrollIntoView({ block: 'start' });
  });
  await page.waitForTimeout(250);
};
const setRole = async (role) => {
  await lbl('Demo role').selectOption(role);
  await page.waitForTimeout(300);
};

const auditNames = async (where) => {
  const problems = await page.evaluate(() => {
    const doc = globalThis.document;
    const out = [];
    const nameOf = (el) =>
      (el.getAttribute('aria-label') || '').trim() ||
      (el.getAttribute('aria-labelledby') ? 'labelled' : '') ||
      (el.id && doc.querySelector(`label[for="${el.id}"]`) ? 'label' : '') ||
      (el.textContent || '').trim() ||
      (el.getAttribute('title') || '').trim() ||
      (el.getAttribute('alt') || '').trim();
    for (const el of doc.querySelectorAll('input, textarea, select')) {
      if (el.type === 'hidden') continue;
      if (!nameOf(el)) out.push(`unnamed ${el.tagName.toLowerCase()}`);
    }
    for (const el of doc.querySelectorAll(
      'button, [role="button"], a[href], [role="link"], [role="tab"]',
    )) {
      if (!nameOf(el)) out.push(`unnamed ${el.getAttribute('role') || el.tagName.toLowerCase()}`);
    }
    return out;
  });
  check(
    `accessible names on ${where}${problems.length ? ` (${[...new Set(problems)].join('; ')})` : ''}`,
    problems.length === 0,
  );
};

const noHorizontalScroll = async (where) => {
  const wide = await page.evaluate(() => {
    const el = globalThis.document.scrollingElement;
    return el ? el.scrollWidth - el.clientWidth : 0;
  });
  check(`no horizontal page scroll on ${where} (${wide}px over)`, wide <= 1);
};

// ---- sign in ---------------------------------------------------------------------------------------------
await page.goto(`${BASE}/`);
await text('Content engine').waitFor();
await lbl('Email address').fill('barry@example.com');
await btn('Send me a code').click();
await text('Check your email').waitFor();
await lbl('6-digit email code').fill('123456');
await btn('Check code').click();
await heading('Authenticator code required').waitFor();
await lbl('Authenticator code').fill('654321');
await btn('Verify').click();
await heading('Home').waitFor();

// ---- open the golden unit (unit 2 has version 1, approved) in the workspace and publish it ------------------
await page.getByTestId('nav-schemes').click();
await heading('Schemes of work').waitFor();
await page.getByRole('link', { name: 'Basic Science' }).first().click();
await text('Plan chapters').first().waitFor();
await text('Plan chapters').first().click();
await heading('Chapter planner').waitFor();
await tid('chapters-section').scrollIntoViewIfNeeded();
await shot('planner-existing');
await tid('existing-chapters')
  .getByRole('link', { name: /^Unit 2:/ })
  .first()
  .click();
await btn('Edit by hand').waitFor();
await btn('Publish to learners').scrollIntoViewIfNeeded();
await btn('Publish to learners').click();
await btn('Publish version 1').click();
await tid('pack-demo').waitFor();
await shot('workspace-v1-published');
await tid('edit-by-hand').scrollIntoViewIfNeeded();
await shot('workspace-with-edit-by-hand');

// ---- the editor ---------------------------------------------------------------------------------------------
await btn('Edit by hand').click();
await tid('unit-editor').waitFor();
await shot('editor-overview');
check(
  'the DEMO banner stays in the editor',
  (await tid('demo-banner').innerText()).includes('DEMO'),
);
check('nothing is unsaved yet', (await tid('save-state').innerText()).includes('No changes yet'));
check('the save button is disabled with a reason', await btn('Save as new version').isDisabled());
await auditNames('the editor (overview)');

// a plain field
await lbl('Title').fill('Exploring Our Environment (Part 2, revised by hand)');
await page.waitForTimeout(500);
check(
  'unsaved changes are shown',
  (await tid('save-state').innerText()).includes('Unsaved changes'),
);
check(
  'the preview follows the edit',
  await page
    .getByTestId('editor-preview')
    .getByText(/revised by hand/)
    .first()
    .isVisible(),
);

// the tour of the tabs
await tid('tab-sections').click();
await tid('panel-sections').waitFor();
await bringIntoView(tid('tab-sections'));
await shot('editor-sections');

// bold: button, shortcut, live preview, counts
const first = tid('block-0-0');
const para = first.getByLabel('Text', { exact: true });
await para.click();
await page.keyboard.press('Control+A');
await page.keyboard.press('Control+b');
await page.waitForTimeout(250);
check(
  'Ctrl+B wraps the selection in bold markers',
  (await para.inputValue()).startsWith('**') && (await para.inputValue()).endsWith('**'),
);
check(
  'the live preview shows it bold',
  (await first.getByTestId('rich-preview').locator('strong').count()) === 1,
);
await bringIntoView(first);
await shot('editor-bold');
await page.keyboard.press('Control+z');
await page.waitForTimeout(250);
check('Ctrl+Z undoes the bold', !(await para.inputValue()).includes('**'));

// a published section cannot be deleted, and says why
const removeFirst = btn(/^Remove section 1 /);
check('a published section cannot be removed', await removeFirst.isDisabled());
await removeFirst.scrollIntoViewIfNeeded();
check('and the reason names the version', await text('published in version 1').first().isVisible());
await shot('editor-published-section-protected');

// errors block saving; the summary jumps to the field
const heading0 = tid('section-0').getByLabel('Heading', { exact: true });
await heading0.scrollIntoViewIfNeeded();
await heading0.fill('');
await page.waitForTimeout(600);
check('the error count shows', (await tid('issue-counts').innerText()).includes('1 error'));
check('Save is disabled while there is an error', await btn('Save as new version').isDisabled());
await bringIntoView(tid('issue-summary'));
await shot('editor-error-in-checks');
await page
  .getByRole('button', { name: /^Error in Section 1.*Go to the field/ })
  .first()
  .click();
await page.waitForTimeout(900);
check(
  'pressing the problem moves the cursor to its field',
  (await page.evaluate(() => globalThis.document.activeElement?.getAttribute('data-field'))) ===
    'sections[0].heading',
);
await shot('editor-jumped-to-field');
await page.keyboard.type('Come and Explore! (Our Story)');
await page.waitForTimeout(600);
check(
  'typing the heading back clears the error',
  (await tid('issue-counts').innerText()).includes('0 errors'),
);

// add a block by hand: it starts blank, which the checks refuse, until it is written
await lbl('Add to this section').first().selectOption('block:callout');
await page.waitForTimeout(500);
check('a new blank block is an error', (await tid('issue-counts').innerText()).includes('error'));
const callout = tid('section-0').getByTestId('block-0-4');
await callout
  .getByLabel('Text', { exact: true })
  .fill('Always **ask a grown-up** before you cross the road.');
await page.waitForTimeout(600);
check('writing it clears the error', (await tid('issue-counts').innerText()).includes('0 errors'));
await bringIntoView(callout);
await shot('editor-added-callout');

// reading-level meter on a section that is over the limit
await page.getByRole('button', { name: /^Expand 10\./ }).click();
await bringIntoView(tid('section-9'));
await shot('editor-reading-meter');
check(
  'the reading-level meter says so in words',
  await text('Reading level: 17.0 words per sentence: over the limit of 12').first().isVisible(),
);

// questions: Try it with the real marker
await tid('tab-questions').click();
await page.getByRole('button', { name: 'Expand wb_fill_cook' }).click();
const card = tid('question-wb_fill_cook');
await bringIntoView(card);
await shot('editor-question-fill-blank');
await card.getByLabel('Try blank 1', { exact: true }).fill('kitchen');
await page.waitForTimeout(300);
check(
  'Try it: a right answer is CORRECT',
  (await tid('tryit-result-wb_fill_cook').innerText()).includes('CORRECT'),
);
await card.getByLabel('Try blank 1', { exact: true }).fill('bedroom');
await page.waitForTimeout(300);
check(
  'Try it: a wrong answer is INCORRECT',
  (await tid('tryit-result-wb_fill_cook').innerText()).includes('INCORRECT'),
);
await bringIntoView(tid('tryit-wb_fill_cook'));
await shot('editor-try-it-wrong');
await page.getByRole('button', { name: 'Expand qf_gutter' }).click();
await bringIntoView(tid('question-qf_gutter'));
await shot('editor-question-mcq');

// session plan and workbook
await tid('tab-plan').click();
await bringIntoView(tid('tab-plan'));
await lbl('Teach, minutes').first().fill('40');
await page.waitForTimeout(400);
check(
  'the minutes meter warns outside 50 to 70',
  (await tid('minutes-meter').first().innerText()).includes('over 70'),
);
await shot('editor-plan-over');
await lbl('Teach, minutes').first().fill('15');
await tid('tab-workbook').click();
await bringIntoView(tid('tab-workbook'));
await shot('editor-workbook');
await tid('tab-manual').click();
await page
  .getByRole('button', { name: /^Expand 1\. Come and Explore/ })
  .first()
  .click();
await bringIntoView(tid('tab-manual'));
await shot('editor-manual');

// review my changes, then save
await btn('Review my changes').click();
await tid('diff-view').waitFor();
await shot('editor-review-changes');
await btn('Review my changes').click();
await btn('Save as new version').click();
await tid('saved-banner').waitFor();
check(
  'saving opens the workspace on the new version',
  await text('Saved as version 2').first().isVisible(),
);
await shot('workspace-after-save');
check(
  'the new version is a human draft',
  await tid('version-history').getByText('Human').first().isVisible(),
);
await tid('version-history').scrollIntoViewIfNeeded();
await shot('workspace-history-v2-human');

// ---- autosave on this device, the leave guard and the restore prompt ---------------------------------------------
await btn('Edit by hand').click();
await tid('unit-editor').waitFor();
check(
  'the editor now starts from version 2',
  await text('version 2 (written by a person)').first().isVisible(),
);
await lbl('Title').fill('Exploring Our Environment (a second hand edit)');
await page.waitForTimeout(1300);
check(
  'the autosave is reported',
  (await tid('save-state').innerText()).includes('kept on this device'),
);
await page.getByRole('link', { name: 'Unit 2' }).first().click();
await text('Leave without saving?').waitFor();
await shot('editor-leave-guard');
await btn('Leave without saving').click();
await btn('Edit by hand').waitFor();
await btn('Edit by hand').click();
await tid('restore-prompt').waitFor();
await shot('editor-restore-prompt');
await btn('Restore my work').click();
await page.waitForTimeout(400);
check(
  'the restored work is back',
  (await lbl('Title').inputValue()).includes('a second hand edit'),
);
check('and it is unsaved', (await tid('save-state').innerText()).includes('Unsaved changes'));
await shot('editor-restored');

// ---- roles: a reviewer reads, support has no access ------------------------------------------------------------
await setRole('reviewer');
await tid('readonly-banner').waitFor();
check('a reviewer sees the editor read only', await tid('readonly-banner').isVisible());
check('and has no save button', (await btn('Save as new version').count()) === 0);
check(
  'and the fields cannot be typed in',
  await lbl('Title').evaluate((el) => el.readOnly === true),
);
await shot('editor-reviewer-read-only');
await setRole('support');
await tid('no-access').waitFor();
check(
  'support has no access to the editor',
  await text('Your role cannot open this page').isVisible(),
);
await setRole('super_admin');
await tid('unit-editor').waitFor();

// ---- widths: 820 and 390 ---------------------------------------------------------------------------------------
for (const [w, h] of [
  [820, 1100],
  [390, 844],
]) {
  await page.setViewportSize({ width: w, height: h });
  await page.waitForTimeout(500);
  await tid('pane-edit').waitFor();
  await noHorizontalScroll(`the editor at ${w}px`);
  await tid('pane-edit').click();
  await tid('tab-sections').click();
  await bringIntoView(tid('tab-sections'));
  await shot(`editor-${w}-sections`);
  await tid('pane-preview').click();
  await page.waitForTimeout(500);
  await shot(`editor-${w}-preview`);
  await noHorizontalScroll(`the editor preview at ${w}px`);
  await tid('pane-edit').click();
  await tid('tab-questions').click();
  await bringIntoView(tid('tab-questions'));
  await shot(`editor-${w}-questions`);
}
await page.setViewportSize({ width: 1280, height: 900 });

// ---- the conflict screen (a save refused with stale_base), drawn from fixed data in the dev preview -----------------
// Two live sessions cannot be driven in the demo (its data lives in one page), so the screen is shown from fixtures;
// the merge itself is covered by unit tests and the refusal by the demo backend test.
await page.getByTestId('nav-dev').click();
await page.getByRole('link', { name: /UI states/ }).click();
await tid('conflict-panel').waitFor();
await bringIntoView(tid('conflict-banner'));
await shot('conflict-screen');
check(
  'the conflict screen says nothing was saved',
  await text('Your changes were not saved').first().isVisible(),
);
check(
  'there is no "save as a separate copy"',
  (await page.getByText(/separate copy/i).count()) === 0 || !(await btn(/save.*copy/i).count()),
);
check(
  'combining is disabled until the clash is chosen',
  await btn(/^Combine my changes/).isDisabled(),
);
await page
  .getByRole('radio', { name: /^Keep mine: Section/ })
  .first()
  .click();
check('after choosing, combining is enabled', !(await btn(/^Combine my changes/).isDisabled()));
await btn(/^Combine my changes/).click();
await tid('conflict-result').waitFor();
check(
  'the combined result keeps both sets of edits',
  (await tid('conflict-result').innerText()).includes('my wording') &&
    (await tid('conflict-result').innerText()).includes('their wording'),
);
await shot('conflict-combined');

// ---- the chapter planner: add a fifth unit, refuse a sixth, remove a unit without drafts, apply ------------------
await page.getByTestId('nav-schemes').click();
await heading('Schemes of work').waitFor();
await page.getByRole('link', { name: 'Basic Science' }).first().click();
await text('Plan chapters').first().click();
await heading('Chapter planner').waitFor();
// a unit with no draft opens the editor on an empty skeleton: the structure is there, every text is blank
await tid('existing-chapters')
  .getByRole('link', { name: /^Unit 3:/ })
  .first()
  .click();
await btn('Edit by hand').click();
await tid('unit-editor').waitFor();
await tid('editor-notice').waitFor();
check(
  'the skeleton is announced',
  (await tid('editor-notice').innerText()).includes('no version yet'),
);
check(
  'it starts from the unit row title',
  (await lbl('Title').inputValue()).startsWith('Exploring Other Parts'),
);
check(
  'blank texts are errors, so it cannot be saved yet',
  await btn('Save as new version').isDisabled(),
);
check('and says so', (await tid('issue-counts').innerText()).includes('error'));
await shot('editor-starter-skeleton');
await page.getByRole('link', { name: 'Chapters', exact: true }).first().click();
await heading('Chapter planner').waitFor();
await btn('Edit layout').click();
await tid('layout-editor').waitFor();
await bringIntoView(tid('layout-editor'));
await shot('layout-editor');
check(
  'chapter 1 shows 4 of 3 to 5 units',
  await tid('layout-chapter-1').getByText('4 of 3 to 5 units').isVisible(),
);
check('a unit with a draft cannot be removed', await btn('Remove unit 2').isDisabled());
await btn('Remove unit 2').scrollIntoViewIfNeeded();
check('and it says why', await text('has 2 versions').first().isVisible());
await btn('Show the details of unit 2').click();
check(
  'a unit with drafts shows its fields read-only',
  await tid('unit-fields-summary').isVisible(),
);
await btn('Show the details of unit 1').click();
await lbl('Unit 1: title').fill('Exploring Our Environment (Part 1, renamed in the planner)');
await shot('layout-unit-with-draft-protected');
await btn('Add a unit to chapter 1').click();
await tid('add-unit-form-1').waitFor();
check('the add form refuses an empty unit', await btn('Add this unit').isDisabled());
await lbl('New unit in chapter 1: title').fill('Our local market');
await lbl('New unit in chapter 1: objective').fill(
  'Name the things sold in our local market and say who sells them.',
);
await shot('layout-add-unit-form');
await btn('Add this unit').click();
await page.waitForTimeout(300);
check(
  'chapter 1 now has the full five',
  await tid('layout-chapter-1').getByText('5 of 3 to 5 units').isVisible(),
);
check('a sixth is refused in the buttons', await btn('Add a unit to chapter 1').isDisabled());
check('with the reason', await text('A chapter holds at most 5 units.').first().isVisible());
check(
  'the units after it show their new numbers',
  await tid('layout-chapter-2')
    .getByText(/Unit 6 \(was 5\)/)
    .first()
    .isVisible(),
);
await bringIntoView(tid('layout-chapter-1'));
await shot('layout-five-units-sixth-refused');
await btn('Apply layout').scrollIntoViewIfNeeded();
await btn('Apply layout').click();
await tid('layout-applied').waitFor();
check(
  'the layout was applied (one added, one edited)',
  (await tid('layout-applied').innerText()).includes('1 added') &&
    (await tid('layout-applied').innerText()).includes('1 edited'),
);
await bringIntoView(tid('layout-applied'));
await shot('layout-applied');

// remove the unit that has no draft (the one just added is now a real unit)
await btn('Remove unit 5').click();
check('it is listed as to be archived', await tid('layout-removed').isVisible());
await shot('layout-remove-unit');
await btn('Apply layout').click();
await tid('layout-applied').waitFor();
check(
  'removing it archived one unit',
  (await tid('layout-applied').innerText()).includes('1 archived'),
);

// removing unit 1 renumbers unit 2, which has a draft: it asks first
await btn('Remove unit 1').click();
await btn('Apply layout').click();
await text('Some units that already have drafts will change number').waitFor();
await shot('layout-renumber-confirm');
check(
  'the dialog names the unit that changes',
  await text('unit 2 becomes unit 1').first().isVisible(),
);
await btn('Apply and renumber').click();
await tid('layout-applied').waitFor();
await shot('layout-renumbered');
await btn('Close the layout editor').click();
await tid('existing-chapters').waitFor();
await bringIntoView(tid('existing-chapters'));
await shot('planner-after-layout');
check(
  'the chapter list shows the new numbering',
  await tid('existing-chapters')
    .getByRole('link', { name: /^Unit 1: Exploring/ })
    .isVisible(),
);
await auditNames('the planner');

console.log(logs.length ? `console problems:\n${logs.join('\n')}` : 'no console problems');
await browser.close();
