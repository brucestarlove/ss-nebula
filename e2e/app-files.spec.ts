import {
  closeIntro,
  currentProjectId,
  decodeCanvasFile,
  drawRectangle,
  elementCount,
  expect,
  liveScene,
  openApp,
  openFromTree,
  pngFile,
  row,
  saved,
  storedProjects,
  storedText,
  test,
  uploadFiles,
} from './app-fixtures';

// Managing files on the browser tier, checked against what OPFS holds: a new
// note keeps its text over a reload; rename, move and delete reach the files;
// an uploaded image opens; a new canvas keeps its drawing over a reload.

async function projectFiles(page: import('@playwright/test').Page): Promise<string[]> {
  const [project] = await storedProjects(page);
  return project.files.filter((path) => !path.startsWith('.nebula/'));
}

test('a new note keeps what was typed over a reload', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
  const name = page.getByRole('textbox', { name: 'Rename Untitled.md' });
  await expect(name).toBeFocused();
  await name.fill('Field notes');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Field notes');
  await expect.poll(() => storedText(page, projectId, 'Field notes.md')).toBe('');

  await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.ws-page .cm-content');
  await expect(editor).toBeVisible({ timeout: 20_000 });
  await editor.click();
  await page.keyboard.type('Clear skies after midnight. Jupiter rises at 11.');
  await expect.poll(() => storedText(page, projectId, 'Field notes.md'), { timeout: 10_000 }).toBe('Clear skies after midnight. Jupiter rises at 11.');
  await saved(page);

  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Field notes');
  await expect(page.locator('.ws-page')).toContainText('Clear skies after midnight. Jupiter rises at 11.');
});

test('rename, move into a folder and delete reach the files', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);

  // Rename with F2.
  await row(page, 'Guides/Orion.md').focus();
  await page.keyboard.press('F2');
  await page.getByRole('textbox', { name: 'Rename Orion.md' }).fill('Orion, the hunter');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Guides/Orion, the hunter.md')).toBeVisible();
  await expect.poll(() => projectFiles(page)).toContain('Guides/Orion, the hunter.md');
  expect(await projectFiles(page)).not.toContain('Guides/Orion.md');

  // Move by dragging onto a folder.
  await row(page, 'Guides/Orion, the hunter.md').locator('.page-sidebar-nav-label').dragTo(row(page, 'Sketches'));
  await expect(row(page, 'Sketches/Orion, the hunter.md')).toBeVisible();
  await expect.poll(() => projectFiles(page)).toContain('Sketches/Orion, the hunter.md');
  expect(await projectFiles(page)).not.toContain('Guides/Orion, the hunter.md');

  // Delete, after the question.
  await row(page, 'Sketches/Orion, the hunter.md').focus();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete “Orion, the hunter”?' });
  await expect(dialog).toContainText('It will be deleted from this browser.');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Sketches/Orion, the hunter.md')).toHaveCount(0);
  await expect.poll(() => projectFiles(page)).not.toContain('Sketches/Orion, the hunter.md');

  // All of it holds over a reload.
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(row(page, 'Sketches')).toBeVisible();
  await expect(row(page, 'Sketches/Orion, the hunter.md')).toHaveCount(0);
  await expect(row(page, 'Guides/Orion.md')).toHaveCount(0);
});

test('an uploaded image is kept and opens', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  await uploadFiles(page, [{ name: 'Pleiades.png', mimeType: 'image/png', buffer: pngFile() }]);
  await expect.poll(() => projectFiles(page)).toContain('Pleiades.png');
  await openFromTree(page, 'Pleiades.png');
  const image = page.locator('.ws-stage[data-kind="image"] img');
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((node: HTMLImageElement) => node.naturalWidth)).toBe(16);
  // "Added 1 file." holds the status line for 5 s, as long as expect's own wait.
  await expect(page.locator('.ws-status')).toContainText('16 × 16 px', { timeout: 10_000 });
});

test('a new canvas keeps its drawing over a reload', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  await page.locator('.ws-section-actions').getByRole('button', { name: 'New canvas' }).click();
  const name = page.getByRole('textbox', { name: 'Rename Untitled.excalidraw.md' });
  await name.fill('Meteor watch');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Meteor watch');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  expect(await elementCount(page)).toBe(0);

  await drawRectangle(page, { x: 0.45, y: 0.45 });
  await expect.poll(() => elementCount(page)).toBe(1);
  const drawn = (await liveScene(page)).ids;
  // A new canvas is an empty file until its first save lands, and a throw
  // ends expect.poll at once, so an empty file reads as no elements yet.
  const storedIds = async () => {
    const text = await storedText(page, projectId, 'Meteor watch.excalidraw.md');
    return text ? (await decodeCanvasFile(text)).elements.map((element) => element.id) : [];
  };
  await expect.poll(storedIds, { timeout: 10_000 }).toEqual(drawn);
  await saved(page);

  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Meteor watch');
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  expect(await elementCount(page)).toBe(1);
  expect((await liveScene(page)).ids).toEqual(drawn);
});
