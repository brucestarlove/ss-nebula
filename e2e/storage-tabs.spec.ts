// Re-review R4: two tabs of one project, played by two OpfsFileStores over
// one OPFS folder. Path locks and the sessions' holdWrites cover one tab; the
// per-file Web Locks and the store's refusal to bring back a folder that went
// cover the other tabs. Real OPFS and real Web Locks, in Chromium and WebKit.
import { fileStoreTwinCases } from '../src/files/storeConformance';
import { expect, openHarness, test } from './harness/files-fixtures';
import './harness/storage-types';

const HARNESS = '/e2e/harness/storage-harness.html';

// The harness pages are served by the Vite dev server only.
test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');

test.describe('OpfsFileStore conformance, two stores over one folder', () => {
  for (const testCase of fileStoreTwinCases) {
    test(testCase.name, async ({ persistentContext }) => {
      const page = await openHarness(persistentContext, HARNESS);
      const result = await page.evaluate((name) => window.storageHarness.runTwinCase(name), testCase.name);
      expect(result.error ?? '', result.error).toBe('');
      expect(result.ok).toBe(true);
      await page.close();
    });
  }
});

test.describe("another tab's rename or remove waits for a write in flight here", () => {
  const cases = [
    { change: 'rename-file', files: ['Drawings/', 'Drawings/plan.md', 'Sketches/', 'Sketches/other.md'], text: 'v2' },
    { change: 'rename-folder', files: ['Drawings/', 'Drawings/other.md', 'Drawings/plan.md'], text: 'v2' },
    { change: 'remove-file', files: ['Sketches/', 'Sketches/other.md'], text: null },
    { change: 'remove-folder', files: [], text: null },
  ] as const;
  for (const { change, files, text } of cases) {
    test(`${change}: nothing is left at the old path and nothing comes back`, async ({ persistentContext }) => {
      const page = await openHarness(persistentContext, HARNESS);
      const seen = await page.evaluate((which) => window.storageHarness.heldWriteThen(which), change);
      expect(seen.wentAhead, 'the other store went ahead while the write was held').toBe(false);
      expect(seen.results).toEqual(['ok', 'ok']);
      expect(seen.files).toEqual(files);
      expect(seen.text).toBe(text);
      await page.close();
    });
  }
});
