import { unzipSync } from 'fflate';
import { readFile } from 'node:fs/promises';
import { closeIntro, currentProjectId, expect, openApp, storedProjects, storedText, switcherTitle, test } from './app-fixtures';

// What a person sets stays set: the page style,
// width and note text, a project's colour from its right-click menu, and the
// dock with two projects, all over a reload. And a project downloads whole.

test('preferences, a project colour and the dock survive a reload', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);

  await page.getByRole('button', { name: 'Settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Appearance' }).click();
  await drawer.getByRole('radio', { name: /Pane/ }).click();
  await drawer.getByRole('radio', { name: 'Stretch' }).click();
  await drawer.getByRole('radio', { name: /Newsreader/ }).click();
  await page.keyboard.press('Escape');
  await expect(drawer).toHaveCount(0);

  // A second project, so the switcher shows planets and the dock has a use.
  await page.locator('.ws-switcher').click();
  await page.getByRole('menuitem', { name: 'New project' }).click();
  const create = page.getByRole('dialog', { name: 'New project' });
  await create.getByRole('textbox', { name: 'Name' }).fill('Field notes');
  await create.getByRole('radio', { name: 'Teal' }).click();
  await create.getByRole('button', { name: 'Create project' }).click();
  await expect(switcherTitle(page)).toHaveText('Field notes');

  await page.locator('.ws-switcher').click();
  await page.getByRole('menuitemcheckbox', { name: 'Dock' }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Dock' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Night Sky's colour, from its right-click menu in the dock.
  const dock = page.getByRole('navigation', { name: 'Projects' });
  await dock.getByRole('button', { name: 'Night Sky' }).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Night Sky' });
  await menu.getByRole('menuitemradio', { name: 'Coral' }).click();
  await expect(menu.getByRole('menuitemradio', { name: 'Coral' })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await expect(dock.getByRole('button', { name: 'Night Sky' })).toHaveAttribute('style', /#fb7a5a/);
  await expect
    .poll(async () => (await storedProjects(page)).map((project) => [project.name, project.color]).sort())
    .toEqual([
      ['Field notes', '#2dd4bf'],
      ['Night Sky', '#fb7a5a'],
    ]);

  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('.ws-root')).toBeVisible();
  const html = page.locator('html');
  await expect(html).toHaveAttribute('data-style', 'pane');
  await expect(html).toHaveAttribute('data-width', 'stretch');
  await expect(html).toHaveAttribute('data-body', 'serif');
  await expect(html).toHaveAttribute('data-dock', '');
  for (const name of ['Field notes', 'Night Sky', 'New project']) await expect(dock.getByRole('button', { name })).toBeVisible();
  await expect(dock.getByRole('button', { name: 'Field notes' })).toHaveAttribute('aria-current', 'true');
  await expect(switcherTitle(page)).toHaveText('Field notes');
  await expect(page.locator('.ws-switcher .ws-planet')).toHaveAttribute('style', /#2dd4bf/);
  await expect(dock.getByRole('button', { name: 'Night Sky' })).toHaveAttribute('style', /#fb7a5a/);
  await expect(dock.getByRole('button', { name: 'Field notes' })).toHaveAttribute('style', /#2dd4bf/);
  const projects = await storedProjects(page);
  expect(projects.map((project) => [project.name, project.color]).sort()).toEqual([
    ['Field notes', '#2dd4bf'],
    ['Night Sky', '#fb7a5a'],
  ]);

  // A new visit opens Settings on Appearance again.
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(drawer.getByRole('tab', { name: 'Appearance' })).toHaveAttribute('aria-selected', 'true');
  await expect(drawer.getByRole('radio', { name: /Pane/ })).toBeChecked();
  await expect(drawer.getByRole('radio', { name: 'Stretch' })).toBeChecked();
  await expect(drawer.getByRole('radio', { name: /Newsreader/ })).toBeChecked();
});

test('Download as .zip holds every file of the project, byte for byte', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  const drawer = page.getByRole('dialog', { name: 'Settings' });
  await drawer.getByRole('tab', { name: 'Project' }).click();
  const download = page.waitForEvent('download');
  await drawer.getByRole('button', { name: 'Download as .zip' }).click();
  const file = await download;
  // WebKit's downloads swap spaces for underscores.
  expect(file.suggestedFilename()).toMatch(/^Night[ _]Sky\.zip$/);
  const entries = unzipSync(new Uint8Array(await readFile((await file.path())!)));
  const names = Object.keys(entries).filter((name) => !name.endsWith('/')).sort();
  expect(names).toEqual([
    '.nebula/project.json',
    'Charts/Star chart — October.pdf',
    'Guides/Moon phases.md',
    'Guides/Observing plan.md',
    'Guides/Orion.md',
    'Photos/Winter hexagon.png',
    'README.md',
    'Sketches/Winter hexagon.excalidraw.md',
  ]);
  for (const name of ['README.md', 'Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md']) {
    expect(new TextDecoder().decode(entries[name]), name).toBe(await storedText(page, projectId, name));
  }
  expect(JSON.parse(new TextDecoder().decode(entries['.nebula/project.json']))).toMatchObject({ name: 'Night Sky', color: '#7c8cff' });
});

test('file links open their file on a fresh load, inside /app, and 2.0’s /p/ links redirect there', async ({ page }) => {
  await openApp(page);
  await closeIntro(page);
  const projectId = currentProjectId(page);

  await page.goto('about:blank');
  await openApp(page, `/p/${projectId}/Guides/Orion.md`);
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Orion');
  await expect(page.locator('.ws-prose')).toContainText('Orion');

  await page.goto('about:blank');
  await openApp(page, `/p/${projectId}/Charts/Star%20chart%20%E2%80%94%20October.pdf`);
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Star chart — October.pdf');
  await expect(page.locator('.ws-stage[data-kind="pdf"] iframe')).toBeVisible();

  // A link from 2.0's previews, at the root, lands in the app.
  await page.goto('about:blank');
  await page.goto(`/p/${projectId}/Guides/Moon%20phases.md`);
  await page.locator('.ws-root').waitFor({ timeout: 30_000 });
  expect(new URL(page.url()).pathname).toBe(`/app/p/${projectId}/Guides/Moon%20phases.md`);
  await expect(page.getByRole('tab', { selected: true })).toHaveText('Moon phases');
});
