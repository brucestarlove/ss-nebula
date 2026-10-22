/**
 * The integration suite's fixtures (e2e/app-*.spec.ts): the production build
 * of the whole app, each test in a browser profile of its own.
 *
 * WebKit keeps OPFS only in a persistent context (docs/slice-3.md, decision
 * 8), so every test gets a fresh persistent context in both browsers, which
 * is also what a first visit is. `test.use({ ephemeral: true })` gives the
 * default, ephemeral context instead: in WebKit that is a browser that keeps
 * nothing.
 *
 * Every test runs under the site's Content-Security-Policy (serve-site.mjs
 * sends vercel.json's headers), and fails if the policy blocked anything or a
 * request left the origin (review finding 20).
 */
import { test as base, expect, type BrowserContext, type BrowserContextOptions, type Page } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const port = Number(process.env.NEBULA_E2E_PORT || 4340);
export const baseURL = `http://127.0.0.1:${port}`;
export const built = process.env.NEBULA_E2E_BUILT === '1';
/** NEBULA_E2E_FIXME=1 runs the tests marked fixme for a bug in another lane's
 * code (docs/lanes/integration-findings.md), to see whether it still fails. */
export const runFixme = process.env.NEBULA_E2E_FIXME === '1';

type Options = {
  /** Extra options for the test's browser context (viewport, colour scheme…). */
  appContext: BrowserContextOptions;
  /** The default ephemeral context instead of a persistent profile. */
  ephemeral: boolean;
  /** A browser channel: 'chromium' is the full browser, with its PDF viewer
   * (Playwright's default headless shell has none). */
  browserChannel: string | undefined;
  /** Origins a test may reach on the user's say-so (a web image in a note,
   * after Load images); every other request must stay on this site. */
  allowOrigins: string[];
};

export const test = base.extend<Options>({
  appContext: [{}, { option: true }],
  ephemeral: [false, { option: true }],
  browserChannel: [undefined, { option: true }],
  allowOrigins: [[], { option: true }],

  context: async ({ playwright, browserName, appContext, ephemeral, browserChannel: channel, allowOrigins }, provide) => {
    const options: BrowserContextOptions = { baseURL, viewport: { width: 1440, height: 900 }, acceptDownloads: true, ...appContext };
    const run = async (context: BrowserContext) => {
      const guard = await guardContext(context, allowOrigins);
      await provide(context);
      expect(guard.violations, 'blocked by the Content-Security-Policy').toEqual([]);
      expect(guard.offOrigin, 'requests that left the origin').toEqual([]);
    };
    if (ephemeral) {
      const browser = await playwright[browserName].launch({ channel: browserName === 'chromium' ? channel : undefined });
      const context = await browser.newContext(options);
      try {
        await run(context);
      } finally {
        await context.close();
        await browser.close();
      }
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), `nebula-app-${browserName}-`));
    const context = await playwright[browserName].launchPersistentContext(dir, { ...options, channel: browserName === 'chromium' ? channel : undefined });
    try {
      await run(context);
    } finally {
      await context.close();
      rmSync(dir, { recursive: true, force: true });
    }
  },

  page: async ({ context }, provide) => {
    await provide(context.pages()[0] ?? (await context.newPage()));
  },
});

test.beforeEach(() => {
  test.skip(!built, 'The app suite runs on the production build: NEBULA_E2E_BUILT=1 (pnpm run build:site first).');
});

export { expect };

/** Records what the page's Content-Security-Policy blocks, in every frame
 * and across navigations, and every request that leaves the origin. */
async function guardContext(context: BrowserContext, allowOrigins: string[] = []) {
  const violations: string[] = [];
  const offOrigin: string[] = [];
  await context.exposeBinding('__nebulaCspViolation', (_source, text: string) => {
    violations.push(text);
  });
  await context.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (event) => {
      const report = (window as unknown as { __nebulaCspViolation?: (text: string) => void }).__nebulaCspViolation;
      report?.(`${event.effectiveDirective} blocked ${event.blockedURI || 'inline'} at ${event.sourceFile || location.href}:${event.lineNumber} ${event.sample}`.trim());
    });
  });
  context.on('console', (message) => {
    if (/Content[- ]Security[- ]Policy/i.test(message.text())) violations.push(`console: ${message.text()}`);
  });
  context.on('request', (request) => {
    const url = request.url();
    // data:, blob: and about: never leave the page; chrome: and
    // chrome-extension: are Chromium's own PDF viewer, inside the browser.
    if (/^(data|blob|about|chrome|chrome-extension):/.test(url)) return;
    const { origin } = new URL(url);
    if (origin !== baseURL && !allowOrigins.includes(origin)) offOrigin.push(`${request.resourceType()} ${url}`);
  });
  return { violations, offOrigin };
}

/* ---- driving the app ------------------------------------------------------ */

/** Opens a page of the app and waits for the workspace, with the boot splash gone. */
export async function openApp(page: Page, path = '/'): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const response = await page.goto(path);
  // The suite runs under the policy the site sends (vercel.json via serve-site.mjs).
  expect(response?.headers()['content-security-policy']).toMatch(/^default-src 'self'/);
  await page.locator('.ws-root').waitFor({ timeout: 30_000 });
  await page.locator('#loader').waitFor({ state: 'detached', timeout: 10_000 });
  return errors;
}

/** Leaves the welcome (or the note about moved canvases) by its main button. */
export async function closeIntro(page: Page, button: 'Explore the sample' | 'Got it' = 'Explore the sample') {
  const dialog = page.locator('dialog.ws-welcome');
  await dialog.getByRole('button', { name: button }).click();
  await expect(dialog).toHaveCount(0);
}

/** A row of the file tree, by path. */
export function row(page: Page, path: string) {
  return page.locator(`.ws-filetree [role="treeitem"][data-path="${path.replace(/"/g, '\\"')}"]`);
}

export function switcherTitle(page: Page) {
  return page.locator('.ws-switcher .page-sidebar-title');
}

/** The open file's path, from the address (/p/<project>/<path>). */
export function addressPath(page: Page): { projectId: string; path: string | null } | null {
  const url = new URL(page.url());
  if (!url.pathname.startsWith('/p/')) return null;
  const [project, ...rest] = url.pathname.slice(3).split('/');
  return { projectId: decodeURIComponent(project), path: rest.length ? rest.map(decodeURIComponent).join('/') : null };
}

/* ---- reading what the browser keeps -------------------------------------- */

export type StoredProject = { id: string; dir: string; name: string; color: string; files: string[] };

/** The projects in OPFS, read straight from the tree Nebula keeps there
 * (nebula/registry.json and nebula/projects/<dir>/), not through the app. */
export async function storedProjects(page: Page): Promise<StoredProject[]> {
  return page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const tree = await root.getDirectoryHandle('nebula');
    const registry = JSON.parse(await (await (await tree.getFileHandle('registry.json')).getFile()).text()) as { projects: { id: string; dir: string }[] };
    const projectsDir = await tree.getDirectoryHandle('projects');
    const walk = async (dir: FileSystemDirectoryHandle, prefix: string): Promise<string[]> => {
      const found: string[] = [];
      const entries = (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries();
      for await (const [name, handle] of entries) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (handle.kind === 'file') found.push(path);
        else found.push(...(await walk(handle as FileSystemDirectoryHandle, path)));
      }
      return found;
    };
    const result = [];
    for (const entry of registry.projects) {
      const dir = await projectsDir.getDirectoryHandle(entry.dir);
      const meta = JSON.parse(await (await (await (await dir.getDirectoryHandle('.nebula')).getFileHandle('project.json')).getFile()).text());
      result.push({ id: entry.id, dir: entry.dir, name: meta.name, color: meta.color, files: (await walk(dir, '')).sort() });
    }
    return result;
  });
}

/** A project file's text, read from OPFS. */
export async function storedText(page: Page, projectId: string, path: string): Promise<string | null> {
  return page.evaluate(
    async ({ projectId, path }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const tree = await root.getDirectoryHandle('nebula');
        const registry = JSON.parse(await (await (await tree.getFileHandle('registry.json')).getFile()).text()) as { projects: { id: string; dir: string }[] };
        const entry = registry.projects.find((project) => project.id === projectId);
        if (!entry) return null;
        let dir = await (await tree.getDirectoryHandle('projects')).getDirectoryHandle(entry.dir);
        const parts = path.split('/');
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
        return await (await (await dir.getFileHandle(parts.at(-1)!)).getFile()).text();
      } catch {
        return null;
      }
    },
    { projectId, path },
  );
}

/** Every localStorage key and value. */
export async function localStorageSnapshot(page: Page): Promise<Record<string, string>> {
  return page.evaluate(() => {
    const all: Record<string, string> = {};
    for (let index = 0; index < localStorage.length; index += 1) {
      const key = localStorage.key(index)!;
      all[key] = localStorage.getItem(key)!;
    }
    return all;
  });
}

/** Makes the origin private file system fail the way a private window's
 * does, so Nebula runs on memory and keeps nothing. */
export async function failOpfs(context: BrowserContext) {
  await context.addInitScript(() => {
    Object.defineProperty(StorageManager.prototype, 'getDirectory', {
      configurable: true,
      value: () => Promise.reject(new DOMException('The operation failed for an unknown transient reason', 'UnknownError')),
    });
  });
}

/** Seeds localStorage before the first load, once per profile. */
export async function seedLocalStorage(context: BrowserContext, items: Record<string, string>) {
  await context.addInitScript((seed) => {
    if (localStorage.getItem('e2e:seeded')) return;
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    localStorage.setItem('e2e:seeded', '1');
  }, items);
}

/* ---- Nebula 1.x canvases, as LocalStorageSceneStore saved them ----------- */

type Element = Record<string, unknown> & { id: string };
type Scene = { type: 'excalidraw'; version: number; source: string; elements: Element[]; appState: Record<string, unknown>; files: Record<string, unknown> };

const hexagon = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'sketches', 'workspace', 'assets', 'winter-hexagon.excalidraw'), 'utf8')) as Scene;

// A 16×16 PNG (a night gradient with a star): an embedded image, as
// Excalidraw keeps one in the scene.
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAIAAACQkWg2AAACdklEQVR42kXLIaukQAAAYH/EJIMIghhmypQxiCCIQcuUMQzyhEEezoYJGwwGg8FgMBgMBoPBYDAYDBs2bFiOF164X3L50oULD776acDguvFhGsI2PqFxw4ZyjbtvVKFRx0ZDjTY1uszohTGUxqiMSQPWh24J0/q0rRu0FLburlX5Vh1aTWy11OpSq8+sQVhjaU3KmjXgCN35NJ2b7Sjo3LFTuU7tO03otLHTUadPnSFzRuFMpTMrZ9EA+tTRzUTKRneIKoxqFzU+akPUxainaEjRmKFJoLlEi0KrBvBNx8rEdxtXENcYNy5ufdyFuI/xQPGY4inDs8BLiVeFNw0QpZO7SSqb1JA0mLQu6XzSh2SIyUjJlJI5I4sga0k2RXYNeHfdq0yvtr0Gei32OtfrfW8IvTH2JurNqbdk3iq8rfR25R0aCCo9qM2gsYMWBh0OejcY/v759R8NljRYs2ATwV4GhwpODUS1HjVm1NpRB6MeR4MbjT8hWtNoy6JdREcZnSq6NJA0etKaSWcnPUwGnIxuMv2EZEuTPUsOkZxlcqnkoQHa6rQzaW/TAdIR08mls0+XkK4x3SjdU3pk9BT0KulD0acGWKez3mSDzUbIJsxmly0+W0O2xWyn7EjZmbFLsEfJnoq9NMB7nQ8mH20+QT5jvrh89fkW8j3mB+Vnyq+MPwR/lvyl+FsD+aDno5lPdj7DfMH56uabn+9hfsT5SfMrzR9Z/hT5q8zfKv/SQDHqxWQWs10ssFhxsbnF7hdHWJxxcdHikRbPrHiJ4l0WX6r41oCcdDmbcrHlCuWG5e7Kw5dnKK9YPqh8pvKVybeQX6X8VvL3P1J5KI7vCHlaAAAAAElFTkSuQmCC';

function imageScene(id: string): Scene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'https://nebula.starscape.app',
    elements: [
      {
        id: `${id}-img`,
        type: 'image',
        x: 40,
        y: 60,
        width: 160,
        height: 160,
        angle: 0,
        strokeColor: 'transparent',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        fileId: `${id}-file`,
        status: 'saved',
        scale: [1, 1],
        crop: null,
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: null,
        link: null,
        locked: false,
        seed: 1,
        version: 3,
        versionNonce: 7,
        isDeleted: false,
        updated: 1761100000000,
        index: 'a0',
      },
      {
        id: `${id}-label`,
        type: 'text',
        x: 40,
        y: 240,
        width: 180,
        height: 25,
        angle: 0,
        strokeColor: '#1e1e1e',
        backgroundColor: 'transparent',
        fillStyle: 'solid',
        strokeWidth: 2,
        strokeStyle: 'solid',
        roughness: 1,
        opacity: 100,
        groupIds: [],
        frameId: null,
        roundness: null,
        boundElements: null,
        link: null,
        locked: false,
        seed: 2,
        version: 2,
        versionNonce: 9,
        isDeleted: false,
        updated: 1761100000000,
        text: 'The Pleiades',
        fontSize: 20,
        fontFamily: 5,
        textAlign: 'left',
        verticalAlign: 'top',
        containerId: null,
        originalText: 'The Pleiades',
        autoResize: true,
        lineHeight: 1.25,
        index: 'a1',
      },
    ],
    appState: { viewBackgroundColor: 'transparent', theme: 'dark', zoom: { value: 1 } },
    files: { [`${id}-file`]: { mimeType: 'image/png', id: `${id}-file`, dataURL: PNG, created: 1761100000000, lastRetrieved: 1761100000500 } },
  };
}

const EMPTY_METADATA = { ticketLinks: [], missionFrames: [], artifactRefs: [], semanticIndex: {} };

function legacyDocument(boardId: string, canvasId: string, name: string, scene: Scene, nebula: unknown = EMPTY_METADATA) {
  return { type: 'starscape.nebula.excalidraw', version: 1, boardId, canvasId, name, updatedAt: '2026-09-25T18:00:00.000Z', scene, nebula };
}

function legacyKey(boardId: string, canvasId: string) {
  return `nebula:excalidraw:${encodeURIComponent(boardId)}:${encodeURIComponent(canvasId)}`;
}

export type LegacyCanvas = { key: string; boardId: string; canvasId: string; name: string; file: string; elementIds: string[] };

/** Two boards as Nebula 1.x left them: the default board with the sketch's
 * Winter hexagon and a canvas holding an embedded image plus Orbit metadata,
 * and a board whose id can't be a project id. Plus a library and the theme. */
export function legacyFixtures(): { storage: Record<string, string>; canvases: LegacyCanvas[] } {
  const entries: Array<[LegacyCanvas, unknown]> = [];
  const add = (boardId: string, canvasId: string, name: string, file: string, scene: Scene, nebula?: unknown) => {
    const key = legacyKey(boardId, canvasId);
    entries.push([{ key, boardId, canvasId, name, file, elementIds: scene.elements.filter((element) => !element.isDeleted).map((element) => element.id) }, legacyDocument(boardId, canvasId, name, scene, nebula)]);
  };
  add('ss-nebula', 'main', 'Winter hexagon', 'Winter hexagon.excalidraw.md', hexagon);
  add('ss-nebula', 'pleiades', 'The Pleiades', 'The Pleiades.excalidraw.md', imageScene('pleiades'), {
    ...EMPTY_METADATA,
    ticketLinks: [{ ticketId: 'ORB-12', elementIds: ['pleiades-img'], label: 'Launch' }],
  });
  add('board/a', 'canvas b', 'Plan: phase 1/2', 'Plan- phase 1-2.excalidraw.md', imageScene('plan'));
  const storage: Record<string, string> = Object.fromEntries(entries.map(([canvas, document]) => [canvas.key, JSON.stringify(document)]));
  storage['nebula:excalidraw-libraries:ss-nebula'] = JSON.stringify({ collections: [], activeId: 'personal' });
  storage['nebula:theme'] = 'dark';
  return { storage, canvases: entries.map(([canvas]) => canvas) };
}

/* ---- files and views ------------------------------------------------------ */

/** The open project's id, from the address. */
export function currentProjectId(page: Page): string {
  const address = addressPath(page);
  if (!address) throw new Error(`no project in the address: ${page.url()}`);
  return address.projectId;
}

/** Opens a file from the tree, unfolding its folders first. */
export async function openFromTree(page: Page, path: string) {
  const parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth += 1) {
    const folder = row(page, parts.slice(0, depth).join('/'));
    if ((await folder.getAttribute('aria-expanded')) === 'false') await folder.locator('.page-sidebar-nav-label').first().click();
    await expect(folder).toHaveAttribute('aria-expanded', 'true');
  }
  await row(page, path).locator('.page-sidebar-nav-label').first().click();
  await expect(row(page, path)).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => addressPath(page)?.path).toBe(path);
}

/** Uploads files with the FILES section's button. */
export async function uploadFiles(page: Page, files: Array<{ name: string; mimeType: string; buffer: Buffer }>) {
  const chooser = page.waitForEvent('filechooser');
  await page.locator('.ws-section-actions').getByRole('button', { name: 'Upload files' }).click();
  await (await chooser).setFiles(files);
  for (const file of files) await expect(row(page, file.name)).toBeVisible();
}

/** Waits until the status line says the open file is saved. */
export async function saved(page: Page) {
  await expect(page.locator('.ws-status')).toContainText('Saved in this browser', { timeout: 10_000 });
}

/** The element count the canvas tab reports in the status line. */
export async function elementCount(page: Page): Promise<number> {
  const status = page.locator('.ws-status');
  await expect(status).toContainText(/\d+ elements? · \d+%/, { timeout: 30_000 });
  return Number(/(\d+) elements? · /.exec((await status.textContent()) ?? '')![1]);
}

/** What the open canvas holds, read from Excalidraw itself (its App
 * component, through React's fiber on the canvas container). */
export async function liveScene(page: Page): Promise<{ ids: string[]; files: string[] }> {
  return page.locator('.ws-canvas .excalidraw').first().evaluate((host) => {
    const key = Object.keys(host).find((name) => name.startsWith('__reactFiber$'));
    type Fiber = { stateNode?: { scene?: { getNonDeletedElements(): Array<{ id: string }> }; files?: Record<string, unknown> }; return?: Fiber };
    let fiber = key ? ((host as unknown as Record<string, Fiber>)[key] as Fiber | undefined) : undefined;
    while (fiber && typeof fiber.stateNode?.scene?.getNonDeletedElements !== 'function') fiber = fiber.return;
    if (!fiber?.stateNode?.scene) throw new Error('Excalidraw’s App component was not found');
    return { ids: fiber.stateNode.scene.getNonDeletedElements().map((element) => element.id), files: Object.keys(fiber.stateNode.files ?? {}) };
  });
}

/** Draws a rectangle with Excalidraw's own tool, by mouse. */
export async function drawRectangle(page: Page, at: { x: number; y: number } = { x: 0.5, y: 0.5 }) {
  const canvas = page.locator('.ws-canvas .excalidraw canvas.interactive');
  await expect(canvas).toBeVisible();
  const box = (await canvas.boundingBox())!;
  await page.locator('.ws-canvas label:has([data-testid="toolbar-rectangle"])').click();
  await expect(page.locator('.ws-canvas').getByTestId('toolbar-rectangle')).toBeChecked();
  const x = box.x + box.width * at.x;
  const y = box.y + box.height * at.y;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 60, y + 40, { steps: 4 });
  await page.mouse.move(x + 140, y + 90, { steps: 6 });
  await page.mouse.up();
}

/** A one-second 8 kHz WAV of a quiet tone. */
export function wavFile(): Buffer {
  const rate = 8000;
  const samples = rate;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1) buffer.writeInt16LE(Math.round(Math.sin((index / rate) * 2 * Math.PI * 440) * 3000), 44 + index * 2);
  return buffer;
}

/** A 16×16 PNG: a night gradient with a star. */
export function pngFile(): Buffer {
  return Buffer.from(PNG.slice(PNG.indexOf(',') + 1), 'base64');
}

/** The lane harness's short video clips (e2e/harness/views-media). */
export function videoFile(extension: 'webm' | 'mp4'): Buffer {
  return readFileSync(join(import.meta.dirname, 'harness', 'views-media', `moonrise.${extension}`));
}

/** Decodes the scene a `.excalidraw.md` file holds (Obsidian's compressed-json block). */
export async function decodeCanvasFile(text: string): Promise<{ elements: Array<{ id: string; isDeleted?: boolean; type: string }>; files: Record<string, unknown> }> {
  const { default: LZString } = await import('lz-string');
  const match = /```compressed-json\n([\s\S]*?)\n```/.exec(text);
  if (!match) {
    const json = /```json\n([\s\S]*?)\n```/.exec(text);
    if (!json) throw new Error('no drawing in the file');
    return JSON.parse(json[1]);
  }
  return JSON.parse(LZString.decompressFromBase64(match[1].replace(/\s+/g, '')) ?? 'null');
}
