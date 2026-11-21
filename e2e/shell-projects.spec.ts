import { expect, test } from '@playwright/test';
import { filesReady, openShell, row } from './harness/shell-fixtures';

test.describe('projects', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page);
    await filesReady(page);
  });

  test('the switcher lists projects with a tick, and Escape hands focus back', async ({ page, browserName }) => {
    const switcher = page.locator('.ws-switcher');
    await switcher.click();
    await expect(switcher).toHaveAttribute('aria-expanded', 'true');
    const menu = page.getByRole('menu', { name: 'Projects' });
    await expect(menu.getByRole('menuitemradio')).toHaveText([/Night Sky/, /Starscape Biz/, /Orbit/, /Pulse/, /Earth Village/]);
    await expect(menu.getByRole('menuitemradio', { name: /Night Sky/ })).toHaveAttribute('aria-checked', 'true');
    await expect(menu.getByRole('menuitemradio', { name: /Night Sky/ })).toBeFocused();
    await expect(menu.getByRole('menuitemcheckbox', { name: 'Dock' })).toHaveAttribute('aria-checked', 'false');
    await expect(menu.getByRole('menuitem', { name: 'New project' })).toBeVisible();
    // The folder tier is offered only where the browser can pick a folder: Chromium,
    // not WebKit. The server tier hasn't shipped, so it's never named.
    if (browserName === 'chromium') await expect(menu.getByRole('menuitem', { name: /Open a folder/ })).toBeVisible();
    else await expect(menu.getByText('Open a folder')).toHaveCount(0);
    await expect(menu.getByText('Connect to a Nebula server')).toHaveCount(0);
    await page.keyboard.press('ArrowDown');
    await expect(menu.getByRole('menuitemradio', { name: /Starscape Biz/ })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(switcher).toBeFocused();
    // A press outside closes it too.
    await switcher.click();
    await page.locator('.ws-stage').click({ position: { x: 300, y: 300 } });
    await expect(menu).toHaveCount(0);
  });

  test('switching project opens its files', async ({ page }) => {
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitemradio', { name: /Orbit/ }).click();
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Orbit');
    await expect(row(page, 'Roadmap.md')).toBeVisible();
    await expect(row(page, 'Guides')).toHaveCount(0);
    await expect(page.getByRole('tab')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Nothing open' })).toBeVisible();
    // And back: Night Sky's tabs come back from its workspace.json.
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitemradio', { name: /Night Sky/ }).click();
    await expect(page.getByRole('tab')).toHaveText(['Observing plan', 'Winter hexagon', 'Orion Nebula.jpg']);
  });

  test('the Dock switch shows the dock, which switches projects', async ({ page }) => {
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitemcheckbox', { name: 'Dock' }).click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dock' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('html')).toHaveAttribute('data-dock', '');
    expect(await page.evaluate(() => localStorage.getItem('nebula:dock'))).toBe('on');
    await page.keyboard.press('Escape');
    const dock = page.getByRole('navigation', { name: 'Projects' });
    await expect(dock.getByRole('button', { name: 'Night Sky' })).toHaveAttribute('aria-current', 'true');
    await dock.getByRole('button', { name: 'Pulse' }).click();
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Pulse');
    await expect(dock.getByRole('button', { name: 'Pulse' })).toHaveAttribute('aria-current', 'true');
    await dock.getByRole('button', { name: 'New project' }).click();
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  });

  test('right-click the switcher: colour, rename and remove', async ({ page }) => {
    await page.locator('.ws-switcher').click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Night Sky' });
    await expect(menu.getByRole('menuitemradio', { name: 'Periwinkle' })).toBeFocused();
    await menu.getByRole('menuitemradio', { name: 'Coral' }).click();
    await expect(menu.getByRole('menuitemradio', { name: 'Coral' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.locator('.ws-switcher .ws-planet')).toHaveAttribute('style', /#fb7a5a/);

    await menu.getByRole('menuitem', { name: /Rename/ }).click();
    const prompt = page.getByRole('dialog', { name: 'Rename project' });
    await expect(prompt.getByRole('textbox', { name: 'Name' })).toBeFocused();
    await prompt.getByRole('textbox', { name: 'Name' }).fill('Dark skies');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Dark skies');

    await page.locator('.ws-switcher').click({ button: 'right' });
    await page.getByRole('menu', { name: 'Dark skies' }).getByRole('menuitem', { name: /Remove project/ }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove “Dark skies”?' });
    await expect(confirm).toContainText('13 files');
    await confirm.getByRole('button', { name: 'Remove project' }).click();
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Starscape Biz');
    await page.locator('.ws-switcher').click();
    await expect(page.getByRole('menuitemradio')).toHaveCount(4);
  });

  test('a project row in the menu has the same right-click menu', async ({ page }) => {
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitemradio', { name: /Orbit/ }).click({ button: 'right' });
    const menu = page.getByRole('menu', { name: 'Orbit' });
    await expect(menu).toBeVisible();
    await menu.getByRole('menuitemradio', { name: 'Amber' }).click();
    // The project menu stays open beneath, with Orbit's planet recoloured.
    await expect(page.getByRole('menu', { name: 'Projects' }).getByRole('menuitemradio', { name: /Orbit/ }).locator('.ws-planet')).toHaveAttribute(
      'style',
      /#fbbf24/,
    );
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(page.getByRole('menu', { name: 'Projects' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu', { name: 'Projects' })).toHaveCount(0);
  });

  test('New project: name and colour, then it opens empty', async ({ page }) => {
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    const name = dialog.getByRole('textbox', { name: 'Name' });
    await expect(name).toBeFocused();
    await name.fill('Field notes');
    await expect(dialog.locator('.ws-np-name')).toHaveText('Field notes');
    await dialog.getByRole('radio', { name: 'Teal' }).click();
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Field notes');
    await expect(page.locator('.ws-switcher .ws-planet')).toHaveAttribute('style', /#2dd4bf/);
    await expect(page.getByRole('heading', { name: 'Nothing open' })).toBeVisible();
    await expect(page.locator('.ws-tree-empty')).toBeVisible();
  });

  test('the colour swatches take arrow keys', async ({ page }) => {
    await page.locator('.ws-switcher').click();
    await page.getByRole('menuitem', { name: 'New project' }).click();
    const dialog = page.getByRole('dialog', { name: 'New project' });
    const group = dialog.getByRole('radiogroup', { name: 'Colour' });
    await group.getByRole('radio', { checked: true }).focus();
    const before = await group.getByRole('radio', { checked: true }).getAttribute('aria-label');
    await page.keyboard.press('ArrowRight');
    await expect(group.getByRole('radio', { checked: true })).toBeFocused();
    expect(await group.getByRole('radio', { checked: true }).getAttribute('aria-label')).not.toBe(before);
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });
});

test.describe('one project', () => {
  test('shows the Nebula logo and no Dock switch', async ({ page }) => {
    await openShell(page, 'projects=1');
    await filesReady(page);
    await expect(page.locator('.ws-switcher .ws-switcher-logo')).toBeVisible();
    await expect(page.locator('.ws-switcher .ws-planet')).toHaveCount(0);
    await page.locator('.ws-switcher').click();
    await expect(page.getByRole('menuitemcheckbox', { name: 'Dock' })).toHaveCount(0);
    await expect(page.getByRole('menuitemradio')).toHaveCount(1);
  });
});

test.describe('settings', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page);
    await filesReady(page);
    await page.getByRole('button', { name: 'Settings' }).click();
  });

  test('Appearance sets the theme and the workspace preferences', async ({ page }) => {
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    // Appearance comes first, and Settings opens on it.
    await expect(drawer.getByRole('tab', { name: 'Appearance' })).toBeFocused();
    await drawer.getByRole('radio', { name: 'Day' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
    await expect(drawer.getByRole('radiogroup', { name: 'Day background' })).toBeVisible();
    await drawer.getByRole('radio', { name: 'Night' }).click();
    await drawer.getByRole('radio', { name: /Pane/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-style', 'pane');
    await drawer.getByRole('radio', { name: 'Stretch' }).click();
    await expect(page.locator('html')).toHaveAttribute('data-width', 'stretch');
    await drawer.getByRole('radio', { name: /Newsreader/ }).click();
    await expect(page.locator('html')).toHaveAttribute('data-body', 'serif');
    await drawer.getByText('Show projects in a dock').click();
    await expect(page.locator('.ws-dock')).toBeVisible();
    await drawer.getByText('Animated background').click();
    expect(await page.evaluate(() => localStorage.getItem('nebula:motion'))).toBe('full');
    expect(await page.evaluate(() => [localStorage.getItem('nebula:style'), localStorage.getItem('nebula:width'), localStorage.getItem('nebula:body')])).toEqual([
      'pane',
      'stretch',
      'serif',
    ]);
  });

  test('Escape closes it and focus goes back to the gear', async ({ page }) => {
    await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Settings' })).toBeFocused();
  });

  test('Project renames, recolours, imports and removes', async ({ page }) => {
    const drawer = page.getByRole('dialog', { name: 'Settings' });
    await drawer.getByRole('tab', { name: 'Project' }).click();
    const name = drawer.getByRole('textbox', { name: 'Name' });
    await expect(name).toHaveValue('Night Sky');
    await name.fill('Deep sky');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Deep sky');
    await drawer.getByRole('radio', { name: 'Violet' }).click();
    await expect(page.locator('.ws-switcher .ws-planet')).toHaveAttribute('style', /#a78bfa/);
    await expect(drawer).toContainText('13 files');
    const chooser = page.waitForEvent('filechooser');
    await drawer.getByRole('button', { name: 'Import files…' }).click();
    await (await chooser).setFiles([{ name: 'Log.md', mimeType: 'text/markdown', buffer: Buffer.from('# Log\n') }]);
    await expect(drawer).toContainText('14 files');
    await drawer.getByRole('button', { name: 'Download as .zip' }).click();
    expect(await page.evaluate(() => window.__shell.downloads)).toEqual(['night-sky']);
    await drawer.getByRole('button', { name: 'Remove project…' }).click();
    await page.getByRole('dialog', { name: 'Remove “Deep sky”?' }).getByRole('button', { name: 'Remove project' }).click();
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Starscape Biz');
  });
});

test.describe('quick open', () => {
  test.beforeEach(async ({ page }) => {
    await openShell(page);
    await filesReady(page);
  });

  test('Ctrl+K finds files by name, highlighted, and Enter opens one', async ({ page }) => {
    await page.keyboard.press('Control+k');
    const palette = page.getByRole('dialog', { name: 'Search or jump to' });
    const input = palette.getByRole('combobox');
    await expect(input).toBeFocused();
    await input.fill('or');
    const options = palette.getByRole('option');
    await expect(options.first()).toContainText('Orion');
    await expect(options.first().locator('mark')).toHaveText('Or');
    await expect(options.first()).toHaveAttribute('aria-selected', 'true');
    await expect(palette.getByRole('group', { name: 'Other projects' }).getByRole('option')).toHaveText([/Orbit/]);
    await page.keyboard.press('ArrowDown');
    await expect(options.nth(1)).toHaveAttribute('aria-selected', 'true');
    await expect(input).toHaveAttribute('aria-activedescendant', (await options.nth(1).getAttribute('id'))!);
    await page.keyboard.press('ArrowUp');
    await page.keyboard.press('Enter');
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole('tab', { selected: true })).toHaveText('Orion');
  });

  test('Escape closes it; other projects switch', async ({ page }) => {
    await page.getByRole('button', { name: /Search or jump to/ }).click();
    const palette = page.getByRole('dialog', { name: 'Search or jump to' });
    await page.keyboard.press('Escape');
    await expect(palette).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Search or jump to/ })).toBeFocused();
    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('earth');
    await expect(palette.getByRole('option')).toHaveText([/Earth Village/]);
    await page.keyboard.press('Enter');
    await expect(page.locator('.ws-switcher .page-sidebar-title')).toHaveText('Earth Village');
    await page.keyboard.press('Control+k');
    await palette.getByRole('combobox').fill('zzz');
    await expect(palette).toContainText('Nothing here is called “zzz”.');
  });
});

test.describe('welcome', () => {
  test('a first visit: Explore the sample has focus; it shows once', async ({ page }) => {
    await openShell(page, 'intro=welcome&projects=1');
    const dialog = page.getByRole('dialog', { name: 'Starscape Nebula' });
    await expect(dialog.getByRole('button', { name: 'Explore the sample' })).toBeFocused();
    await expect(dialog).toContainText('Night Sky is a small sample project');
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect(await page.evaluate(() => window.__shell.introDone)).toBe(1);
  });

  test('Start empty goes on to New project', async ({ page }) => {
    await openShell(page, 'intro=welcome&projects=1');
    await page.getByRole('button', { name: 'Start empty' }).click();
    await expect(page.getByRole('dialog', { name: 'New project' })).toBeVisible();
  });
});
