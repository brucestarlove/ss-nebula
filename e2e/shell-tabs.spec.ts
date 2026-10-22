import { expect, test } from '@playwright/test';
import { filesReady, openShell, readFile, row } from './harness/shell-fixtures';

test.describe('tabs, stage, outline and status', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page, 'view=probe');
    await filesReady(page);
  });

  test('a click opens a file or focuses its tab', async ({ page }) => {
    await row(page, 'Guides/Orion.md').click();
    await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Winter hexagon', 'Orion Nebula.jpg', 'Orion']);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Orion');
    await expect(page.locator('.probe-name')).toHaveText('Orion.md');
    await row(page, 'Guides/Observing plan.md').click();
    await expect(page.getByRole('tab')).toHaveCount(4);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
    await expect(page.locator('#ws-stage')).toHaveAttribute('aria-labelledby', /ws-tab-/);
  });

  test('close with the ×, a middle click or Delete; the neighbour takes over', async ({ page }) => {
    await page.getByRole('tab', { name: 'Observing plan' }).locator('.ws-tab-close').click();
    await expect(page.getByRole('tab')).toHaveText(['Winter hexagon', 'Orion Nebula.jpg']);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Winter hexagon');
    await page.getByRole('tab', { name: 'Orion Nebula.jpg' }).click({ button: 'middle' });
    await expect(page.getByRole('tab')).toHaveText(['Winter hexagon']);
    await page.getByRole('tab', { name: 'Winter hexagon' }).focus();
    await page.keyboard.press('Delete');
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing open' })).toBeVisible();
    // The empty stage offers the next step.
    await page.locator('.ws-empty').getByRole('button', { name: 'New note' }).click();
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Untitled');
  });

  test('arrow keys move between tabs', async ({ page }) => {
    await page.getByRole('tab', { name: 'Observing plan' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Winter hexagon' })).toBeFocused();
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Winter hexagon');
    await page.keyboard.press('End');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Orion Nebula.jpg');
    await expect(page.getByRole('tab', { name: 'Orion Nebula.jpg' })).toBeFocused();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Observing plan');
    await expect(page.getByRole('tab', { name: 'Observing plan' })).toBeFocused();
  });

  test('drag a tab to reorder', async ({ page }) => {
    await page.getByRole('tab', { name: 'Orion Nebula.jpg' }).dragTo(page.getByRole('tab', { name: 'Observing plan' }), {
      targetPosition: { x: 4, y: 10 },
    });
    await expect(page.getByRole('tab')).toHaveText(['Orion Nebula.jpg', 'Observing plan', 'Winter hexagon']);
    await expect
      .poll(async () => JSON.parse((await readFile(page, 'night-sky', '.nebula/workspace.json')) ?? '{}').tabs)
      .toEqual(['Photos/Orion Nebula.jpg', 'Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md']);
  });

  test('a tab’s right-click menu closes the others and shows the file in the tree', async ({ page }) => {
    await page.getByRole('tab', { name: 'Winter hexagon' }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Tab' });
    await menu.getByRole('menuitem', { name: 'Close others' }).click();
    await expect(page.getByRole('tab')).toHaveText(['Winter hexagon']);
    await row(page, 'Sketches').click();
    await expect(row(page, 'Sketches')).toHaveAttribute('aria-expanded', 'false');
    await page.getByRole('tab', { name: 'Winter hexagon' }).click({ button: 'right' });
    await page.getByRole('menu', { name: 'Tab' }).getByRole('menuitem', { name: 'Show in files' }).click();
    await expect(row(page, 'Sketches/Winter hexagon.excalidraw.md')).toBeFocused();
  });

  test('the view’s status and unsaved state show in the tab and the status line', async ({ page }) => {
    const status = page.locator('.ws-status');
    await expect(status).toContainText('Saved in this browser');
    await expect(status).toContainText(/\d+ words/);
    await page.locator('.probe-draft').fill(' More.');
    const tab = page.getByRole('tab', { name: /Observing plan/ });
    await expect(tab).toHaveAttribute('data-dirty', '');
    await expect(tab).toContainText('unsaved changes');
    await expect(status).toContainText('Saving…');
    await page.locator('.probe-save').click();
    await expect(tab).not.toHaveAttribute('data-dirty', '');
    await expect(status).toContainText('Saved in this browser');
  });

  test('the Outline lists the note’s headings and jumps to them', async ({ page }) => {
    const toggle = page.getByRole('button', { name: 'Outline' });
    await expect(page.locator('#ws-panel')).toHaveCount(0);
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    const outline = page.getByRole('complementary', { name: 'Outline' });
    await expect(outline.getByRole('button')).toHaveText(['Observing plan', 'Targets', 'Pack']);
    await outline.getByRole('button', { name: 'Pack' }).click();
    await expect(page.locator('#ws-stage h2', { hasText: 'Pack' })).toBeFocused();
    await page.getByRole('tab', { name: 'Winter hexagon' }).click();
    await expect(outline).toContainText('Open a note to see its headings here.');
    await toggle.click();
    await expect(page.locator('#ws-panel')).toHaveCount(0);
  });

  test('the rail folds to its toolbelt with Ctrl+\\ and back', async ({ page }) => {
    await page.keyboard.press('Control+Backslash');
    await expect(page.locator('.ws')).toHaveAttribute('data-collapsed', '');
    const belt = page.getByRole('group', { name: 'Quick actions' });
    await expect(belt.getByRole('button')).toHaveCount(4);
    await expect(page.locator('.ws-tree')).toBeHidden();
    await belt.getByRole('button', { name: 'Show files' }).click();
    await expect(page.locator('.ws')).not.toHaveAttribute('data-collapsed', '');
    await page.getByRole('button', { name: 'Collapse the sidebar' }).click();
    await expect(page.getByRole('button', { name: 'Collapse the sidebar' })).toHaveAttribute('aria-pressed', 'true');
  });

  test('Help opens the About dialog, or the host’s help', async ({ page }) => {
    await page.getByRole('button', { name: 'Help' }).click();
    await expect(page.locator('dialog.nebula-about[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog.nebula-about[open]')).toHaveCount(0);

    await openShell(page, 'help=link');
    await page.getByRole('button', { name: 'Help' }).click();
    expect(await page.evaluate(() => window.__shell.help)).toBe(1);
  });

  test('the theme button flips night and day', async ({ page }) => {
    await page.getByRole('button', { name: 'Switch to day' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(page.locator('.ws-root')).not.toHaveAttribute('data-night', '');
    await page.getByRole('button', { name: 'Switch to night' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  });
});

test('a browser that keeps nothing says so, calmly, and offers a download', async ({ page }) => {
  await openShell(page, 'persistent=0');
  const note = page.getByRole('note');
  await expect(note).toContainText('This browser won’t keep files here');
  await expect(page.locator('.ws-status')).toContainText('Kept in this tab only');
  await expect(page.locator('.ws-rail-footer')).toContainText('In this tab only');
  await note.getByRole('button', { name: 'Download' }).click();
  expect(await page.evaluate(() => window.__shell.downloads)).toEqual(['night-sky']);
});
