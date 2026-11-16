import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Page } from '@playwright/test';
import { expect, files, openSessions, PATHS, shownElements, test } from './harness/sessions-test';

// Round 7, N3: a canvas that takes another tab's change remounts and loads
// the file again; when that load fails (the file moved, or couldn't be read,
// at that moment), the canvas shows the error, never an empty canvas that
// takes edits nobody will save, and Try again opens the file.

const failReads = (page: Page, path: string, skip: number, fail: number) =>
  page.evaluate(
    ([target, through, failing]) =>
      (window as unknown as { __sessions: { failReads(path: string, skip: number, fail: number): void } }).__sessions.failReads(target, through, failing),
    [path, skip, fail] as const,
  );

test('a canvas whose remount can’t read its file shows the error, with nothing to draw on, and Try again opens it', async ({ page }) => {
  const errors = await openSessions(page, `file=${encodeURIComponent(PATHS.empty)}`);
  expect(await shownElements(page)).toBe(0);
  await expect(page.locator('.ws-canvas .excalidraw canvas.interactive')).toBeVisible({ timeout: 30_000 });
  // Another tab saves a drawing here: this tab reads it (and takes it, with
  // nothing unsaved), then remounts, and the remount's read fails.
  await failReads(page, PATHS.empty, 1, 1);
  await files.write(page, PATHS.empty, (await files.read(page, PATHS.hexagon))!);

  const alert = page.locator('.ws-canvas [data-nebula-load-error] [role="alert"]');
  await expect(alert).toBeVisible({ timeout: 10_000 });
  await expect(alert).toContainText('This canvas didn’t open');
  await expect(alert).toContainText('could not be found');
  await expect(page.locator('.ws-canvas .excalidraw')).toHaveCount(0);
  await page.screenshot({ path: join(process.env.TMPDIR || tmpdir(), 'r7', 'load-failure.png') });

  await alert.getByRole('button', { name: 'Try again' }).click();
  await expect(page.locator('.ws-canvas .excalidraw canvas.interactive')).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => shownElements(page), { timeout: 10_000 }).toBeGreaterThan(0);
  await expect(alert).toHaveCount(0);
  expect(errors).toEqual([]);
});
