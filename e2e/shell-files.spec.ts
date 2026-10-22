import { expect, test } from '@playwright/test';
import { filesReady, listPaths, openShell, readFile, row } from './harness/shell-fixtures';

test.describe('the file tree', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page, 'view=probe');
    await filesReady(page);
  });

  test('restores the sample’s workspace: tabs, starred and open folders', async ({ page }) => {
    await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Winter hexagon', 'Orion Nebula.jpg']);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
    await expect(page.locator('.ws-starred .page-sidebar-nav-label')).toHaveText(['Observing plan', 'Winter hexagon']);
    await expect(page.locator('.probe-name')).toHaveText('Observing plan.md');
    await expect(row(page, 'Guides/Observing plan.md')).toHaveAttribute('aria-selected', 'true');
  });

  test('lists folders first, then files, A to Z, with type tags and counts', async ({ page }) => {
    const top = page.locator('.ws-filetree [role="treeitem"][aria-level="1"]');
    await expect(top).toHaveCount(6);
    expect(await top.evaluateAll((rows) => rows.map((row) => row.getAttribute('data-path')))).toEqual([
      'Charts',
      'Field recordings',
      'Guides',
      'Photos',
      'Sketches',
      'README.md',
    ]);
    // Collapsed folders count their files; media carry their extension.
    await expect(row(page, 'Charts').locator('.ws-ext').first()).toHaveText('2');
    await expect(row(page, 'Photos/Orion Nebula.jpg').locator('.ws-ext')).toHaveText('jpg');
    await expect(row(page, 'Guides/Orion.md').locator('.ws-ext')).toHaveCount(0);
    await expect(row(page, 'Guides')).toHaveAttribute('aria-expanded', 'true');
    await expect(row(page, 'Charts')).toHaveAttribute('aria-expanded', 'false');
  });

  test('arrow keys move through the tree with one row in the tab order', async ({ page }) => {
    await row(page, 'Guides/Observing plan.md').focus();
    await expect(page.locator('.ws-filetree [tabindex="0"]')).toHaveCount(1);
    await page.keyboard.press('ArrowDown');
    await expect(row(page, 'Guides/Orion.md')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(row(page, 'Guides')).toBeFocused();
    await page.keyboard.press('ArrowLeft');
    await expect(row(page, 'Guides')).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('ArrowUp');
    await expect(row(page, 'Field recordings')).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Field recordings')).toHaveAttribute('aria-expanded', 'true');
    await page.keyboard.press('ArrowRight');
    await expect(row(page, 'Field recordings/Crickets at dusk.m4a')).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Crickets at dusk.m4a');
    await expect(page.locator('.ws-filetree [tabindex="0"]')).toHaveCount(1);
    // Letters jump to the next name that starts with them.
    await page.keyboard.press('r');
    await expect(row(page, 'README.md')).toBeFocused();
    await page.keyboard.press('Home');
    await expect(row(page, 'Charts')).toBeFocused();
  });

  test('New note makes Untitled.md, opens it and names it inline', async ({ page }) => {
    await page.locator('.ws-section-actions').getByRole('button', { name: 'New note' }).click();
    const input = page.getByRole('textbox', { name: 'Rename Untitled.md' });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue('Untitled');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Untitled');
    expect(await readFile(page, 'night-sky', 'Untitled.md')).toBe('');
    await input.fill('Field notes');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Field notes.md')).toBeFocused();
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Field notes');
    expect(await listPaths(page, 'night-sky')).toContain('Field notes.md');
    expect(await listPaths(page, 'night-sky')).not.toContain('Untitled.md');
  });

  test('New canvas makes an empty Untitled.excalidraw.md; Escape keeps the name', async ({ page }) => {
    await page.locator('.ws-section-actions').getByRole('button', { name: 'New canvas' }).click();
    const input = page.getByRole('textbox', { name: 'Rename Untitled.excalidraw.md' });
    await expect(input).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(input).toHaveCount(0);
    await expect(row(page, 'Untitled.excalidraw.md')).toBeFocused();
    expect(await readFile(page, 'night-sky', 'Untitled.excalidraw.md')).toBe('');
    await expect(page.locator('.probe-view')).toHaveAttribute('data-kind', 'canvas');
    // A second one gets the next free name.
    await page.locator('.ws-section-actions').getByRole('button', { name: 'New canvas' }).click();
    await expect(page.getByRole('textbox', { name: 'Rename Untitled 2.excalidraw.md' })).toBeFocused();
  });

  test('F2 renames; a taken name is refused and Enter tries again', async ({ page }) => {
    await row(page, 'Guides/Orion.md').focus();
    await page.keyboard.press('F2');
    const input = page.getByRole('textbox', { name: 'Rename Orion.md' });
    await input.fill('Moon phases');
    await page.keyboard.press('Enter');
    await expect(input).toHaveAttribute('aria-invalid', 'true');
    await expect(input).toBeFocused();
    await input.fill('Orion, the hunter');
    await page.keyboard.press('Enter');
    await expect(row(page, 'Guides/Orion, the hunter.md')).toBeFocused();
    expect(await readFile(page, 'night-sky', 'Guides/Orion, the hunter.md')).toContain('Orion');
  });

  test('renaming an open file keeps its tab, renamed', async ({ page }) => {
    await row(page, 'Guides/Observing plan.md').focus();
    await page.keyboard.press('F2');
    await page.getByRole('textbox', { name: 'Rename Observing plan.md' }).fill('Saturday plan');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Saturday plan');
    await expect(page.locator('.ws-starred .page-sidebar-nav-label').first()).toHaveText('Saturday plan');
  });

  test('Delete asks first, then removes the file and its tab', async ({ page }) => {
    await row(page, 'Guides/Observing plan.md').focus();
    await page.keyboard.press('Delete');
    const dialog = page.getByRole('dialog', { name: 'Delete “Observing plan”?' });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Delete' })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    await expect(row(page, 'Guides/Observing plan.md')).toBeFocused();
    await page.keyboard.press('Delete');
    await page.getByRole('dialog').getByRole('button', { name: 'Delete' }).click();
    await expect(row(page, 'Guides/Observing plan.md')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveText(['Winter hexagon', 'Orion Nebula.jpg']);
    expect(await listPaths(page, 'night-sky')).not.toContain('Guides/Observing plan.md');
  });

  test('the right-click menu stars, makes folders and downloads', async ({ page }) => {
    await row(page, 'Guides/Moon phases.md').locator('.page-sidebar-nav-label').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'File' });
    await expect(menu.getByRole('menuitem').first()).toBeFocused();
    await menu.getByRole('menuitem', { name: 'Star' }).click();
    await expect(menu).toHaveCount(0);
    await expect(page.locator('.ws-starred .page-sidebar-nav-label')).toHaveText(['Observing plan', 'Winter hexagon', 'Moon phases']);

    // A folder's menu makes things inside it.
    await row(page, 'Guides').click({ button: 'right' });
    await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: 'New folder' }).click();
    await expect(page.getByRole('textbox', { name: 'Rename New folder' })).toBeFocused();
    await page.keyboard.press('Enter');
    expect(await listPaths(page, 'night-sky')).toContain('Guides/New folder');

    // Canvases also download as plain Excalidraw JSON.
    await row(page, 'Sketches/Winter hexagon.excalidraw.md').locator('.page-sidebar-nav-label').click({ button: 'right' });
    const download = page.waitForEvent('download');
    await page.getByRole('menuitem', { name: 'Download as .excalidraw' }).click();
    const file = await download;
    // WebKit's downloads swap spaces for underscores.
    expect(file.suggestedFilename()).toMatch(/^Winter[ _]hexagon\.excalidraw$/);
    const json = JSON.parse(await (await import('node:fs/promises')).readFile((await file.path())!, 'utf8'));
    expect(json.type).toBe('excalidraw');
    expect(Array.isArray(json.elements)).toBe(true);
  });

  test('menus open from the keyboard and Escape hands focus back', async ({ page }) => {
    await row(page, 'Guides/Orion.md').focus();
    await page.keyboard.press('Shift+F10');
    const menu = page.getByRole('menu', { name: 'File' });
    await expect(menu.getByRole('menuitem', { name: 'Open' })).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitem', { name: /Rename/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(row(page, 'Guides/Orion.md')).toBeFocused();
  });

  test('drag a file onto a folder to move it', async ({ page }) => {
    await row(page, 'Guides/Orion.md')
      .locator('.page-sidebar-nav-label')
      .dragTo(row(page, 'Sketches'));
    await expect(row(page, 'Sketches/Orion.md')).toBeVisible();
    await expect(row(page, 'Guides/Orion.md')).toHaveCount(0);
    expect(await listPaths(page, 'night-sky')).toContain('Sketches/Orion.md');
  });

  test('upload with the button, or drop files from the computer onto a folder', async ({ page }) => {
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.ws-section-actions').getByRole('button', { name: 'Upload files' }).click();
    await (await chooser).setFiles([{ name: 'Moon log.txt', mimeType: 'text/plain', buffer: Buffer.from('Waxing gibbous') }]);
    await expect(row(page, 'Moon log.txt')).toBeVisible();
    expect(await readFile(page, 'night-sky', 'Moon log.txt')).toBe('Waxing gibbous');

    // From the operating system: a drop carrying files.
    await page.evaluate(() => {
      const target = document.querySelector('[data-path="Photos"]')!;
      const data = new DataTransfer();
      data.items.add(new File(['jpeg bytes'], 'Andromeda.jpg', { type: 'image/jpeg' }));
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
      }
    });
    await expect(row(page, 'Photos/Andromeda.jpg')).toBeVisible();
    await expect(page.locator('.ws-status')).toContainText('Added 1 file to Photos');
  });

  test('changes from elsewhere show up, and a removed file’s tab closes', async ({ page }) => {
    await page.evaluate(() => window.__shell.registry.stores.get('night-sky')!.write('Guides/Comets.md', '# Comets\n'));
    await expect(row(page, 'Guides/Comets.md')).toBeVisible();
    await page.evaluate(() => window.__shell.registry.stores.get('night-sky')!.remove('Photos/Orion Nebula.jpg'));
    await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Winter hexagon']);
    await page.evaluate(() =>
      window.__shell.registry.stores.get('night-sky')!.rename('Sketches/Winter hexagon.excalidraw.md', 'Sketches/Hexagon.excalidraw.md'),
    );
    await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Hexagon']);
  });

  test('what’s open is saved to .nebula/workspace.json', async ({ page }) => {
    await page.getByRole('tab', { name: 'Winter hexagon' }).click();
    await expect
      .poll(async () => JSON.parse((await readFile(page, 'night-sky', '.nebula/workspace.json')) ?? '{}').active)
      .toBe('Sketches/Winter hexagon.excalidraw.md');
    await row(page, 'Charts').click();
    await expect
      .poll(async () => JSON.parse((await readFile(page, 'night-sky', '.nebula/workspace.json')) ?? '{}').expanded)
      .toContain('Charts');
  });
});
