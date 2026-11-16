import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { addressPath, closeIntro, currentProjectId, expect, openApp, openFromTree, pngFile, row, storedText, test, uploadFiles, videoFile } from './app-fixtures';

// The notes slice, reading side (reading lane, 2.0.1), on the built site: the
// Night Sky sample's Observing plan reads as a page with real links and a real
// drawing; links make and follow; pictures wait for the screen.

const CHUNKS = join(import.meta.dirname, '..', 'dist', 'site-chunks.json');

/** Whether a JavaScript file the page received carries a heavy part, by the modules the build put in it (as app-budget.spec.ts reads them). */
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
  return {
    excalidraw: () => files.filter((file) => carries(file, /(^|\/)node_modules\/@excalidraw\//)),
    codemirror: () => files.filter((file) => carries(file, /(^|\/)node_modules\/(@codemirror|codemirror|@lezer)\//)),
  };
}

/** Records the type and size of every blob the page makes a URL for (a canvas preview's SVG, a picture's bytes). */
async function recordBlobs(page: Page) {
  await page.addInitScript(() => {
    const made: Array<{ url: string; type: string; size: number }> = [];
    (window as unknown as { __blobs: typeof made }).__blobs = made;
    const create = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (object: Blob | MediaSource) => {
      const url = create(object);
      if (object instanceof Blob) made.push({ url, type: object.type, size: object.size });
      return url;
    };
  });
}

const blobOf = (page: Page, url: string) =>
  page.evaluate((wanted) => (window as unknown as { __blobs: Array<{ url: string; type: string; size: number }> }).__blobs.find((blob) => blob.url === wanted) ?? null, url);

/** A note added with Upload files, and opened. */
async function addNote(page: Page, name: string, text: string) {
  await uploadFiles(page, [{ name, mimeType: 'text/markdown', buffer: Buffer.from(text) }]);
  await openFromTree(page, name);
  await expect(page.locator('.ws-prose')).toBeVisible();
}

const filler = (count: number) => Array.from({ length: count }, (_, index) => `Filler paragraph ${index + 1}, so the page has somewhere to scroll to.`).join('\n\n');

const active = (page: Page) => page.getByRole('tab', { selected: true });

test('a wikilink opens its file in a tab, by click and by keyboard', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const prose = page.locator('.ws-prose');
  const orion = prose.getByRole('link', { name: 'Orion', exact: true });
  await expect(orion).toHaveAttribute('title', 'Guides/Orion.md');
  await orion.click();
  await expect(active(page)).toHaveText('Orion');
  await expect(page.locator('.ws-page h1')).toHaveText('Orion');

  // Back in the plan, the alias is what shows, and Enter follows it.
  await page.getByRole('tab', { name: 'Observing plan' }).click();
  const chart = prose.getByRole('link', { name: 'Star chart — October', exact: true });
  await expect(chart).toHaveAttribute('title', 'Charts/Star chart — October.pdf');
  await chart.focus();
  await expect(chart).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => addressPath(page)?.path).toBe('Charts/Star chart — October.pdf');
});

test('a heading link opens the note at its heading, and one in the same note scrolls there', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 600 });
  await openApp(page);
  await closeIntro(page);
  await addNote(page, 'Heading links.md', `[[Orion#Finding your way]] and [[#Down here]] and [[Orion#No such heading]]\n\n${filler(30)}\n\n## Down here\n\nThe end.\n`);
  const stage = page.locator('.ws-stage');
  const scrolled = () => stage.evaluate((element) => element.scrollTop);
  expect(await scrolled()).toBe(0);

  await page.locator('.ws-prose').getByRole('link', { name: 'Down here', exact: true }).click();
  await expect(page.locator('.ws-prose h2', { hasText: 'Down here' })).toBeInViewport();
  expect(await scrolled()).toBeGreaterThan(300);

  await page.getByRole('tab', { name: 'Heading links' }).click();
  await page.locator('.ws-prose').getByRole('link', { name: 'Orion > Finding your way' }).click();
  await expect(active(page)).toHaveText('Orion');
  const heading = page.locator('.ws-prose h2', { hasText: 'Finding your way' });
  await expect(heading).toBeInViewport();
  await expect(heading).toBeFocused();

  // A heading that isn't there just opens the note, at its top.
  await page.getByRole('tab', { name: 'Heading links' }).click();
  await page.locator('.ws-prose').getByRole('link', { name: 'Orion > No such heading' }).click();
  await expect(active(page)).toHaveText('Orion');
  await expect(page.locator('.ws-page h1')).toBeInViewport();
});

test('a link to no note makes it beside the note, and a name Nebula refuses says why', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  await addNote(page, 'Stubs.md', 'Ideas: [[A new idea]], [[Deep/Sky notes]] and [[Sketch.excalidraw]]. Refused: [[What: now?]].\n');
  const prose = page.locator('.ws-prose');
  const idea = prose.getByRole('link', { name: 'A new idea' });
  await expect(idea).toHaveClass(/ws-wikilink-missing/);
  await expect(idea).toHaveAttribute('title', 'No note called A new idea. Click to make it.');
  await idea.click();
  await expect(active(page)).toHaveText('A new idea');
  await expect.poll(() => storedText(page, projectId, 'A new idea.md')).toBe('');

  await page.getByRole('tab', { name: 'Stubs' }).click();
  await prose.getByRole('link', { name: 'Deep/Sky notes' }).click();
  await expect(active(page)).toHaveText('Sky notes');
  await expect.poll(() => storedText(page, projectId, 'Deep/Sky notes.md')).toBe('');

  await page.getByRole('tab', { name: 'Stubs' }).click();
  // The links now name notes that are there: they open them, and make nothing new.
  await expect(prose.getByRole('link', { name: 'A new idea' })).not.toHaveClass(/ws-wikilink-missing/);
  await prose.getByRole('link', { name: 'What: now?' }).click();
  await expect(page.locator('.ws-status-text')).toContainText('Windows');
  await expect(active(page)).toHaveText('Stubs');
  // A canvas that isn't there is only named: no note is made from it.
  await expect(prose.getByRole('link', { name: 'Sketch.excalidraw' })).toHaveAttribute('title', 'No file called Sketch.excalidraw.');
});

test('a canvas embed draws the drawing as an SVG image; Excalidraw is fetched only once one is on screen, and CodeMirror never', async ({ page }) => {
  // A short window: the plan's drawing, below its checklist, starts off screen.
  await page.setViewportSize({ width: 1440, height: 360 });
  await recordBlobs(page);
  const scripts = watchScripts(page);
  await openApp(page);
  await closeIntro(page);
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await page.waitForLoadState('networkidle');
  const slot = page.locator('.ws-prose .ws-embed-canvas');
  await expect(slot).toHaveCount(1);
  await expect(slot).not.toBeInViewport();
  await expect(slot.locator('img')).toHaveCount(0);
  expect(scripts.excalidraw(), 'Excalidraw before the drawing is near the screen').toEqual([]);
  expect(scripts.codemirror(), 'CodeMirror while reading').toEqual([]);

  await slot.scrollIntoViewIfNeeded();
  const image = slot.locator('img');
  await expect(image).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(100);
  const src = (await image.getAttribute('src')) ?? '';
  expect(src).toMatch(/^blob:/);
  expect(await blobOf(page, src)).toMatchObject({ type: 'image/svg+xml' });
  expect((await blobOf(page, src))!.size).toBeGreaterThan(500);
  await expect(image).toHaveAttribute('alt', 'Winter hexagon');
  expect(scripts.excalidraw().length, 'Excalidraw once the drawing is on screen').toBeGreaterThan(0);
  expect(scripts.codemirror()).toEqual([]);

  // A click opens the canvas in a tab.
  await slot.click();
  await expect.poll(() => addressPath(page)?.path).toBe('Sketches/Winter hexagon.excalidraw.md');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
});

test('a note whose embeds are all files and notes never fetches Excalidraw', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 360 });
  const scripts = watchScripts(page);
  await openApp(page);
  await closeIntro(page);
  await addNote(page, 'Plain.md', 'Just words, [[Orion]] and a [[Star chart — October.pdf]] card:\n\n![[Star chart — October.pdf]]\n\n![[Orion#Stars]]\n');
  await expect(page.locator('.ws-prose .ws-embed-card')).toContainText('Star chart — October.pdf');
  // A note below the window is read when it comes near, not before.
  await page.locator('.ws-prose .ws-embed-note').scrollIntoViewIfNeeded();
  await expect(page.locator('.ws-prose .ws-embed-note')).toContainText('Betelgeuse');
  await page.waitForLoadState('networkidle');
  expect(scripts.excalidraw()).toEqual([]);
  expect(scripts.codemirror()).toEqual([]);
});

test('a picture in the project is a lazy image with its file as the source, sized when asked', async ({ page }) => {
  await recordBlobs(page);
  await openApp(page);
  await closeIntro(page);
  await uploadFiles(page, [{ name: 'dot.png', mimeType: 'image/png', buffer: pngFile() }]);
  await addNote(page, 'Pictures.md', `![[dot.png|120]]\n\n![[dot.png|90x60]]\n\n![A tiny dot](dot.png)\n\n![](<dot.png>)\n\n${filler(30)}\n\n![[Missing.png]] and ![gone](gone.png)\n`);
  const images = page.locator('.ws-prose img');
  await expect(images).toHaveCount(4);
  for (const image of await images.all()) {
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(0);
    expect(await blobOf(page, (await image.getAttribute('src')) ?? '')).toMatchObject({ type: 'image/png' });
  }
  await expect(images.nth(0)).toHaveCSS('width', '120px');
  await expect(images.nth(1)).toHaveCSS('height', '60px');
  await expect(images.nth(2)).toHaveAttribute('alt', 'A tiny dot');
  await expect(images.nth(3)).toHaveAttribute('alt', 'dot.png');
  // A missing file shows its name, muted: no broken image.
  await expect(page.locator('.ws-embed-missing')).toHaveText(['Missing.png', 'gone']);
  expect(await images.evaluateAll((all) => all.filter((element) => !(element as HTMLImageElement).complete || (element as HTMLImageElement).naturalWidth === 0).length)).toBe(0);
});

test('an SVG in the project shown in a note is an image: its script never runs', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const evil = '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" onload="window.__svgRan = 1"><script>window.__svgRan = 2</script><rect width="40" height="40" fill="#7c8cff"/></svg>';
  await uploadFiles(page, [{ name: 'evil.svg', mimeType: 'image/svg+xml', buffer: Buffer.from(evil) }]);
  await addNote(page, 'Hostile.md', '![[evil.svg]] and ![](evil.svg)\n');
  const images = page.locator('.ws-prose img');
  await expect(images).toHaveCount(2);
  for (const image of await images.all()) await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(40);
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as { __svgRan?: number }).__svgRan)).toBeUndefined();
  expect(await page.locator('.ws-prose svg').count()).toBe(0);
});

test('the sample’s Orion note shows the Winter hexagon picture, lazily', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await page.locator('.ws-prose').getByRole('link', { name: 'Orion', exact: true }).click();
  const slot = page.locator('.ws-prose .ws-embed-image');
  await slot.scrollIntoViewIfNeeded();
  const image = slot.locator('img[alt="Winter hexagon.png"]');
  await expect(image).toHaveAttribute('loading', 'lazy');
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBeGreaterThan(500);
  await expect(image).toHaveCSS('width', '520px');
});

test('another note’s text, a section of it, and a PDF card, in place', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await addNote(page, 'Embeds.md', '![[Orion#Stars]]\n\nThen the chart:\n\n![[Star chart — October.pdf]]\n\n![[Embeds]]\n');
  const section = page.locator('.ws-embed-note').first();
  await expect(section).toContainText('Betelgeuse');
  await expect(section).not.toContainText('Sirius');
  await expect(section.locator('.ws-embed-name')).toHaveText('Orion > Stars');
  await expect(page.locator('.ws-embed-stop')).toContainText('embeds itself');
  const card = page.locator('.ws-embed-card');
  await expect(card).toContainText('Star chart — October.pdf');
  await expect(card).toContainText('KB');
  // The embedded headings aren't the page's: the outline is unchanged.
  await card.getByRole('button', { name: 'Open' }).click();
  await expect.poll(() => addressPath(page)?.path).toBe('Charts/Star chart — October.pdf');
  await page.getByRole('tab', { name: 'Embeds' }).click();
  await section.locator('.ws-embed-name').click();
  await expect.poll(() => addressPath(page)?.path).toBe('Guides/Orion.md');
  await expect(row(page, 'Guides/Orion.md')).toHaveAttribute('aria-selected', 'true');
});

test('renaming a note brings its links along, on disk, and says so; a move that changes no link writes nothing', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  const plan = 'Guides/Observing plan.md';
  const before = (await storedText(page, projectId, plan)) ?? '';
  expect(before).toContain('Notes in [[Orion]].');

  // Rename with F2, as the file tree does. The plan is open: its page follows.
  await row(page, 'Guides/Orion.md').focus();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Rename Orion.md' }).fill('Orion, the hunter');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Guides/Orion, the hunter.md')).toBeVisible();
  // The plan and the README each name it once.
  await expect(page.locator('.ws-status-text')).toHaveText('Updated 2 links in 2 notes.');
  await expect.poll(() => storedText(page, projectId, 'README.md')).toContain('a page on [[Orion, the hunter]]');
  await expect.poll(() => storedText(page, projectId, plan)).toBe(before.replace('[[Orion]]', '[[Orion, the hunter]]'));
  // Only the link changed: every other byte of the note is as it was.
  const prose = page.locator('.ws-prose');
  await expect(prose.getByRole('link', { name: 'Orion, the hunter', exact: true })).toHaveAttribute('title', 'Guides/Orion, the hunter.md');
  await prose.getByRole('link', { name: 'Orion, the hunter', exact: true }).click();
  await expect(active(page)).toHaveText('Orion, the hunter');

  // Moved into another folder, the bare name still names it alone: nothing to write.
  const after = await storedText(page, projectId, plan);
  await row(page, 'Guides/Orion, the hunter.md').locator('.page-sidebar-nav-label').dragTo(row(page, 'Sketches'));
  await expect(row(page, 'Sketches/Orion, the hunter.md')).toBeVisible();
  await page.waitForTimeout(800);
  await expect(page.locator('.ws-status-text')).not.toContainText('Updated');
  expect(await storedText(page, projectId, plan)).toBe(after);
});

test('the sample note reads well: day and night, wide and narrow', async ({ page }, testInfo) => {
  const shots = process.env.NEBULA_NOTES_SHOTS ?? '';
  test.skip(!shots, 'Screenshots are taken with NEBULA_NOTES_SHOTS=<folder>.');
  await openApp(page);
  await closeIntro(page);
  const embed = page.locator('.ws-prose .ws-embed-canvas');
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await embed.scrollIntoViewIfNeeded();
      await expect(embed.locator('img')).toBeVisible({ timeout: 30_000 });
      await page.evaluate(() => document.getElementById('ws-stage')?.scrollTo(0, 0));
      await page.screenshot({ path: join(shots, `observing-plan-${scheme === 'dark' ? 'night' : 'day'}-${width}-top.png`) });
      await embed.scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `observing-plan-${scheme === 'dark' ? 'night' : 'day'}-${width}-drawing.png`) });
    }
  }
  // What else an embed can be: another note, a card, media, and what is missing.
  await page.setViewportSize({ width: 1280, height: 800 });
  await uploadFiles(page, [{ name: 'moonrise.webm', mimeType: 'video/webm', buffer: videoFile('webm') }]);
  await addNote(page, 'Gallery.md', '# Gallery\n\nA link that goes nowhere: [[Meteor showers]], and one that does: [[Orion#Stars|the stars]].\n\n![[Orion#Stars]]\n\n![[Star chart — October.pdf]]\n\n![[moonrise.webm|420]]\n\n![[Missing picture.png]] and ![a photo](Photos/gone.jpg)\n');
  await expect(page.locator('.ws-embed-note .ws-embed-body')).toContainText('Betelgeuse', { timeout: 20_000 });
  for (const [width, height] of [
    [1280, 800],
    [390, 844],
  ]) {
    for (const scheme of ['dark', 'light'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.setViewportSize({ width, height });
      await page.evaluate(() => document.getElementById('ws-stage')?.scrollTo(0, 0));
      await page.screenshot({ path: join(shots, `gallery-${scheme === 'dark' ? 'night' : 'day'}-${width}-top.png`) });
      await page.locator('.ws-embed-missing').last().scrollIntoViewIfNeeded();
      await page.screenshot({ path: join(shots, `gallery-${scheme === 'dark' ? 'night' : 'day'}-${width}-cards.png`) });
    }
  }
  testInfo.annotations.push({ type: 'shots', description: shots });
});
