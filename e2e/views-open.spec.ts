import { expect, test } from '@playwright/test';
import { openFile, openHarness } from './harness/views-page';

// Lane C: every kind of file opens in its view, in the harness page
// (e2e/harness/views.html: the views on an in-memory store).

const KINDS: Array<{ path: string; kind: string; ready: string }> = [
  { path: 'Guides/Observing plan.md', kind: 'note', ready: '.ws-page .ws-prose' },
  { path: 'Sketches/Winter hexagon.excalidraw.md', kind: 'canvas', ready: '.ws-board.ws-canvas .excalidraw' },
  { path: 'Photos/Nebula logo.png', kind: 'image', ready: '.ws-image-img' },
  { path: 'Charts/Star chart — October.pdf', kind: 'pdf', ready: 'iframe.ws-pdf-frame' },
  { path: 'Field recordings/Crickets at dusk.wav', kind: 'audio', ready: '.ws-media-audio audio' },
  { path: 'Photos/Moonrise timelapse.webm', kind: 'video', ready: '.ws-media video, .ws-info-card' },
  { path: 'src/sky.ts', kind: 'text', ready: '.ws-code-sheet .cm-content' },
  { path: 'Archive/backup.zip', kind: 'other', ready: '.ws-info-card' },
];

test.describe('every kind opens', () => {
  for (const { path, kind, ready } of KINDS) {
    test(`${kind}: ${path}`, async ({ page }) => {
      const errors = await openHarness(page, path);
      await expect(page.locator(`.ws-stage[data-kind="${kind}"]`)).toBeVisible();
      await expect(page.locator(ready).first()).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('status')).not.toHaveText('', { timeout: 15_000 });
      expect(errors).toEqual([]);
    });
  }
});

test('a note reads like the sketch, and never runs raw HTML', async ({ page }) => {
  await openHarness(page, 'Guides/Field guide.md');
  const pageEl = page.locator('.ws-page');
  await expect(pageEl.locator('h1').first()).toHaveText('Field guide');
  await expect(pageEl.locator('.ws-meta')).toContainText('Guides');
  await expect(pageEl.locator('.ws-meta .ws-tag')).toHaveText(['#reference']);
  await expect(pageEl.locator('table')).toBeVisible();
  await expect(pageEl).toContainText('<script>window.__htmlRan = true</script>');
  await expect(pageEl.locator('.ws-prose b, .ws-prose script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as { __htmlRan?: boolean }).__htmlRan)).toBeUndefined();
  await expect(pageEl).not.toContainText('tags:');
});

test('web links open in a new tab, and a wikilink is a link of its own (muted here: the harness has no project around it)', async ({ page }) => {
  await openHarness(page, 'Guides/Observing plan.md');
  const link = page.getByRole('link', { name: 'the Met Office' });
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.ws-prose')).toContainText('Notes in Orion.');
  await expect(page.getByRole('link', { name: 'Orion', exact: true })).toHaveClass(/ws-wikilink-missing/);
});

test('an SVG shows as an image and its script never runs', async ({ page }) => {
  const errors = await openHarness(page, 'Photos/Winter hexagon.svg');
  const img = page.locator('.ws-image-img');
  await expect(img).toBeVisible();
  await expect.poll(() => img.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0)).toBe(true);
  expect(await page.evaluate(() => (window as { __svgScriptRan?: boolean }).__svgScriptRan)).toBeUndefined();
  // Its URL is let go once drawn: it can't be opened as a page of this origin.
  const src = await img.getAttribute('src');
  expect(await page.evaluate((url) => fetch(url!).then(() => 'opened', () => 'gone'), src)).toBe('gone');
  await expect(page.getByTestId('status')).toContainText('px');
  expect(errors).toEqual([]);
});

test('an image zooms with the buttons, the wheel and the keyboard', async ({ page }) => {
  await openHarness(page, 'Photos/Nebula logo.png');
  const level = page.locator('[data-zoom-level]');
  await expect(level).toHaveText('100%');
  await expect(page.getByTestId('status')).toHaveText(/^\d[\d,]* × \d[\d,]* px · /);
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect(level).toHaveText('125%');
  const stage = page.locator('.ws-image-stage');
  const box = (await stage.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -400);
  await expect.poll(async () => parseInt((await level.textContent()) ?? '0', 10)).toBeGreaterThan(125);
  await stage.focus();
  await page.keyboard.press('0');
  await expect(level).toHaveText('100%');
});

test('the PDF reaches the browser as a PDF, with Open in new tab and Download', async ({ page }) => {
  await openHarness(page, 'Charts/Star chart — October.pdf');
  const frame = page.locator('iframe.ws-pdf-frame');
  await expect(frame).toBeVisible();
  const src = (await frame.getAttribute('src'))!;
  expect(src.startsWith('blob:')).toBe(true);
  const served = await page.evaluate(async (url) => {
    const blob = await (await fetch(url)).blob();
    return { type: blob.type, head: await blob.slice(0, 5).text() };
  }, src);
  expect(served).toEqual({ type: 'application/pdf', head: '%PDF-' });
  await expect(page.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute('href', src);
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  // WebKit swaps the spaces for underscores.
  expect((await download).suggestedFilename().replace(/_/g, ' ')).toBe('Star chart — October.pdf');
});

test('audio and video load, with their duration', async ({ page }) => {
  await openHarness(page, 'Field recordings/Crickets at dusk.wav');
  const audio = page.locator('audio');
  await expect.poll(() => audio.evaluate((node: HTMLMediaElement) => node.readyState), { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId('status')).toHaveText('0:01');

  // Chromium builds without H.264 play the WebM; WebKit may play only one
  // of them. At least one must play; one that can't shows the info card.
  let played = 0;
  for (const path of ['Photos/Moonrise timelapse.webm', 'Photos/Moonrise timelapse.mp4']) {
    await openFile(page, path);
    const outcome = await Promise.race([
      page
        .locator('video')
        .evaluate((node: HTMLMediaElement) =>
          node.readyState >= 1 ? 'played' : new Promise((resolve) => node.addEventListener('loadedmetadata', () => resolve('played'))),
        )
        .catch(() => 'card'),
      page.locator('.ws-info-card').waitFor({ timeout: 15_000 }).then(() => 'card'),
    ]);
    if (outcome === 'played') {
      played += 1;
      await expect(page.getByTestId('status')).toHaveText('0:02');
    } else {
      await expect(page.locator('.ws-info-card')).toContainText('can\u2019t play');
    }
  }
  expect(played).toBeGreaterThanOrEqual(1);
});

test('a file that cannot be read shows the info card', async ({ page }) => {
  await openHarness(page, 'Broken/unreadable.md');
  await expect(page.locator('.ws-info-card')).toBeVisible();
  await expect(page.locator('.ws-info-card')).toContainText(/couldn.t open this file/);
});
