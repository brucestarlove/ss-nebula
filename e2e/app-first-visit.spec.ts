import { addressPath, closeIntro, expect, openApp, row, storedProjects, switcherTitle, test } from './app-fixtures';

// A brand-new visitor (docs/slice-3.md, decision 5): the welcome, the Night
// Sky sample with the Nebula logo standing in for its planet, and the
// observing plan open. A reload keeps all of it and never welcomes twice.

test('a first visit: the welcome over Night Sky, the observing plan open', async ({ page }) => {
  const errors = await openApp(page);
  const welcome = page.locator('dialog.ws-welcome');
  await expect(welcome.getByRole('heading', { name: 'Starscape Nebula' })).toBeVisible();
  await expect(welcome).toContainText('Notes, drawings and media, together in projects.');
  await expect(welcome).toContainText('Night Sky is a small sample project.');
  await expect(welcome.getByRole('button', { name: 'Explore the sample' })).toBeFocused();

  await expect(switcherTitle(page)).toHaveText('Night Sky');
  await expect(page.locator('.ws-switcher .ws-switcher-logo')).toBeVisible();
  await expect(page.locator('.ws-switcher .ws-planet')).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Winter hexagon', 'Winter hexagon.png']);
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
  await expect(page.locator('.ws-stage[data-kind="note"] .ws-page h1')).toHaveText('Observing plan');

  await closeIntro(page);
  // The title shows once: the note's own '# Observing plan' isn't repeated.
  await expect(page.locator('.ws-page h1')).toHaveCount(1);
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await expect(row(page, 'Guides/Observing plan.md')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.ws-status')).toContainText('Saved in this browser');

  const address = addressPath(page);
  expect(address?.path).toBe('Guides/Observing plan.md');
  const [project] = await storedProjects(page);
  expect(project).toMatchObject({ id: address?.projectId, name: 'Night Sky', color: '#7c8cff' });
  expect(project.files.filter((path) => !path.startsWith('.nebula/'))).toEqual([
    'Charts/Star chart — October.pdf',
    'Guides/Moon phases.md',
    'Guides/Observing plan.md',
    'Guides/Orion.md',
    'Photos/Winter hexagon.png',
    'README.md',
    'Sketches/Winter hexagon.excalidraw.md',
  ]);
  expect(errors).toEqual([]);
});

test('a reload keeps the project and what was open, with no second welcome', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const first = page.url();
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
  await expect(page.locator('dialog.ws-welcome')).toHaveCount(0);
  expect(page.url()).toBe(first);
  expect(await storedProjects(page)).toHaveLength(1);
});

test('the welcome comes once, even when the page reloads before it is closed', async ({ page }) => {
  await openApp(page);
  await expect(page.locator('dialog.ws-welcome')).toBeVisible();
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await expect(page.locator('dialog.ws-welcome')).toHaveCount(0);
  expect(await storedProjects(page)).toHaveLength(1);
});

test('the address follows the open tab, and a reload returns to it', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
  await expect.poll(() => addressPath(page)?.path).toBe('Sketches/Winter hexagon.excalidraw.md');
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Winter hexagon');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  await expect(page.locator('.ws-status')).toContainText(/\d+ elements · \d+%/);
});

test('asks the browser to keep the files only after the first edit', async ({ page, context }) => {
  await context.addInitScript(() => {
    const calls: string[] = [];
    (window as unknown as { __persistCalls: string[] }).__persistCalls = calls;
    // On the prototype: WebKit ignores methods assigned to navigator.storage itself.
    Object.defineProperty(StorageManager.prototype, 'persist', {
      configurable: true,
      value: async () => {
        calls.push('persist');
        return true;
      },
    });
    Object.defineProperty(StorageManager.prototype, 'persisted', { configurable: true, value: async () => false });
  });
  await openApp(page);
  await closeIntro(page);
  await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  expect(await page.evaluate(() => (window as unknown as { __persistCalls: string[] }).__persistCalls)).toEqual([]);

  await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __persistCalls: string[] }).__persistCalls)).toEqual(['persist']);
});
