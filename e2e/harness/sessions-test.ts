/**
 * The sessions lane's Playwright fixtures and helpers (e2e/sessions-*.spec.ts):
 * the workspace with its real views over the real OPFS registry
 * (e2e/harness/sessions.html).
 *
 * WebKit keeps OPFS only in a persistent context, so every test gets a fresh persistent profile in both browsers; a
 * second page in the same context is another tab of the same browser.
 */
import { test as base, expect, type Page } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export { expect };
export { BROKEN_TEXT, CRLF_TEXT, PATHS, PROJECT_ID } from './sessions-paths';

export const test = base.extend({
  context: async ({ playwright, browserName, baseURL, viewport }, provide) => {
    const dir = mkdtempSync(join(tmpdir(), `nebula-sessions-${browserName}-`));
    const context = await playwright[browserName].launchPersistentContext(dir, {
      baseURL,
      viewport: viewport ?? { width: 1440, height: 900 },
      acceptDownloads: true,
    });
    try {
      await provide(context);
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },
  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },
});

type Scene = { ids: string[]; appState: Record<string, unknown> };
type Call = { op: string; path: string; to?: string; at: number };

declare global {
  interface Window {
    __sessionsReady?: boolean;
    __sessions: {
      calls: Call[];
      writes(path: string): number;
      lists(): number;
      read(path: string): Promise<string | null>;
      bytes(path: string): Promise<number[] | null>;
      paths(): Promise<string[]>;
      write(path: string, text: string): Promise<void>;
      scene(path: string): Promise<Scene | null>;
    };
  }
}

/** Opens the harness; returns the page errors seen from now on. */
export async function openSessions(page: Page, query = ''): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    if (!localStorage.getItem('nebula:theme')) localStorage.setItem('nebula:theme', 'dark');
  });
  await page.goto(`/e2e/harness/sessions.html${query ? `?${query}` : ''}`);
  await page.waitForFunction(() => window.__sessionsReady === true);
  await page.locator('.ws-filetree [role="treeitem"]').first().waitFor({ state: 'attached' });
  return errors;
}

export function row(page: Page, path: string) {
  return page.locator(`.ws-filetree [role="treeitem"][data-path="${path}"]`);
}

/** Opens a file from the tree, unfolding its folders first. */
export async function openPath(page: Page, path: string) {
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const folder = row(page, parts.slice(0, depth).join('/'));
    if ((await folder.getAttribute('aria-expanded')) === 'false') await folder.locator('.page-sidebar-nav-label').click();
  }
  await row(page, path).locator('.page-sidebar-nav-label').click();
  await expect(page.getByRole('tab', { selected: true })).toHaveText(tabTitle(path));
}

function tabTitle(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.replace(/\.excalidraw\.md$|\.md$/i, '');
}

/** Renames a tree row with F2. */
export async function renameRow(page: Page, path: string, name: string) {
  await row(page, path).focus();
  await page.keyboard.press('F2');
  const current = path.slice(path.lastIndexOf('/') + 1);
  await page.getByRole('textbox', { name: `Rename ${current}` }).fill(name);
  await page.keyboard.press('Enter');
}

export const files = {
  read: (page: Page, path: string) => page.evaluate((target) => window.__sessions.read(target), path),
  bytes: (page: Page, path: string) => page.evaluate((target) => window.__sessions.bytes(target), path),
  paths: (page: Page) => page.evaluate(() => window.__sessions.paths()),
  write: (page: Page, path: string, text: string) => page.evaluate(([target, value]) => window.__sessions.write(target, value), [path, text] as const),
  scene: (page: Page, path: string) => page.evaluate((target) => window.__sessions.scene(target), path),
  writes: (page: Page, path: string) => page.evaluate((target) => window.__sessions.writes(target), path),
  lists: (page: Page) => page.evaluate(() => window.__sessions.lists()),
};

/** Turns a note to its source (the Edit button) and puts the caret at the end. */
export async function editNote(page: Page) {
  await page.locator('.ws-page-tools').getByRole('button', { name: 'Edit' }).click();
  const editor = page.locator('.ws-note .cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('ControlOrMeta+End');
}

/** Draws a rectangle with Excalidraw's own tool, by mouse. */
export async function drawRectangle(page: Page, at: { x: number; y: number }) {
  const canvas = page.locator('.ws-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible({ timeout: 30_000 });
  const box = (await canvas.boundingBox())!;
  await page.locator('.ws-canvas label:has([data-testid="toolbar-rectangle"])').click();
  await expect(page.locator('.ws-canvas').getByTestId('toolbar-rectangle')).toBeChecked();
  const x = box.x + box.width * at.x;
  const y = box.y + box.height * at.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 50, y + 30, { steps: 4 });
  await page.mouse.move(x + 110, y + 70, { steps: 6 });
  await page.mouse.up();
}

/** The canvas's element count, from the status line ('3 elements · 100%'). */
export async function shownElements(page: Page): Promise<number> {
  const status = page.locator('.ws-status');
  await expect(status).toContainText(/\d+ elements?/, { timeout: 30_000 });
  return parseInt(/(\d+) elements?/.exec((await status.textContent()) ?? '')![1], 10);
}

/** Saves a screenshot under $TMPDIR/sessions-shots and returns its path. */
export async function shoot(page: Page, name: string): Promise<string> {
  const path = join(process.env.TMPDIR || tmpdir(), 'sessions-shots', `${name}.png`);
  await page.screenshot({ path });
  return path;
}
