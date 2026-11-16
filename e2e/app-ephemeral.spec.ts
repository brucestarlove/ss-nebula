import type { BrowserContext, Page } from '@playwright/test';
import { expect, failOpfs, openApp, test } from './app-fixtures';

// A browser that keeps nothing: Playwright's
// ephemeral WebKit has no OPFS, as private windows don't. Nebula runs on
// memory, says so, offers Download, and nothing claims to be saved.

test.use({ ephemeral: true });

async function keepNothing(context: BrowserContext, browserName: string) {
  // Chromium keeps OPFS in any context: make it fail the way WebKit's does.
  if (browserName === 'chromium') await failOpfs(context);
}

/** Every word on the page that says files are kept or saved for good. */
async function claimsToKeep(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText);
  return [...text.matchAll(/[^.\n]*\b(saved|kept|keeps?)\b[^.\n]*(this browser|this device)[^.\n]*/gi)].map((match) => match[0].trim());
}

test('the keeps-nothing notice shows, and nothing claims to be saved', async ({ page, context, browserName }) => {
  await keepNothing(context, browserName);
  const errors = await openApp(page);

  const welcome = page.locator('dialog.ws-welcome');
  await expect(welcome).toContainText('This browser can’t keep files here, so projects last until you close this tab.');
  expect(await claimsToKeep(page)).toEqual([]);
  await welcome.getByRole('button', { name: 'Explore the sample' }).click();

  const notice = page.locator('.ws-ephemeral[role="note"]');
  await expect(notice).toContainText('This browser won’t keep files here, so they’ll be gone when you close this tab.');
  await expect(notice.getByRole('button', { name: 'Download' })).toBeVisible();
  await expect(page.locator('.ws-status')).toContainText('Kept in this tab only');
  await expect(page.locator('.ws-switcher')).toContainText('In this tab only');
  expect(await claimsToKeep(page)).toEqual([]);

  // An edit is kept in the tab, and still nothing says saved.
  await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();
  await page.locator('.ws-page .cm-content').click();
  await page.keyboard.press('ControlOrMeta+End');
  await page.keyboard.type('\nClouds by ten.');
  await expect(page.locator('.ws-status')).toContainText('Kept in this tab only', { timeout: 10_000 });
  expect(await claimsToKeep(page)).toEqual([]);

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'Project' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toContainText('this tab');
  expect(await claimsToKeep(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('New project doesn’t promise to keep the files either', async ({ page, context, browserName }) => {
  await keepNothing(context, browserName);
  await openApp(page);
  await page.locator('dialog.ws-welcome').getByRole('button', { name: 'Explore the sample' }).click();
  await page.locator('.ws-switcher').click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  expect(await claimsToKeep(page)).toEqual([]);
});
