// OpfsFileStore in real browsers: the same conformance suite the memory store
// passes in vitest, plus what only OPFS has: other tabs hearing changes.
import { fileStoreConformanceCases } from '../src/files/storeConformance';
import { expect, openHarness, test } from './harness/files-fixtures';

type Harness = {
  runCase(name: string): Promise<{ name: string; ok: boolean; error?: string }>;
  runCaseWithoutMove(name: string): Promise<{ name: string; ok: boolean; error?: string; hadMove: boolean }>;
  watch(folder: string, channel?: string): Promise<void>;
  write(folder: string, path: string, text: string, channel?: string): Promise<void>;
  read(folder: string, path: string): Promise<string>;
  heard(): Array<{ folder: string; change: unknown }>;
};

declare global {
  interface Window {
    filesHarness: Harness;
  }
}

// The harness pages are served by the Vite dev server only.
test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');

test.describe('OpfsFileStore conformance', () => {
  for (const testCase of fileStoreConformanceCases) {
    test(testCase.name, async ({ harness }) => {
      const result = await harness.evaluate((name) => window.filesHarness.runCase(name), testCase.name);
      expect(result.error ?? '', result.error).toBe('');
      expect(result.ok).toBe(true);
    });
  }
});

test.describe('OpfsFileStore conformance without FileSystemHandle.move()', () => {
  for (const testCase of fileStoreConformanceCases.filter((candidate) => candidate.name.includes('rename'))) {
    test(testCase.name, async ({ harness, browserName }) => {
      const result = await harness.evaluate((name) => window.filesHarness.runCaseWithoutMove(name), testCase.name);
      expect(result.error ?? '', result.error).toBe('');
      expect(result.ok).toBe(true);
      // Chromium has move() (probed 2026-10-22), so this run really took the other path.
      if (browserName === 'chromium') expect(result.hadMove).toBe(true);
    });
  }
});

test.describe('OpfsFileStore across tabs', () => {
  test('a change written in one tab reaches a watcher in another', async ({ persistentContext }) => {
    const folder = `tabs-${Date.now()}`;
    const watcher = await openHarness(persistentContext);
    const writer = await openHarness(persistentContext);
    await watcher.evaluate((name) => window.filesHarness.watch(name), folder);
    await writer.evaluate((name) => window.filesHarness.write(name, 'Guides/Orion.md', 'Betelgeuse'), folder);

    await expect.poll(() => watcher.evaluate(() => window.filesHarness.heard())).toEqual([
      { folder, change: { type: 'write', path: 'Guides/Orion.md' } },
    ]);
    expect(await watcher.evaluate((name) => window.filesHarness.read(name, 'Guides/Orion.md'), folder)).toBe('Betelgeuse');
    await watcher.close();
    await writer.close();
  });

  test("another project's changes stay with that project", async ({ persistentContext }) => {
    const stamp = Date.now();
    const watcher = await openHarness(persistentContext);
    const writer = await openHarness(persistentContext);
    await watcher.evaluate((name) => window.filesHarness.watch(name), `quiet-${stamp}`);
    await writer.evaluate((name) => window.filesHarness.write(name, 'noise.md', 'elsewhere'), `noisy-${stamp}`);
    await writer.evaluate((name) => window.filesHarness.write(name, 'signal.md', 'here'), `quiet-${stamp}`);

    await expect.poll(() => watcher.evaluate(() => window.filesHarness.heard())).toEqual([
      { folder: `quiet-${stamp}`, change: { type: 'write', path: 'signal.md' } },
    ]);
    await watcher.close();
    await writer.close();
  });
});
