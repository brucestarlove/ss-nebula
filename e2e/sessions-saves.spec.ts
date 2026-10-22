import { drawRectangle, editNote, expect, files, openPath, openSessions, PATHS, renameRow, row, shownElements, test } from './harness/sessions-test';

// Saves land where the file is, when it's still there, and nothing is
// mounted again or walked again for them (review findings 1, 2, 4, 13, 15,
// 21, 26), on the real OPFS store.

test('a note being saved follows its folder’s rename', async ({ page }) => {
  // Each write is held back 400 ms, so the rename comes while the save is in flight.
  const errors = await openSessions(page, `file=${encodeURIComponent(PATHS.note)}&slow=400`);
  await editNote(page);
  await page.keyboard.type('\nRenamed while saving.');
  await renameRow(page, 'Guides', 'Archive');
  await expect(row(page, 'Archive')).toBeVisible();
  await expect.poll(() => files.read(page, 'Archive/Observing plan.md'), { timeout: 5_000 }).toContain('Renamed while saving.');
  await page.waitForTimeout(1_000);
  expect((await files.paths(page)).filter((path) => path.startsWith('Guides'))).toEqual([]);
  expect(errors).toEqual([]);
});

test('a canvas being saved follows its folder’s rename', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.empty)}&slow=400`);
  expect(await shownElements(page)).toBe(0);
  await drawRectangle(page, { x: 0.5, y: 0.4 });
  await renameRow(page, 'Sketches', 'Drawings');
  await expect.poll(async () => (await files.scene(page, 'Drawings/Empty.excalidraw.md'))?.ids.length ?? 0, { timeout: 5_000 }).toBe(1);
  await page.waitForTimeout(1_000);
  expect((await files.paths(page)).filter((path) => path.startsWith('Sketches'))).toEqual([]);
});

test('a canvas reopened while its last save is in flight opens with that change', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.empty)}&slow=1500`);
  expect(await shownElements(page)).toBe(0);
  await openPath(page, PATHS.note);
  await page.getByRole('tab', { name: 'Empty' }).click();
  expect(await shownElements(page)).toBe(0);
  await drawRectangle(page, { x: 0.5, y: 0.4 });
  await expect.poll(() => shownElements(page)).toBe(1);
  // Away and straight back: the save is still being written.
  await page.getByRole('tab', { name: 'Observing plan' }).click();
  await page.getByRole('tab', { name: 'Empty' }).click();
  expect(await shownElements(page)).toBe(1);
  await expect.poll(async () => (await files.scene(page, PATHS.empty))?.ids.length ?? 0, { timeout: 5_000 }).toBe(1);
});

test('an open note stays mounted, and keeps the caret, while it saves', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}`);
  await editNote(page);
  await page.locator('.ws-note').evaluate((node) => {
    (node as HTMLElement).dataset.mark = 'first';
  });
  for (const word of [' one', ' two', ' three']) {
    const before = await files.writes(page, PATHS.note);
    await page.keyboard.type(word);
    await expect.poll(() => files.writes(page, PATHS.note), { timeout: 5_000 }).toBeGreaterThan(before);
  }
  await expect(page.locator('.ws-note')).toHaveAttribute('data-mark', 'first');
  await expect(page.locator('.ws-note .cm-content')).toBeFocused();
  await page.keyboard.type(' four');
  await expect.poll(() => files.read(page, PATHS.note), { timeout: 5_000 }).toContain('one two three four');
});

test('a folder deleted while a note in it is being saved stays deleted', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}&slow=400`);
  await editNote(page);
  await page.keyboard.type('\nAbout to go.');
  await page.waitForTimeout(600);
  await row(page, 'Guides').focus();
  await page.keyboard.press('Delete');
  await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Guides')).toHaveCount(0);
  await page.waitForTimeout(2_000);
  expect((await files.paths(page)).filter((path) => path.startsWith('Guides'))).toEqual([]);
});

test('closing the page asks first while an edit isn’t saved, and not once it is', async ({ page, context }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.note)}&slow=2000`);
  await editNote(page);
  await page.keyboard.type(' Unsaved.');
  const asked = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await asked;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await expect.poll(() => files.read(page, PATHS.note), { timeout: 8_000 }).toContain('Unsaved.');
  await expect(page.locator('.ws-tab[data-dirty]')).toHaveCount(0);
  let again = false;
  page.on('dialog', (next) => {
    again = true;
    void next.accept();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(again).toBe(false);
  void context;
});

test('turning the grid on is saved with the drawing', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.hexagon)}`);
  await shownElements(page);
  await page.waitForTimeout(800);
  expect(await files.writes(page, PATHS.hexagon)).toBe(0);
  const canvas = page.locator('.ws-canvas .excalidraw canvas.interactive');
  const box = (await canvas.boundingBox())!;
  // Excalidraw's own shortcut for the grid, with the canvas focused.
  await page.mouse.click(box.x + 30, box.y + box.height - 30);
  await page.keyboard.press('ControlOrMeta+Quote');
  await expect.poll(async () => (await files.scene(page, PATHS.hexagon))?.appState.gridModeEnabled, { timeout: 5_000 }).toBe(true);
});

test('drawing doesn’t walk the whole project for each save', async ({ page }) => {
  await openSessions(page, `file=${encodeURIComponent(PATHS.empty)}`);
  expect(await shownElements(page)).toBe(0);
  await page.waitForTimeout(500);
  const lists = await files.lists(page);
  for (const [index, x] of [0.3, 0.5, 0.7].entries()) {
    await drawRectangle(page, { x, y: 0.4 });
    await expect.poll(async () => (await files.scene(page, PATHS.empty))?.ids.length ?? 0, { timeout: 5_000 }).toBe(index + 1);
  }
  expect(await files.writes(page, PATHS.empty)).toBeGreaterThanOrEqual(3);
  expect(await files.lists(page)).toBe(lists);
});
