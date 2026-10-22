import { expect, test, type Page } from '@playwright/test';
import { openFile, openHarness } from './harness/views-page';

// Lane C, PLAN §10: each view brings its own weight. Reading a note never
// downloads Excalidraw or CodeMirror; CodeMirror arrives with edit mode,
// Excalidraw with a canvas. (Dev server: dependencies are separate modules.)

const EXCALIDRAW = /\/node_modules\/\.vite\/deps\/@excalidraw_excalidraw\.js/;
const CODEMIRROR = /\/node_modules\/\.vite\/deps\/(codemirror|@codemirror_[a-z-]+)\.js/;
const MARKDOWN = /\/node_modules\/\.vite\/deps\/react-markdown\.js/;

function recordModules(page: Page): string[] {
  const seen: string[] = [];
  page.on('request', (request) => {
    if (request.resourceType() === 'script') seen.push(new URL(request.url()).pathname);
  });
  return seen;
}

test('a note loads without Excalidraw or CodeMirror; each arrives with its view', async ({ page }) => {
  const seen = recordModules(page);
  await openHarness(page, 'Archive/backup.zip');
  // The first page of a run may wait for the dev server to bundle.
  await expect(page.locator('.ws-info-card')).toBeVisible({ timeout: 30_000 });
  expect(seen.filter((path) => EXCALIDRAW.test(path) || CODEMIRROR.test(path) || MARKDOWN.test(path))).toEqual([]);

  await openFile(page, 'Guides/Observing plan.md');
  await expect(page.locator('.ws-prose')).toBeVisible();
  expect(seen.some((path) => MARKDOWN.test(path))).toBe(true);
  expect(seen.filter((path) => EXCALIDRAW.test(path) || CODEMIRROR.test(path))).toEqual([]);

  await page.getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.ws-page .cm-content')).toBeVisible({ timeout: 20_000 });
  expect(seen.some((path) => CODEMIRROR.test(path))).toBe(true);
  expect(seen.filter((path) => EXCALIDRAW.test(path))).toEqual([]);

  await openFile(page, 'Sketches/Winter hexagon.excalidraw.md');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  expect(seen.some((path) => EXCALIDRAW.test(path))).toBe(true);
});
