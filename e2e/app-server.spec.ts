import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, openApp, row, switcherTitle, test } from './app-fixtures';

// The server tier in a real browser: the built site served with folders, as the
// tailnet copy and `nebula run --projects` serve it. Its bar: an agent's edit appears in
// the open tab within a second.
//
//   NEBULA_E2E_BUILT=1 NEBULA_FILES_PROJECTS=<empty folder> NEBULA_FILES_LABEL=e2e-server \
//     pnpm exec playwright test e2e/app-server.spec.ts

const projects = process.env.NEBULA_FILES_PROJECTS;

test.beforeEach(() => {
  test.skip(!projects, 'Runs against a Nebula server: NEBULA_FILES_PROJECTS=<folder> (and NEBULA_E2E_BUILT=1).');
});

type Place = { place: { label: string }; projects: { id: string; name: string; folder: string }[] };

test('a folder on the server opens as a project, and an agent’s edit shows in the open note within a second', async ({ page, browserName }) => {
  const name = `Artifacts ${browserName}`;
  const folder = join(projects!, name);
  rmSync(folder, { recursive: true, force: true });
  mkdirSync(join(folder, 'Briefs'), { recursive: true });
  writeFileSync(join(folder, 'Briefs', 'Plan.md'), '# Plan\n\nThe first line.\n');

  await openApp(page);
  const info = (await page.evaluate(async () => (await fetch('/nebula-api/v1/place')).json())) as Place;
  const project = info.projects.find((item) => item.folder === name);
  expect(project, 'the server lists the folder').toBeTruthy();

  // A file's link opens it, on the server.
  await openApp(page, `/p/${project!.id}/Briefs/Plan.md`);
  await expect(switcherTitle(page)).toHaveText(name);
  await expect(page.getByText('The first line.')).toBeVisible();
  await expect(page.locator('.ws-status')).toContainText('Saved on e2e-server');
  await expect(page.locator('.page-sidebar-footer-meta').first()).toHaveText('On e2e-server');

  // An agent writes the note on the server: the open tab shows it within a second.
  await page.waitForTimeout(300);
  const started = Date.now();
  writeFileSync(join(folder, 'Briefs', 'Plan.md'), '# Plan\n\nThe agent’s line.\n');
  await expect(page.getByText('The agent’s line.')).toBeVisible({ timeout: 1_000 });
  console.log(`${browserName}: the agent's edit showed after ${Date.now() - started} ms`);

  // A new file appears in the files; deleting it from Nebula deletes it there.
  writeFileSync(join(folder, 'Briefs', 'Second.md'), '# Second\n');
  await expect(row(page, 'Briefs/Second.md')).toBeVisible({ timeout: 2_000 });
  await row(page, 'Briefs/Second.md').focus();
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: 'Delete “Second”?' });
  await expect(dialog).toContainText(`It will be deleted from the folder ‘${name}’ on e2e-server.`);
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Briefs/Second.md')).toHaveCount(0);
  await expect.poll(() => existsSync(join(folder, 'Briefs', 'Second.md'))).toBe(false);
  expect(readFileSync(join(folder, 'Briefs', 'Plan.md'), 'utf8')).toBe('# Plan\n\nThe agent’s line.\n');

  // A folder's delete says its hidden files go too: Nebula doesn't show them.
  mkdirSync(join(folder, 'Old', '.git'), { recursive: true });
  writeFileSync(join(folder, 'Old', 'x.md'), 'x');
  await expect(row(page, 'Old')).toBeVisible({ timeout: 2_000 });
  await row(page, 'Old').focus();
  await page.keyboard.press('Delete');
  const folderDialog = page.getByRole('dialog', { name: 'Delete “Old”?' });
  await expect(folderDialog).toContainText(`deleted from the folder ‘${name}’ on e2e-server. Hidden files in it, such as .git, go with it.`);
  await folderDialog.getByRole('button', { name: 'Delete' }).click();
  await expect(row(page, 'Old')).toHaveCount(0);
  await expect.poll(() => existsSync(join(folder, 'Old'))).toBe(false);
  rmSync(folder, { recursive: true, force: true });
});
