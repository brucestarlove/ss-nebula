// A project in a folder on this computer, in the real app:
// a picked folder opens as a project, edits land on disk, files another app
// changes show up, it opens again after a reload, and a forgotten permission
// is one click from back.
//
// showDirectoryPicker() can't be driven from Playwright, so an init script
// stands it in: it returns a folder of the origin private file system (the
// same FileSystemDirectoryHandle interface), `e2e-picked/<name>`. OPFS
// folders are always allowed, so the same script lets a test say what
// queryPermission() answers (sessionStorage `e2e:permission`), and
// requestPermission() grants. Real folders' permission prompts are covered by
// the unit tests' fake handles (src/files/folderRegistry.test.ts,
// src/workspace/folderAccess.test.tsx) and by Bruce's check on his Mac.
//
// With NEBULA_FOLDER_SHOTS set to a folder, it also renders each new state
// at 1440 and 390 wide, by night and by day.
import { test as base, expect, type BrowserContext, type Page } from '@playwright/test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.NEBULA_E2E_PORT || 4340);
const baseURL = `http://127.0.0.1:${port}`;
const shots = process.env.NEBULA_FOLDER_SHOTS;

type Options = { screen: { width: number; height: number }; theme: 'dark' | 'light' };

const test = base.extend<Options & { folderContext: BrowserContext; app: Page }>({
  screen: [{ width: 1440, height: 900 }, { option: true }],
  theme: ['dark', { option: true }],
  folderContext: async ({ playwright, screen, theme }, provide) => {
    const dir = mkdtempSync(join(tmpdir(), 'nebula-folder-'));
    const phone = screen.width < 600;
    const context = await playwright.chromium.launchPersistentContext(dir, {
      baseURL,
      viewport: screen,
      ...(phone ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}),
    });
    await context.addInitScript(
      ({ theme }) => {
        if (!localStorage.getItem('e2e:seeded')) {
          localStorage.setItem('nebula:theme', theme);
          localStorage.setItem('e2e:seeded', '1');
        }
        // The folder picker, standing in: a folder of OPFS.
        (window as unknown as { showDirectoryPicker: () => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker = async () => {
          const root = await navigator.storage.getDirectory();
          const picked = await root.getDirectoryHandle('e2e-picked', { create: true });
          return picked.getDirectoryHandle(sessionStorage.getItem('e2e:pick') ?? 'Notes', { create: true });
        };
        const proto = FileSystemDirectoryHandle.prototype as unknown as {
          queryPermission(descriptor: unknown): Promise<PermissionState>;
          requestPermission(descriptor: unknown): Promise<PermissionState>;
        };
        const query = proto.queryPermission;
        proto.queryPermission = async function (this: unknown, descriptor: unknown) {
          return (sessionStorage.getItem('e2e:permission') as PermissionState | null) ?? query.call(this, descriptor);
        };
        proto.requestPermission = async function () {
          sessionStorage.removeItem('e2e:permission');
          return 'granted';
        };
      },
      { theme },
    );
    try {
      await provide(context);
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  app: async ({ folderContext }, provide) => {
    await provide(folderContext.pages()[0] ?? (await folderContext.newPage()));
  },
});

test.skip(process.env.NEBULA_E2E_BUILT === '1', 'runs on the dev server');
test.skip(({ browserName }) => browserName !== 'chromium', 'the folder tier is Chromium only');

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.ws-root').waitFor({ timeout: 30_000 });
  await page.locator('#loader').waitFor({ state: 'detached', timeout: 10_000 });
}

async function closeWelcome(page: Page): Promise<void> {
  const welcome = page.locator('dialog.ws-welcome');
  await welcome.getByRole('button', { name: 'Explore the sample' }).click();
  await expect(welcome).toHaveCount(0);
}

/** Writes a file into a picked folder the way another app would: straight
 * to disk, with no lock and no word to Nebula. */
async function writeOutside(page: Page, folder: string, path: string, text: string): Promise<void> {
  await page.evaluate(
    async ({ folder, path, text }) => {
      let dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-picked', { create: true })).getDirectoryHandle(folder, { create: true });
      const parts = path.split('/');
      for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
      const writable = await (await dir.getFileHandle(parts[parts.length - 1], { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    },
    { folder, path, text },
  );
}

/** What's in a picked folder, read from disk. */
async function onDisk(page: Page, folder: string): Promise<string[]> {
  return page.evaluate(async (folder) => {
    const start = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-picked', { create: true })).getDirectoryHandle(folder, { create: true });
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
      const found: string[] = [];
      for await (const [name, handle] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'file') found.push(path);
        else found.push(...(await walk(handle as FileSystemDirectoryHandle, path)));
      }
      return found;
    };
    return (await walk(start, '')).sort();
  }, folder);
}

const row = (page: Page, path: string) => page.locator(`.ws-filetree [role="treeitem"][data-path="${path}"]`);
const title = (page: Page) => page.locator('.ws-switcher .page-sidebar-title');
const phone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 600;

/** The project menu, through the files sheet on a phone. */
async function projectMenu(page: Page) {
  if (phone(page)) await page.locator('.ws-phone-bar').getByRole('button', { name: 'Files' }).click();
  await page.locator('.ws-switcher').click();
  const menu = page.getByRole('menu', { name: 'Projects' });
  await expect(menu).toBeVisible();
  return menu;
}

async function newFolderProject(page: Page, name: string, shot?: string): Promise<void> {
  const menu = await projectMenu(page);
  await menu.getByRole('menuitem', { name: 'New project' }).click();
  const dialog = page.locator('dialog.ws-np');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'In a folder on this computer' }).click();
  await dialog.getByLabel('Name').fill(name);
  await expect(dialog).toContainText('You’ll choose the folder next.');
  if (shot) await render(page, shot);
  await dialog.getByRole('button', { name: 'Choose folder…' }).click();
  await expect(title(page)).toHaveText(name);
}

async function render(page: Page, name: string): Promise<void> {
  if (!shots) return;
  mkdirSync(shots, { recursive: true });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, `${name}.png`), animations: 'disabled', caret: 'hide' });
}

test('a picked folder opens as a project: its files as they are, edits on disk, other apps’ changes shown, and again after a reload', async ({ app: page }) => {
  test.setTimeout(120_000);
  await open(page);
  await closeWelcome(page);
  await writeOutside(page, 'Notes', 'Ideas.md', '# Ideas');
  await writeOutside(page, 'Notes', 'Trips/Iceland.md', 'north');

  await newFolderProject(page, 'Notes');
  await expect(row(page, 'Ideas.md')).toBeVisible();
  await expect(row(page, 'Trips')).toBeVisible();
  const footer = page.locator('.ws-rail-footer');
  await expect(footer.locator('.page-sidebar-footer-name')).toHaveText('Notes');
  await expect(footer.locator('.page-sidebar-footer-meta')).toHaveText('On this computer');
  await expect(footer.locator('.ws-store-dot')).not.toHaveAttribute('data-attention', '');

  // An edit lands on disk: a new note, named, is a file in the folder.
  await page.locator('.ws-rail').getByRole('button', { name: 'New note' }).first().click();
  await expect.poll(() => onDisk(page, 'Notes')).toContain('Untitled.md');
  await page.keyboard.press('Escape');
  await expect.poll(() => onDisk(page, 'Notes')).toEqual(expect.arrayContaining(['.nebula/project.json', 'Ideas.md', 'Trips/Iceland.md', 'Untitled.md']));

  // Another app adds a file and deletes one: the tree follows.
  await writeOutside(page, 'Notes', 'From another app.md', 'hello');
  await expect(row(page, 'From another app.md')).toBeVisible({ timeout: 10_000 });
  await page.evaluate(async () => {
    const folder = await (await (await navigator.storage.getDirectory()).getDirectoryHandle('e2e-picked')).getDirectoryHandle('Notes');
    await folder.removeEntry('Trips', { recursive: true });
  });
  await expect(row(page, 'Trips')).toHaveCount(0, { timeout: 10_000 });

  // The same project after a reload, opened at once.
  await page.reload();
  await page.locator('.ws-root').waitFor();
  await expect(title(page)).toHaveText('Notes');
  await expect(row(page, 'From another app.md')).toBeVisible();

  // The browser forgot the permission: one click brings the folder back.
  await page.evaluate(() => sessionStorage.setItem('e2e:permission', 'prompt'));
  await page.reload();
  const bar = page.locator('.ws-folder-bar');
  await expect(bar).toContainText('Nebula needs your OK to open the folder ‘Notes’ again.');
  await expect(row(page, 'Ideas.md')).toHaveCount(0);
  await bar.getByRole('button', { name: 'Open the folder' }).click();
  await expect(row(page, 'Ideas.md')).toBeVisible();
  await expect(bar).toHaveCount(0);

  // Opening the same folder again is the same project, not a second one.
  const menu = await projectMenu(page);
  await menu.getByRole('menuitem', { name: 'Open a folder…' }).click();
  await expect(title(page)).toHaveText('Notes');
  const menuAgain = await projectMenu(page);
  await expect(menuAgain.locator('[data-project]')).toHaveCount(2);
  await expect(menuAgain.locator('[data-project]', { hasText: 'Notes' })).toContainText('On this computer');
  await expect(menuAgain.locator('[data-project]', { hasText: 'Night Sky' })).toContainText('In this browser');
});

test('Move to a folder… moves a browser project, checked, into an empty folder on this computer', async ({ app: page }) => {
  test.setTimeout(120_000);
  await open(page);
  await closeWelcome(page);
  await expect(title(page)).toHaveText('Night Sky');
  const before = await page.evaluate(async () => {
    const tree = await (await navigator.storage.getDirectory()).getDirectoryHandle('nebula');
    const registry = await navigator.locks.request('nebula:file:registry.json', { mode: 'shared' }, async () =>
      JSON.parse(await (await (await tree.getFileHandle('registry.json')).getFile()).text()),
    );
    return registry.projects as Array<{ id: string; dir: string; tier: string }>;
  });
  expect(before).toHaveLength(1);

  await page.evaluate(() => sessionStorage.setItem('e2e:pick', 'Night Sky folder'));
  await page.locator('.ws-rail').getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('dialog', { name: 'Settings' });
  await settings.getByRole('tab', { name: 'Project' }).click();
  await expect(settings).toContainText('Move to a folder… copies its files into an empty folder on this computer, checks each one, and only then deletes the copy in this browser.');
  await render(page, 'move-settings-1440-night');
  await settings.getByRole('button', { name: 'Move to a folder…' }).click();
  await expect(settings).toContainText('In the folder ‘Night Sky folder’, on this computer', { timeout: 20_000 });
  await page.keyboard.press('Escape');

  const folder = await onDisk(page, 'Night Sky folder');
  expect(folder).toEqual(expect.arrayContaining(['.nebula/project.json', 'Guides/Observing plan.md']));
  const after = await page.evaluate(async (dir) => {
    const tree = await (await navigator.storage.getDirectory()).getDirectoryHandle('nebula');
    const registry = await navigator.locks.request('nebula:file:registry.json', { mode: 'shared' }, async () =>
      JSON.parse(await (await (await tree.getFileHandle('registry.json')).getFile()).text()),
    );
    const projects = await tree.getDirectoryHandle('projects');
    const left = await projects.getDirectoryHandle(dir).then(
      () => true,
      () => false,
    );
    return { projects: registry.projects as Array<{ id: string; tier: string }>, left };
  }, before[0].dir);
  expect(after.projects).toEqual([expect.objectContaining({ id: before[0].id, tier: 'folder' })]);
  expect(after.left).toBe(false);
  await expect(row(page, 'Guides')).toBeVisible();
  await expect(page.locator('.ws-status')).toContainText('Saved on this computer');
});

for (const theme of ['dark', 'light'] as const) {
  for (const screen of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const tag = `${screen.width}-${theme === 'dark' ? 'night' : 'day'}`;
    test.describe(`renders, ${tag}`, () => {
      test.use({ theme, screen });
      test.skip(!shots, 'set NEBULA_FOLDER_SHOTS to a folder for the renders');

      test(`New project, the rail, Settings, Help and the permission bar (${tag})`, async ({ app: page }) => {
        test.setTimeout(120_000);
        await open(page);
        await closeWelcome(page);
        await writeOutside(page, 'Notes', 'Ideas.md', '# Ideas');
        await writeOutside(page, 'Notes', 'Trips/Iceland.md', 'north');
        await newFolderProject(page, 'Notes', `new-project-${tag}`);
        await expect(row(page, 'Ideas.md')).toHaveCount(1);
        await page.waitForTimeout(300);

        // The rail with its status; on a phone, in the files sheet.
        if (phone(page)) await page.locator('.ws-phone-bar').getByRole('button', { name: 'Files' }).click();
        await expect(page.locator('.ws-rail-footer .page-sidebar-footer-meta')).toHaveText('On this computer');
        await render(page, `rail-${tag}`);

        await page.locator('.ws-rail-where').click();
        const settings = page.getByRole('dialog', { name: 'Settings' });
        await expect(settings).toContainText('In the folder ‘Notes’, on this computer');
        await settings.getByText('Files', { exact: true }).scrollIntoViewIfNeeded();
        await render(page, `settings-${tag}`);
        await page.keyboard.press('Escape');

        if (phone(page)) {
          await page.locator('.ws-phone-bar').getByRole('button', { name: 'Files' }).click();
        }
        await page.locator('.ws-rail').getByRole('button', { name: 'Help' }).click();
        const help = page.locator('dialog.ws-help');
        const line = help.getByText('This browser can also keep a project in a folder on your computer', { exact: false });
        await expect(line).toBeVisible();
        await line.scrollIntoViewIfNeeded();
        await render(page, `help-${tag}`);
        await page.keyboard.press('Escape');

        await page.evaluate(() => sessionStorage.setItem('e2e:permission', 'prompt'));
        await page.reload();
        await expect(page.locator('.ws-folder-bar')).toContainText('Nebula needs your OK to open the folder ‘Notes’ again.');
        await render(page, `permission-${tag}`);

        await page.evaluate(() => sessionStorage.setItem('e2e:permission', 'denied'));
        await page.reload();
        await expect(page.locator('.ws-folder-bar')).toContainText('Nebula isn’t allowed to open the folder ‘Notes’.');
        await render(page, `denied-${tag}`);
      });
    });
  }
}
