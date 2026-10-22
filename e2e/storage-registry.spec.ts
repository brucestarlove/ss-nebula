// The storage lane's browser checks (docs/lanes/storage.md): what only real
// OPFS and real Web Locks can show. The store conformance cases themselves run
// in e2e/files-opfs.spec.ts.
import { expect, openHarness, test } from './harness/files-fixtures';
import './harness/storage-types';

const HARNESS = '/e2e/harness/storage-harness.html';

// The harness pages are served by the Vite dev server only.
test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');

test.describe('the registry and its projects share their path locks', () => {
  test('removing a project waits for a write in flight, so its folder never comes back', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.storageHarness.wipe());
    expect(await page.evaluate(() => window.storageHarness.open())).toEqual({ persistent: true });
    const { results, tree } = await page.evaluate(() => window.storageHarness.removeWhileWriting());
    expect(results).toEqual(['ok', 'ok']);
    expect(tree.filter((path) => path.startsWith('projects/') && path !== 'projects/')).toEqual([]);
    await page.close();
  });
});

test.describe('a new file appears whole or not at all (review finding 11)', () => {
  test('another store never sees a new file empty or half written, nor its temporary name', async ({ persistentContext, browserName }, testInfo) => {
    const page = await openHarness(persistentContext, HARNESS);
    // WebKit writes and moves 8 MB before the reader has looked twice.
    const chars = browserName === 'webkit' ? 32_000_000 : 8_000_000;
    const seen = await page.evaluate((size) => window.storageHarness.watchNewFile(size), chars);
    testInfo.annotations.push({ type: 'move()', description: seen.move ? 'moved into place' : 'copied into place' });
    // It looked while the write was in flight, more than once.
    expect(seen.looks).toBeGreaterThan(2);
    expect(seen.sizes.filter((size) => size !== chars)).toEqual([]);
    expect(seen.listed.filter((name) => name !== 'Big file.md')).toEqual([]);
    expect(seen.final).toBe(chars);
    expect(seen.leftover).toEqual([]);
    await page.close();
  });
});

test.describe('an overwrite is read whole, from another store too', () => {
  test('a read while another store replaces the file gets one version or the other, never a mix', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    const seen = await page.evaluate((rounds) => window.storageHarness.watchOverwrite(rounds), 12);
    expect(seen.reads).toBe(12);
    expect(seen.torn).toBe(0);
    expect(seen.lengths.every((length) => length === 600_000 || length === 700_000), seen.lengths.join(', ')).toBe(true);
    await page.close();
  });
});

test.describe('registry.json and the project folders (review findings 10 and 12)', () => {
  test('a project that registry.json lost, as when two tabs wrote it at once, is listed again', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.storageHarness.wipe());
    await page.evaluate(() => window.storageHarness.open());
    const listed = await page.evaluate(async () => {
      const harness = window.storageHarness;
      await harness.create('A');
      const before = await harness.readTree('registry.json');
      await harness.create('B');
      await harness.writeTree('registry.json', before);
      return (await harness.projects()).map((project) => project.name);
    });
    expect(listed).toEqual(['A', 'B']);
    expect(JSON.parse(await page.evaluate(() => window.storageHarness.readTree('registry.json'))).projects).toHaveLength(2);
    await page.close();
  });

  test('a registry.json from a newer Nebula is left exactly as it is', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.storageHarness.wipe());
    await page.evaluate(() => window.storageHarness.open());
    const { before, after, listed } = await page.evaluate(async () => {
      const harness = window.storageHarness;
      await harness.create('A');
      const registry = JSON.parse(await harness.readTree('registry.json'));
      const newer = `${JSON.stringify({ ...registry, version: 2, projects: [...registry.projects, { id: 'f1', tier: 'folder' }] }, null, 2)}\n`;
      await harness.writeTree('registry.json', newer);
      await harness.open();
      const names = (await harness.projects()).map((project) => project.name);
      const made = await harness.create('B').then(() => 'made', (error: Error) => error.name);
      return { before: newer, after: await harness.readTree('registry.json'), listed: [...names, made] };
    });
    expect(listed).toEqual(['A', 'ReadOnlyRegistryError']);
    expect(after).toBe(before);
    await page.close();
  });

  test('without Web Locks the browser tier keeps nothing, and says why', async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    await page.evaluate(() => window.storageHarness.wipe());
    const opened = await page.evaluate(() => window.storageHarness.open({ withoutWebLocks: true }));
    expect(opened).toEqual({ persistent: false, reason: expect.stringContaining('Web Locks') });
    await page.close();
  });
});
