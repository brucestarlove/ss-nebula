import { expect, test, type Page } from '@playwright/test';
import { openFile, openHarness, peek, sceneElements, writesTo } from './harness/views-page';

// Lane C: a canvas opens in the tab's framed board, draws, saves to its file
// and reopens with the same elements.

const HEXAGON = 'Sketches/Winter hexagon.excalidraw.md';
const JSON_CANVAS = 'Sketches/Telescope setup.excalidraw';
const EMPTY = 'Sketches/Empty.excalidraw.md';

async function elementCount(page: Page): Promise<number> {
  const status = page.getByTestId('status');
  await expect(status).toHaveText(/^\d+ elements? · \d+%$/, { timeout: 30_000 });
  return parseInt((await status.textContent()) ?? '', 10);
}

/** Draws a rectangle with Excalidraw's own tool, by mouse. */
async function drawRectangle(page: Page, at: { x: number; y: number }) {
  const canvas = page.locator('.ws-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  // The tool's radio sits under its icon: click the label that holds both.
  await page.locator('.ws-canvas label:has([data-testid="toolbar-rectangle"])').click();
  await expect(page.locator('.ws-canvas').getByTestId('toolbar-rectangle')).toBeChecked();
  const x = box.x + box.width * at.x;
  const y = box.y + box.height * at.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 140, y + 90, { steps: 6 });
  await page.mouse.up();
}

test('the canvas sits in the framed board without the old chrome', async ({ page }) => {
  const errors = await openHarness(page, HEXAGON);
  await expect(page.locator('.ws-board.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.nebula-topbar, .nebula-app, .frame-footer')).toHaveCount(0);
  await expect(page.locator('.ws-canvas .nebula-library-controls')).toBeVisible();
  expect(await elementCount(page)).toBe(29);
  // Opening never writes.
  await page.waitForTimeout(1_200);
  expect(await writesTo(page, HEXAGON)).toBe(0);
  expect(errors).toEqual([]);
});

test('a drawing saves to its .excalidraw.md and reopens with the same elements', async ({ page }) => {
  await openHarness(page, HEXAGON);
  const before = await elementCount(page);
  await drawRectangle(page, { x: 0.45, y: 0.62 });
  await expect.poll(() => elementCount(page)).toBe(before + 1);
  await expect.poll(() => writesTo(page, HEXAGON), { timeout: 5_000 }).toBeGreaterThan(0);
  await expect(page.getByTestId('saved')).toHaveText('Saved in memory');

  const text = (await peek(page, HEXAGON))!;
  expect(text).toContain('excalidraw-plugin: parsed');
  expect(text).toContain('```compressed-json');
  const saved = await sceneElements(page, HEXAGON);
  expect(saved.filter((element) => !element.isDeleted)).toHaveLength(before + 1);
  expect(saved.some((element) => element.type === 'rectangle')).toBe(true);

  await openFile(page, 'Guides/Observing plan.md');
  await openFile(page, HEXAGON);
  expect(await elementCount(page)).toBe(before + 1);
  const reopened = await sceneElements(page, HEXAGON);
  expect(reopened.map((element) => element.id)).toEqual(saved.map((element) => element.id));
});

test('an .excalidraw file stays JSON, and an empty file opens as an empty canvas', async ({ page }) => {
  await openHarness(page, JSON_CANVAS);
  expect(await elementCount(page)).toBe(1);
  await drawRectangle(page, { x: 0.55, y: 0.5 });
  await expect.poll(() => writesTo(page, JSON_CANVAS), { timeout: 5_000 }).toBeGreaterThan(0);
  const json = JSON.parse((await peek(page, JSON_CANVAS))!);
  expect(json).toMatchObject({ type: 'excalidraw', version: 2 });
  expect(json.elements).toHaveLength(2);

  await openFile(page, EMPTY);
  expect(await elementCount(page)).toBe(0);
  await drawRectangle(page, { x: 0.5, y: 0.45 });
  await expect.poll(() => peek(page, EMPTY), { timeout: 5_000 }).toContain('```compressed-json');
});

test('a pending drawing is written when the tab is closed', async ({ page }) => {
  await openHarness(page, EMPTY);
  expect(await elementCount(page)).toBe(0);
  await drawRectangle(page, { x: 0.5, y: 0.4 });
  // Straight away, inside the 400 ms window: leaving flushes.
  await openFile(page, 'src/sky.ts');
  await expect.poll(() => sceneElements(page, EMPTY).then((elements) => elements.length), { timeout: 3_000 }).toBe(1);
});

test('a plain .md drawing opens as a canvas and is written back in that format', async ({ page }) => {
  const path = 'Sketches/Obsidian drawing.md';
  await openHarness(page, path);
  await expect(page.locator('.ws-stage[data-kind="canvas"]')).toBeVisible();
  expect(await elementCount(page)).toBe(1);
  await drawRectangle(page, { x: 0.6, y: 0.55 });
  await expect.poll(async () => (await sceneElements(page, path)).length, { timeout: 5_000 }).toBe(2);
  // Written back as the plugin wrote it: plain JSON, its setting (review finding 8).
  const written = (await peek(page, path)) ?? '';
  expect(written).toContain('excalidraw-plugin: parsed');
  expect(written).toContain('```json');
  expect(written).not.toContain('```compressed-json');
});
