// The browser registry in real browsers: projects kept in OPFS across reloads,
// heard across tabs, and, when OPFS can't keep anything (WebKit's ephemeral
// contexts), the memory fallback that says so.
import { unzipSync } from 'fflate';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { expect, openHarness, test } from './harness/files-fixtures';

const HARNESS = '/e2e/harness/files-registry.html';

type Project = { id: string; name: string; color: string; lastOpened?: string };
type Registry = {
  open(): Promise<{ persistent: boolean; reason?: string }>;
  wipe(): Promise<void>;
  create(name: string, color: string): Promise<Project>;
  list(): Promise<Project[]>;
  current(): Promise<string | null>;
  remove(id: string): Promise<void>;
  write(id: string, path: string, text: string): Promise<void>;
  read(id: string, path: string): Promise<string>;
  paths(id: string): Promise<string[]>;
  watch(id: string): Promise<void>;
  heard(): Array<{ id: string; change: unknown }>;
  opfsTree(): Promise<string[]>;
  readOpfs(path: string): Promise<string>;
  dropFolder(id: string): Promise<void>;
  seedSample(): Promise<{ project: Project; missing: string[] }>;
  zip(id: string, folder?: string): Promise<string>;
  storage(): Promise<{ requested: boolean | null; status: { persisted: boolean | null; usage?: number; quota?: number } }>;
  entries(id: string): Promise<Array<{ path: string; type: string; size?: number }>>;
  canvas(id: string, path: string): Promise<{ elements: Array<Record<string, unknown>>; files: Record<string, unknown> }>;
};

declare global {
  interface Window {
    filesRegistry: Registry;
  }
}

// The harness pages are served by the Vite dev server only.
test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');

test.describe('the browser registry on OPFS', () => {
  test('keeps projects and their files across a reload, laid out as nebula/registry.json and nebula/projects/', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.filesRegistry.wipe());
    expect(await page.evaluate(() => window.filesRegistry.open())).toEqual({ persistent: true });
    const project = await page.evaluate(() => window.filesRegistry.create('Night Sky', '#7c8cff'));
    await page.evaluate((id) => window.filesRegistry.write(id, 'Guides/Orion.md', 'Betelgeuse and Rigel'), project.id);

    await page.reload();
    await page.waitForFunction(() => (window as unknown as { filesHarnessReady?: boolean }).filesHarnessReady === true);
    expect(await page.evaluate(() => window.filesRegistry.open())).toEqual({ persistent: true });
    expect(await page.evaluate(() => window.filesRegistry.list())).toMatchObject([{ id: project.id, name: 'Night Sky', color: '#7c8cff' }]);
    expect(await page.evaluate(() => window.filesRegistry.current())).toBe(project.id);
    expect(await page.evaluate((id) => window.filesRegistry.read(id, 'Guides/Orion.md'), project.id)).toBe('Betelgeuse and Rigel');
    expect(await page.evaluate((id) => window.filesRegistry.paths(id), project.id)).toEqual(['Guides', 'Guides/Orion.md']);

    const registryJson = JSON.parse(await page.evaluate(() => window.filesRegistry.readOpfs('nebula/registry.json')));
    expect(registryJson).toMatchObject({ version: 1, current: project.id, projects: [{ id: project.id, tier: 'browser' }] });
    const dir = registryJson.projects[0].dir;
    expect(await page.evaluate(() => window.filesRegistry.opfsTree())).toEqual(
      expect.arrayContaining(['registry.json', 'projects/', `projects/${dir}/`, `projects/${dir}/.nebula/project.json`, `projects/${dir}/Guides/Orion.md`]),
    );
    expect(JSON.parse(await page.evaluate((path) => window.filesRegistry.readOpfs(path), `nebula/projects/${dir}/.nebula/project.json`))).toMatchObject({
      id: project.id,
      name: 'Night Sky',
      color: '#7c8cff',
    });
    await page.close();
  });

  test("a project's watcher hears a change made in another tab", async ({ persistentContext }) => {
    const watcher = await openHarness(persistentContext, HARNESS);
    await watcher.evaluate(() => window.filesRegistry.wipe());
    await watcher.evaluate(() => window.filesRegistry.open());
    const project = await watcher.evaluate(() => window.filesRegistry.create('Night Sky', '#7c8cff'));
    await watcher.evaluate((id) => window.filesRegistry.watch(id), project.id);

    const writer = await openHarness(persistentContext, HARNESS);
    await writer.evaluate(() => window.filesRegistry.open());
    await writer.evaluate((id) => window.filesRegistry.write(id, 'Sketches/new.md', 'from the other tab'), project.id);

    await expect.poll(() => watcher.evaluate(() => window.filesRegistry.heard())).toEqual([{ id: project.id, change: { type: 'write', path: 'Sketches/new.md' } }]);
    expect(await watcher.evaluate((id) => window.filesRegistry.read(id, 'Sketches/new.md'), project.id)).toBe('from the other tab');
    await watcher.close();
    await writer.close();
  });

  test('removes a project with its folder, and skips one whose folder vanished', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.filesRegistry.wipe());
    await page.evaluate(() => window.filesRegistry.open());
    const kept = await page.evaluate(() => window.filesRegistry.create('Kept', '#7c8cff'));
    const removed = await page.evaluate(() => window.filesRegistry.create('Removed', '#a78bfa'));
    const vanished = await page.evaluate(() => window.filesRegistry.create('Vanished', '#e879f9'));
    await page.evaluate((id) => window.filesRegistry.write(id, 'a.md', 'A'), removed.id);

    await page.evaluate((id) => window.filesRegistry.remove(id), removed.id);
    await page.evaluate((id) => window.filesRegistry.dropFolder(id), vanished.id);

    expect((await page.evaluate(() => window.filesRegistry.list())).map((project) => project.name)).toEqual(['Kept']);
    expect((await page.evaluate(() => window.filesRegistry.opfsTree())).filter((path) => /^projects\/[^/]+\/$/.test(path))).toHaveLength(1);
    void kept;
    await page.close();
  });
});

test.describe('the first run on OPFS', () => {
  test('seeds Night Sky, fetching its image and PDF from public/sample', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.filesRegistry.wipe());
    await page.evaluate(() => window.filesRegistry.open());
    const { project, missing } = await page.evaluate(() => window.filesRegistry.seedSample());
    expect(missing).toEqual([]);
    expect(project).toMatchObject({ name: 'Night Sky', color: '#7c8cff' });

    const entries = await page.evaluate((id) => window.filesRegistry.entries(id), project.id);
    expect(entries.map((entry) => entry.path)).toEqual([
      'Charts',
      'Charts/Star chart — October.pdf',
      'Guides',
      'Guides/Moon phases.md',
      'Guides/Observing plan.md',
      'Guides/Orion.md',
      'Photos',
      'Photos/Winter hexagon.png',
      'README.md',
      'Sketches',
      'Sketches/Winter hexagon.excalidraw.md',
    ]);
    const size = (path: string) => entries.find((entry) => entry.path === path)?.size;
    expect(size('Photos/Winter hexagon.png')).toBe(statSync('public/sample/winter-hexagon.png').size);
    expect(size('Charts/Star chart — October.pdf')).toBe(statSync('public/sample/star-chart.pdf').size);
    expect((await page.evaluate((id) => window.filesRegistry.canvas(id, 'Sketches/Winter hexagon.excalidraw.md'), project.id)).elements).toHaveLength(29);
    await page.close();
  });

  test('downloads a project as a .zip holding every file, byte for byte, and project.json', async ({ persistentContext }, testInfo) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.filesRegistry.wipe());
    await page.evaluate(() => window.filesRegistry.open());
    const { project } = await page.evaluate(() => window.filesRegistry.seedSample());
    const zip = Buffer.from(await page.evaluate((id) => window.filesRegistry.zip(id, 'Night Sky'), project.id), 'base64');
    writeFileSync(testInfo.outputPath('Night Sky.zip'), zip);

    const entries = unzipSync(new Uint8Array(zip));
    expect(Object.keys(entries).sort()).toEqual(
      [
        'Night Sky/.nebula/project.json',
        'Night Sky/Charts/Star chart — October.pdf',
        'Night Sky/Guides/Moon phases.md',
        'Night Sky/Guides/Observing plan.md',
        'Night Sky/Guides/Orion.md',
        'Night Sky/Photos/Winter hexagon.png',
        'Night Sky/README.md',
        'Night Sky/Sketches/Winter hexagon.excalidraw.md',
      ].sort(),
    );
    expect(Buffer.from(entries['Night Sky/Photos/Winter hexagon.png']).equals(readFileSync('public/sample/winter-hexagon.png'))).toBe(true);
    expect(Buffer.from(entries['Night Sky/Charts/Star chart — October.pdf']).equals(readFileSync('public/sample/star-chart.pdf'))).toBe(true);
    expect(Buffer.from(entries['Night Sky/Guides/Orion.md']).equals(readFileSync('src/files/sample/Orion.md'))).toBe(true);
    expect(JSON.parse(Buffer.from(entries['Night Sky/.nebula/project.json']).toString('utf8'))).toMatchObject({ id: project.id, name: 'Night Sky', color: '#7c8cff' });
    await page.close();
  });
});

test('says whether the browser will keep anything', async ({ page, browserName }) => {
  // The default context: ephemeral. Chromium keeps OPFS there; WebKit fails getDirectory().
  await page.goto(HARNESS);
  await page.waitForFunction(() => (window as unknown as { filesHarnessReady?: boolean }).filesHarnessReady === true);
  const opened = await page.evaluate(() => window.filesRegistry.open());
  if (browserName === 'webkit') {
    expect(opened).toEqual({ persistent: false, reason: expect.stringContaining('UnknownError') });
  } else {
    expect(opened).toEqual({ persistent: true });
  }
  const project = await page.evaluate(() => window.filesRegistry.create('Either way', '#7c8cff'));
  await page.evaluate((id) => window.filesRegistry.write(id, 'note.md', 'works for this visit'), project.id);
  expect(await page.evaluate((id) => window.filesRegistry.read(id, 'note.md'), project.id)).toBe('works for this visit');
});

test('asks for persistent storage and reads the usage estimate', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const { requested, status } = await page.evaluate(() => window.filesRegistry.storage());
  // Each browser decides for itself; what matters is a real answer, not an error.
  expect(typeof requested).toBe('boolean');
  expect(typeof status.persisted).toBe('boolean');
  expect(status.usage).toEqual(expect.any(Number));
  expect(status.quota).toBeGreaterThan(0);
  await page.close();
});
