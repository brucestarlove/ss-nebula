import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Page, TestInfo } from '@playwright/test';
import { closeIntro, expect, openApp, test } from './app-fixtures';

// The load budget (docs/slice-3.md, Integration; PLAN §10): the first load of
// / carries the workspace only. Excalidraw, CodeMirror, react-markdown, the
// migration and the sample each arrive in a chunk of their own, and only when
// the visit needs them. Measured on the production build from the network:
// every JavaScript response and its bytes, classified by the modules the
// build put in each chunk (dist/site-chunks.json, written by vite.config.ts's
// chunk report).

type Chunk = { isEntry: boolean; isDynamicEntry: boolean; imports: string[]; dynamicImports: string[]; modules: Record<string, number> };

const ROOT = join(import.meta.dirname, '..');
const HEAVY: Record<string, RegExp> = {
  Excalidraw: /(^|\/)node_modules\/@excalidraw\//,
  CodeMirror: /(^|\/)node_modules\/(@codemirror|codemirror|@lezer)\//,
  'react-markdown': /(^|\/)node_modules\/(react-markdown|remark-[\w-]+|micromark[\w-]*|unified)\//,
  migration: /^src\/files\/migration\.ts$/,
  sample: /^src\/files\/sample(\.ts$|\/)/,
};

function readReport(): Record<string, Chunk> {
  return (JSON.parse(readFileSync(join(ROOT, 'dist', 'site-chunks.json'), 'utf8')) as { chunks: Record<string, Chunk> }).chunks;
}

/** What a chunk carries of the heavy parts. A stylesheet import shows up as
 * a module that renders no code (style.ts imports Excalidraw's CSS): CSS is
 * not JavaScript, and isn't counted here. */
function heavyIn(chunk: Chunk | undefined): string[] {
  if (!chunk) return [];
  const modules = Object.entries(chunk.modules)
    .filter(([id, length]) => length > 0 && !/\.css($|\?)/.test(id))
    .map(([id]) => id);
  return Object.entries(HEAVY)
    .filter(([, pattern]) => modules.some((id) => pattern.test(id)))
    .map(([name]) => name);
}

/** The scripts index.html loads, with everything they import statically. */
function eagerChunks(chunks: Record<string, Chunk>): string[] {
  const html = readFileSync(join(ROOT, 'dist', 'site', 'index.html'), 'utf8');
  const entries = [...html.matchAll(/<script type="module"[^>]*src="\/([^"]+)"/g)].map((match) => match[1]);
  expect(entries.length).toBeGreaterThan(0);
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const next of chunks[file]?.imports ?? []) visit(next);
  };
  entries.forEach(visit);
  return [...seen];
}

type Loaded = { file: string; bytes: number; gzip: number; heavy: string[]; eager: boolean };

/** Every JavaScript response the page receives from now on. */
function recordScripts(page: Page, chunks: Record<string, Chunk>, eager: string[]) {
  const loaded: Loaded[] = [];
  const pending: Promise<void>[] = [];
  page.on('response', (response) => {
    const url = new URL(response.url());
    if (!url.pathname.endsWith('.js')) return;
    pending.push(
      response.body().then((body) => {
        const file = url.pathname.slice(1);
        loaded.push({ file, bytes: body.length, gzip: gzipSync(body).length, heavy: heavyIn(chunks[file]), eager: eager.includes(file) });
      }),
    );
  });
  return async () => {
    await Promise.all(pending);
    return loaded.sort((a, b) => b.bytes - a.bytes);
  };
}

function summary(loaded: Loaded[]) {
  const sum = (list: Loaded[], key: 'bytes' | 'gzip') => list.reduce((total, entry) => total + entry[key], 0);
  const eager = loaded.filter((entry) => entry.eager);
  return {
    files: loaded.length,
    bytes: sum(loaded, 'bytes'),
    gzip: sum(loaded, 'gzip'),
    eagerBytes: sum(eager, 'bytes'),
    eagerGzip: sum(eager, 'gzip'),
    heavy: [...new Set(loaded.flatMap((entry) => entry.heavy))].sort(),
  };
}

async function report(testInfo: TestInfo, name: string, loaded: Loaded[]) {
  const body = { summary: summary(loaded), loaded };
  await testInfo.attach(name, { body: JSON.stringify(body, null, 2), contentType: 'application/json' });
  console.log(`${name}: ${JSON.stringify(body.summary)}`);
  for (const entry of loaded) console.log(`  ${entry.eager ? 'eager' : 'lazy '} ${String(entry.bytes).padStart(9)} B  ${String(entry.gzip).padStart(8)} B gz  ${entry.file}  ${entry.heavy.join(', ')}`);
}

test.beforeEach(({ browserName }) => {
  test.skip(browserName !== 'chromium', 'The budget is the same build in every browser; measured once, in Chromium (it clears the cache over CDP).');
});

test('the first load carries the workspace; each heavy part waits for the visit that needs it', async ({ page, context }, testInfo) => {
  const chunks = readReport();
  const eager = eagerChunks(chunks);
  // The build put each heavy part somewhere, and none of it in the first load.
  for (const name of Object.keys(HEAVY)) expect(Object.values(chunks).some((chunk) => heavyIn(chunk).includes(name)), name).toBe(true);
  expect(eager.flatMap((file) => heavyIn(chunks[file]).map((name) => `${file}: ${name}`))).toEqual([]);

  // A first visit, cold: the sample is made and its observing plan opens.
  let done = recordScripts(page, chunks, eager);
  await openApp(page);
  await closeIntro(page);
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await page.waitForLoadState('networkidle');
  const first = await done();
  await report(testInfo, 'first-visit', first);
  expect(first.filter((entry) => entry.eager).map((entry) => entry.file).sort()).toEqual([...eager].sort());
  expect(summary(first).heavy).toEqual(['react-markdown', 'sample']);

  // The next visit, cold again: the note opens without the sample's code.
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.clearBrowserCache');
  done = recordScripts(page, chunks, eager);
  page.removeAllListeners('pageerror');
  await page.reload();
  await page.locator('#loader').waitFor({ state: 'detached' });
  await expect(page.locator('.ws-prose')).toContainText('Saturday, after moonset.');
  await page.waitForLoadState('networkidle');
  const again = await done();
  await report(testInfo, 'return-visit', again);
  expect(again.filter((entry) => entry.eager).map((entry) => entry.file).sort()).toEqual([...eager].sort());
  expect(summary(again).heavy).toEqual(['react-markdown']);

  // The controls: CodeMirror comes with edit mode, Excalidraw with a canvas.
  done = recordScripts(page, chunks, eager);
  await page.locator('.ws-stage').getByRole('button', { name: 'Edit' }).click();
  await expect(page.locator('.ws-page .cm-content')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('tab', { name: 'Winter hexagon', exact: true }).click();
  await expect(page.locator('.ws-canvas .excalidraw')).toBeVisible({ timeout: 30_000 });
  await page.waitForLoadState('networkidle');
  const later = await done();
  await report(testInfo, 'edit-and-canvas', later);
  expect(summary(later).heavy).toEqual(expect.arrayContaining(['CodeMirror', 'Excalidraw']));
  expect(summary(later).heavy).not.toContain('migration');
});
