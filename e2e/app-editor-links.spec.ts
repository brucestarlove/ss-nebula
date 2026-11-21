import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addressPath, closeIntro, currentProjectId, expect, openApp, openFromTree, saved, seedLocalStorage, storedText, test, uploadFiles } from './app-fixtures';

// The note editor's links and embeds (lane EDITOR, part 2), on the built
// site: [[ completion, wikilinks drawn and opened, embeds drawn as the page
// draws them, and the switch to plain Markdown. What reaches the file is
// read from OPFS.

const PLAN = 'Guides/Observing plan.md';
const CHUNKS = join(import.meta.dirname, '..', 'dist', 'site-chunks.json');

/** Whether a JavaScript file the page received carries a heavy part, by the modules the build put in it. */
function carries(file: string, part: RegExp): boolean {
  const { chunks } = JSON.parse(readFileSync(CHUNKS, 'utf8')) as { chunks: Record<string, { modules: Record<string, number> }> };
  return Object.entries(chunks[file]?.modules ?? {}).some(([id, length]) => length > 0 && !/\.css($|\?)/.test(id) && part.test(id));
}

function watchScripts(page: Page) {
  const files: string[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (url.pathname.endsWith('.js')) files.push(url.pathname.slice(1));
  });
  return { excalidraw: () => files.filter((file) => carries(file, /(^|\/)node_modules\/@excalidraw\//)) };
}

async function openPlan(page: Page) {
  await openApp(page);
  await closeIntro(page);
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
}

async function edit(page: Page) {
  // Read or edit is remembered (2.0.4): a note opened after another was edited opens editing, and
  // pressing Edit then would take it back to reading.
  const button = page.locator('.ws-stage').getByRole('button', { name: 'Edit' });
  if ((await button.getAttribute('aria-pressed')) !== 'true') await button.click();
  const content = page.locator('[data-testid="note-editor"] .cm-content');
  await expect(content).toBeVisible({ timeout: 20_000 });
  return content;
}

/** The editor's line that holds `text`. */
function line(page: Page, text: string | RegExp) {
  return page.locator('[data-testid="note-editor"] .cm-line', { hasText: text });
}

/** Puts the cursor at the end of the line holding `text`. */
async function endOf(page: Page, text: string | RegExp) {
  const target = line(page, text).first();
  await target.scrollIntoViewIfNeeded();
  const box = (await target.boundingBox())!;
  await page.mouse.click(box.x + box.width - 2, box.y + box.height / 2);
  await page.keyboard.press('End');
}

const list = (page: Page) => page.locator('.cm-tooltip-autocomplete');
const options = (page: Page) => list(page).getByRole('option');

/** The plan's text in OPFS once it has saved. */
async function planText(page: Page) {
  await saved(page);
  return storedText(page, currentProjectId(page), PLAN);
}

test('[[ offers the project’s files; accepting writes the shortest unique name, with the cursor after the link', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('See [[');
  await expect(list(page)).toBeVisible();
  // Notes first, the plan's own folder first; the plan itself isn't offered.
  await expect(options(page).first()).toContainText('Moon phases');
  await expect(options(page).filter({ hasText: 'Observing plan' })).toHaveCount(0);
  await expect(options(page).filter({ hasText: 'Winter hexagon.png' })).toContainText('Photos');
  await page.keyboard.type('Ori');
  await expect(options(page).first()).toContainText('Orion');
  await page.keyboard.press('Enter');
  await expect(list(page)).toBeHidden();
  await page.keyboard.type(' tonight');
  await expect.poll(() => planText(page)).toContain('See [[Orion]] tonight');

  // Escape closes the list and writes nothing.
  await page.keyboard.type(' and [[');
  await expect(list(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(list(page)).toBeHidden();
  await expect.poll(() => planText(page)).toContain('See [[Orion]] tonight and [[]]');
});

test('two files with one name: accepting the one in a folder writes its folder', async ({ page }) => {
  await openPlan(page);
  await uploadFiles(page, [{ name: 'Orion.md', mimeType: 'text/markdown', buffer: Buffer.from('# Orion, again\n') }]);
  await page.getByRole('tab', { name: /Observing plan/ }).click();
  await edit(page);
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Orion');
  const guides = options(page).filter({ hasText: 'Guides' }).filter({ hasText: 'Orion' });
  await expect(guides).toHaveCount(1);
  await guides.click();
  await page.keyboard.type('!');
  await expect.poll(() => planText(page)).toContain('[[Guides/Orion]]!');
});

test('# offers the note’s headings', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('[[Orion#');
  await expect(options(page).first()).toContainText('Orion');
  await expect(options(page).filter({ hasText: 'The Orion Nebula' })).toHaveCount(1);
  await page.keyboard.type('Sta');
  await expect(options(page)).toHaveText(['Stars']);
  await page.keyboard.press('Enter');
  await page.keyboard.type('.');
  await expect.poll(() => planText(page)).toContain('[[Orion#Stars]].');
});

test('a link is drawn as a link and Ctrl/⌘-click opens its file; a plain click places the cursor', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  const orion = line(page, 'Orion Nebula (M42)').locator('.ws-wikilink');
  await expect(orion).toHaveText('Orion');
  await expect(orion).toHaveAttribute('title', /^Guides\/Orion\.md \((⌘|Ctrl)-click to open\)$/);
  await expect(orion).toHaveCSS('text-decoration-line', 'underline');
  // A plain click shows the link's Markdown, and the cursor is in it.
  await orion.click();
  await expect(line(page, 'Orion Nebula (M42)')).toContainText('[[Orion]]');
  expect(addressPath(page)?.path).toBe(PLAN);
  await page.keyboard.press('ArrowDown');
  await expect(line(page, 'Orion Nebula (M42)').locator('.ws-wikilink')).toHaveText('Orion');
  await line(page, 'Orion Nebula (M42)').locator('.ws-wikilink').click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => addressPath(page)?.path).toBe('Guides/Orion.md');
});

test('a link to nothing is muted and dashed; Ctrl/⌘-click makes the note beside this one', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Next: [[Meteor showers');
  await page.keyboard.press('Escape');
  await page.keyboard.type(']]');
  await page.keyboard.press('ArrowUp');
  const missing = page.locator('.ws-cm-live .ws-wikilink-missing', { hasText: 'Meteor showers' });
  await expect(missing).toBeVisible();
  await expect(missing).toHaveCSS('text-decoration-style', 'dashed');
  await expect(missing).toHaveAttribute('title', /^No note called Meteor showers\. (⌘|Ctrl)-click to make it\.$/);
  await missing.click({ modifiers: ['ControlOrMeta'] });
  await expect.poll(() => addressPath(page)?.path).toBe('Guides/Meteor showers.md');
});

test('Ctrl/⌘-Enter opens the link at the cursor', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await endOf(page, 'Red flashlight');
  await page.keyboard.press('Home');
  for (let step = 0; step < 'Red flashlight, the [[Sta'.length; step += 1) await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(() => addressPath(page)?.path).toBe('Charts/Star chart — October.pdf');
});

test('an embed on its own line is drawn as the page draws it, and shows its source with the cursor on its line', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  const canvas = page.locator('.ws-cm-live .ws-cm-embed .ws-embed-canvas');
  await expect(canvas).toHaveCount(1);
  await expect(canvas.locator('img')).toBeVisible({ timeout: 30_000 });
  await expect(line(page, '![[Winter hexagon.excalidraw]]')).toHaveCount(0);

  // A picture, written here.
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Enter');
  await page.keyboard.type('![[Winter hexagon.png|300');
  await page.keyboard.press('Escape');
  await page.keyboard.press('End');
  await expect(line(page, '![[Winter hexagon.png|300]]')).toBeVisible();
  await page.keyboard.press('ArrowUp');
  const picture = page.locator('.ws-cm-live .ws-cm-embed img[alt="Winter hexagon.png"]');
  await expect(picture).toBeVisible();
  await expect(picture).toHaveCSS('width', '300px');
  await expect(line(page, '![[Winter hexagon.png|300]]')).toHaveCount(0);

  // ArrowDown steps onto the embed's line (its source shows), and on past it.
  await page.keyboard.press('ArrowDown');
  await expect(line(page, '![[Winter hexagon.png|300]]')).toBeVisible();
  await expect(picture).toHaveCount(0);
  await page.keyboard.press('ArrowDown');
  await expect(picture).toBeVisible();
  // Backspace on the next line shows the source rather than joining lines.
  await page.keyboard.press('Home');
  const before = await planText(page);
  await page.keyboard.press('Backspace');
  await expect(line(page, '![[Winter hexagon.png|300]]')).toBeVisible();
  await page.keyboard.type('!');
  await expect.poll(() => planText(page)).toBe(before!.replace('![[Winter hexagon.png|300]]', '![[Winter hexagon.png|300]]!'));

  // A click on a drawn embed opens its file.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await canvas.click();
  await expect.poll(() => addressPath(page)?.path).toBe('Sketches/Winter hexagon.excalidraw.md');
});

test('in the editor too, Excalidraw loads only when a drawing is near the screen', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 360 });
  const scripts = watchScripts(page);
  await openPlan(page);
  await page.waitForLoadState('networkidle');
  expect(scripts.excalidraw(), 'Excalidraw while the drawing is off screen, reading').toEqual([]);
  await edit(page);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(500);
  expect(scripts.excalidraw(), 'Excalidraw while the drawing is off screen, editing').toEqual([]);
  const canvas = page.locator('.ws-cm-live .ws-cm-embed .ws-embed-canvas');
  await canvas.scrollIntoViewIfNeeded();
  await expect(canvas.locator('img')).toBeVisible({ timeout: 30_000 });
  expect(scripts.excalidraw().length, 'Excalidraw once the drawing is on screen').toBeGreaterThan(0);
});

/** ⌘⇧E where the page believes it runs on an Apple platform (Playwright's WebKit says Mac OS X even on Linux), Ctrl+Shift+E elsewhere: asked as the page asks (isApplePlatform in views/shared/hooks.ts). */
async function sourceKey(page: Page): Promise<string> {
  const apple = await page.evaluate(() => {
    const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform ?? '';
    return /mac|iphone|ipad|ipod/i.test(platform) || /Mac OS X|iPhone|iPad/.test(navigator.userAgent);
  });
  return apple ? 'Meta+Shift+E' : 'Control+Shift+E';
}

const sourceSwitch = (page: Page) => page.locator('.ws-stage').getByRole('button', { name: 'Markdown source' });

test('the source switch turns every decoration off and on again, keeping undo and the cursor, and is kept after a reload', async ({ page }) => {
  await openPlan(page);
  await expect(sourceSwitch(page), 'no switch while reading').toHaveCount(0);
  await edit(page);
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'false');
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.type(' Typed.');

  await page.keyboard.press(await sourceKey(page));
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'true');
  const editor = page.locator('[data-testid="note-editor"]');
  await expect(editor).toHaveClass(/ws-cm-source/);
  await expect(page.locator('[data-testid="note-editor"] .ws-wikilink, [data-testid="note-editor"] .ws-cm-embed, [data-testid="note-editor"] .ws-cm-task-box')).toHaveCount(0);
  await expect(line(page, '- [x] Orion Nebula (M42), low in the east after 11 pm. Notes in [[Orion]].')).toBeVisible();
  await expect(line(page, '![[Winter hexagon.excalidraw]]')).toBeVisible();
  await expect(line(page, /^## Targets$/)).toBeVisible();
  // The cursor stayed where it was, and the focus in the editor.
  await page.keyboard.type('X');
  await expect(line(page, 'until 3 am. Typed.X')).toBeVisible();
  // And so did the undo history: back past the switch, to the plan as it was.
  await page.keyboard.press('ControlOrMeta+z');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(line(page, /until 3 am\.$/)).toBeVisible();

  await sourceSwitch(page).click();
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.ws-cm-live .ws-cm-embed .ws-embed-canvas')).toHaveCount(1);
  await expect(page.locator('.ws-cm-live .ws-wikilink').first()).toBeVisible();

  await sourceSwitch(page).click();
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await edit(page);
  await expect(page.locator('[data-testid="note-editor"].ws-cm-source .cm-content')).toBeVisible();
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(line(page, '![[Winter hexagon.excalidraw]]')).toBeVisible();
});

test('switching keeps the cursor’s line where it was on the screen', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await expect(page.locator('.ws-cm-live .ws-cm-embed .ws-embed-canvas img')).toBeVisible({ timeout: 30_000 });
  await endOf(page, 'Red flashlight');
  const top = async () => (await line(page, 'Red flashlight').boundingBox())!.y;
  const before = await top();
  await page.keyboard.press(await sourceKey(page));
  await expect(page.locator('[data-testid="note-editor"]')).toHaveClass(/ws-cm-source/);
  // The drawing above it became one line of Markdown; the line stays put, within a line or two (WebKit settles a few pixels lower).
  await expect.poll(top).toBeGreaterThan(before - 48);
  expect(await top()).toBeLessThan(before + 48);
  await page.keyboard.press(await sourceKey(page));
  await expect(page.locator('[data-testid="note-editor"]')).toHaveClass(/ws-cm-live/);
  await expect.poll(top).toBeGreaterThan(before - 48);
  expect(await top()).toBeLessThan(before + 48);
});

test('a 200,001-character note keeps its source, and the switch says why', async ({ page }) => {
  await openPlan(page);
  const projectId = currentProjectId(page);
  await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
  await page.getByRole('textbox', { name: 'Rename Untitled.md' }).fill('Long log');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Long log');
  const content = await edit(page);
  await content.click();
  const long = `${'Seeing steady. [[Orion]] '.repeat(8_001)}`.slice(0, 200_001);
  await page.evaluate((text) => {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    document.querySelector('.ws-cm-live .cm-content')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }, long);
  await expect.poll(async () => (await storedText(page, projectId, 'Long log.md'))?.length, { timeout: 15_000 }).toBe(200_001);
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('[data-testid="code-editor"] .cm-content')).toBeVisible({ timeout: 20_000 });
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(sourceSwitch(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(sourceSwitch(page)).toHaveAttribute('title', 'This note is long, so it’s edited as its source, which stays quick.');
  // aria-disabled, so Playwright counts it as disabled; a person can still click it.
  await sourceSwitch(page).click({ force: true });
  await expect(sourceSwitch(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.ws-cm-live')).toHaveCount(0);
  // Nothing is offered on a note this long.
  await page.locator('[data-testid="code-editor"] .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type(' [[');
  await page.waitForTimeout(400);
  await expect(list(page)).toHaveCount(0);
});

test('Help lists the source switch’s keys', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await page.getByRole('button', { name: 'Help' }).first().click();
  await expect(page.locator('.nebula-about-key', { hasText: 'Live preview or the Markdown source, while editing' })).toContainText(/(Ctrl|⌘)\s*Shift\s*E/);
});

const TYPE_NOTE = [
  '# Type',
  '',
  'A first paragraph, with a few words to read.',
  '',
  '## Seeing',
  '',
  'A second paragraph.',
  '',
  '### Next time',
  '',
  '> Seeing is the steadiness of the air.',
  '',
  '```',
  'const dark = true;',
  '```',
  '',
  '| Object | Mag |',
  '|---|---|',
  '| M42 | 4.0 |',
  '',
  'The end.',
].join('\n');

async function openTypeNote(page: Page) {
  await openApp(page);
  await closeIntro(page);
  await uploadFiles(page, [{ name: 'Type.md', mimeType: 'text/markdown', buffer: Buffer.from(TYPE_NOTE) }]);
  await openFromTree(page, 'Type.md');
  await expect(page.locator('.ws-prose')).toContainText('A first paragraph');
}

test('the page and the editor read their type from the same values', async ({ page }) => {
  await openTypeNote(page);
  await page.evaluate(() => {
    const root = document.documentElement.style;
    root.setProperty('--ws-h2-size', '41px');
    root.setProperty('--ws-h3-size', '31px');
    root.setProperty('--ws-quote-size', '23px');
    root.setProperty('--ws-code-size', '11px');
  });
  const size = (selector: string) => page.locator(selector).first().evaluate((element) => getComputedStyle(element).fontSize);
  expect([await size('.ws-prose h2'), await size('.ws-prose h3'), await size('.ws-prose blockquote'), await size('.ws-prose pre')]).toEqual(['41px', '31px', '23px', '11px']);
  await edit(page);
  await page.keyboard.press('ControlOrMeta+End');
  expect([await size('.cm-line.ws-cm-h2'), await size('.cm-line.ws-cm-h3'), await size('.cm-line.ws-cm-quote'), await size('.cm-line.ws-cm-code:not(.ws-cm-fence)')]).toEqual(['41px', '31px', '23px', '11px']);
});

test('an edited note is about as long as the read one: blank lines are the page’s gaps, code panels as padded as the page’s', async ({ page }) => {
  await openTypeNote(page);
  const read = await page.locator('.ws-prose').evaluate((element) => element.getBoundingClientRect().height);
  await edit(page);
  // The cursor at the start of the title, so nothing below it shows its Markdown.
  await page.keyboard.press('ControlOrMeta+Home');
  const edited = await page.locator('[data-testid="note-editor"] .cm-content').evaluate((element) => {
    const style = getComputedStyle(element);
    return element.getBoundingClientRect().height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
  });
  // The editor also shows the title the page leaves out (the file's name is the page's heading).
  const title = await line(page, /^# Type$/).evaluate((element) => element.getBoundingClientRect().height);
  console.log(`read ${read}px, edited ${edited}px, title ${title}px`);
  expect(edited - title).toBeLessThan(read * 1.12);
  const blank = await page.locator('.cm-line.ws-cm-blank').first().evaluate((element) => element.getBoundingClientRect().height);
  expect(blank).toBeLessThan(20);
  // The code panel: its top and bottom padding alike when its fences are hidden.
  const panel = await page.locator('.cm-line.ws-cm-code').evaluateAll((lines) => lines.map((element) => element.getBoundingClientRect().height));
  expect(panel).toHaveLength(3);
  expect(Math.abs(panel[0] - panel[2])).toBeLessThan(2);
  // A table away from the cursor is drawn as a table (2.0.2): a click on a cell shows its source.
  await page.locator('[data-testid="note-editor"] .ws-cm-table-block').getByText('M42').click();
  const tableHead = await page.locator('.cm-line.ws-cm-table-head .ws-cm-pipe').first().evaluate((element) => getComputedStyle(element).fontWeight);
  expect(tableHead).toBe('400');
});

// Part 1's keys, with real key presses (they were unit-tested through the keymaps).
test('Tab and Shift-Tab move a list item; Ctrl/⌘-B and -I wrap the words selected', async ({ page }) => {
  await openPlan(page);
  await edit(page);
  await endOf(page, 'The Pleiades (M45)');
  await page.keyboard.press('Tab');
  await expect.poll(() => planText(page)).toContain('\n  - [ ] The Pleiades (M45).');
  await page.keyboard.press('Shift+Tab');
  await expect.poll(() => planText(page)).toContain('\n- [ ] The Pleiades (M45).');
  await endOf(page, 'Saturday, after moonset.');
  await page.keyboard.press('Enter');
  await page.keyboard.type('Clear skies');
  await page.keyboard.press('Shift+Home');
  await page.keyboard.press('ControlOrMeta+b');
  await page.keyboard.press('ControlOrMeta+i');
  await expect.poll(() => planText(page)).toContain('\n***Clear skies***\n');
});

test('Ctrl/⌘-K in the editor opens the app’s search', async ({ page }) => {
  await openPlan(page);
  const content = await edit(page);
  await content.click();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.locator('.ws-palette')).toBeVisible();
});

const shots = process.env.NEBULA_EDITOR_SHOTS;

for (const width of [1280, 390]) {
  for (const theme of ['day', 'night'] as const) {
    test.describe(`screenshots, ${width} ${theme}`, () => {
      test.use({ appContext: { viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390 } });

      test(`links and embeds read and edited, and the [[ list, ${width} ${theme}`, async ({ page, context, browserName }) => {
        test.skip(!shots || browserName !== 'chromium', 'Screenshots: set NEBULA_EDITOR_SHOTS to a folder; Chromium only.');
        mkdirSync(shots!, { recursive: true });
        await seedLocalStorage(context, { 'nebula:theme': theme === 'night' ? 'dark' : 'light' });
        await openPlan(page);
        await page.evaluate(() => document.fonts.ready);
        const canvas = page.locator('.ws-prose .ws-embed-canvas img');
        await canvas.scrollIntoViewIfNeeded();
        await expect(canvas).toBeVisible({ timeout: 30_000 });
        await page.evaluate(() => document.getElementById('ws-stage')?.scrollTo(0, 0));
        await page.screenshot({ path: join(shots!, `read-${width}-${theme}.png`), animations: 'disabled', caret: 'hide' });
        await edit(page);
        await page.keyboard.press('ControlOrMeta+Home');
        await expect(page.locator('.ws-cm-live .ws-cm-embed .ws-embed-canvas img')).toBeVisible({ timeout: 30_000 });
        await page.evaluate(() => document.getElementById('ws-stage')?.scrollTo(0, 0));
        await page.waitForTimeout(300);
        await page.screenshot({ path: join(shots!, `edit-${width}-${theme}.png`), animations: 'disabled', caret: 'hide' });
        await page.locator('.ws-cm-live .ws-cm-embed').first().scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(shots!, `edit-embed-${width}-${theme}.png`), animations: 'disabled', caret: 'hide' });

        await endOf(page, 'Saturday, after moonset.');
        await page.keyboard.press('Enter');
        await page.keyboard.press('Enter');
        await page.keyboard.type('Then [[');
        await expect(list(page)).toBeVisible();
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(shots!, `list-${width}-${theme}.png`), animations: 'disabled' });
        await page.keyboard.press('Escape');
        await page.keyboard.press(await sourceKey(page));
        await page.evaluate(() => document.getElementById('ws-stage')?.scrollTo(0, 0));
        await page.waitForTimeout(200);
        await page.screenshot({ path: join(shots!, `source-${width}-${theme}.png`), animations: 'disabled', caret: 'hide' });
      });
    });
  }
}
