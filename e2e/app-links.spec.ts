import { addressPath, baseURL, closeIntro, currentProjectId, expect, openApp, row, storedText, test } from './app-fixtures';

// Copy link and Paste as note. A file's or a
// folder's address is the link an Orbit card holds: on a fresh load it opens
// the file, or Nebula with the folder open in the files. And what an agent
// said, on the clipboard, becomes a note named for when it was pasted.
// Measured in Chromium, where Playwright can grant the page the clipboard.

test.beforeEach(async ({ browserName, context }) => {
  test.skip(browserName !== 'chromium', 'Playwright grants the clipboard to a page in Chromium only.');
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseURL });
});

const clipboard = (page: import('@playwright/test').Page) => page.evaluate(() => navigator.clipboard.readText());

test('a folder’s link opens Nebula with that folder open in the files', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  await expect(row(page, 'Charts')).toHaveAttribute('aria-expanded', 'false');

  await row(page, 'Charts').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  await expect(page.locator('.ws-status-text')).toHaveText('Link copied. It opens in this browser, where the project is.');
  const link = new URL(await clipboard(page));
  expect(link.origin).toBe(new URL(baseURL).origin);
  expect(link.pathname).toBe(`/app/p/${projectId}/Charts`);

  await page.goto('about:blank');
  await openApp(page, link.pathname);
  await expect(row(page, 'Charts')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'Charts')).toBeFocused();
  await expect(page.locator(`.ws-filetree [role="treeitem"][data-path^="Charts/"]`).first()).toBeVisible();
});

test('a tab’s link opens its file on a fresh load', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  const tab = page.getByRole('tab', { selected: true });
  await expect(tab).toHaveText('Observing plan');

  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Copy link' }).click();
  const link = new URL(await clipboard(page));
  expect(link.pathname).toBe(`/app/p/${projectId}/Guides/Observing%20plan.md`);

  await page.goto('about:blank');
  await openApp(page, link.pathname);
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
});

test('Paste as note keeps the clipboard as a note named for when it was pasted, and opens it', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  const reply = '## Deploy review\n\nAll checks passed.\n\n- [x] the tailnet\n- [ ] GitHub, on Bruce’s go\n';
  await page.evaluate((text) => navigator.clipboard.writeText(text), reply);

  await row(page, 'Guides').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste as note' }).click();
  await expect.poll(() => addressPath(page)?.path ?? '').toMatch(/^Guides\/\d{4}-\d{2}-\d{2} \d{2}\.\d{2} Deploy review\.md$/);
  const path = addressPath(page)!.path!;
  await expect(page.getByRole('tab', { selected: true })).toHaveText(path.slice('Guides/'.length, -'.md'.length));
  await expect(page.locator('.ws-prose')).toContainText('All checks passed.');
  await expect(row(page, path)).toBeVisible();
  await expect.poll(() => storedText(page, projectId, path)).toBe(reply);

  // Pasted again within the minute, it gets a name of its own.
  await row(page, 'Guides').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste as note' }).click();
  await expect.poll(() => addressPath(page)?.path ?? '').not.toBe(path);
  const second = addressPath(page)!.path!;
  expect(second).toMatch(/^Guides\/\d{4}-\d{2}-\d{2} \d{2}\.\d{2} Deploy review.*\.md$/);
  await expect.poll(() => storedText(page, projectId, second)).toBe(reply);
  await expect.poll(() => storedText(page, projectId, path)).toBe(reply);
});

test('with nothing on the clipboard, Paste as note says so and makes nothing', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await page.evaluate(() => navigator.clipboard.writeText('  \n'));
  const before = await page.locator('.ws-filetree [role="treeitem"]').count();

  await row(page, 'Guides').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Paste as note' }).click();
  await expect(page.locator('.ws-status-text')).toHaveText('There’s no text on the clipboard to paste.');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
  await expect(page.locator('.ws-filetree [role="treeitem"]')).toHaveCount(before);
});
