// The folder tier in a real browser: its store passes
// the same conformance suites as OPFS's, its folders are kept in IndexedDB,
// and a change another app makes is never overwritten.
//
// showDirectoryPicker() can't be driven from Playwright, so a folder of the
// origin private file system stands in for a picked one (the same
// FileSystemDirectoryHandle interface). Real folders' permission prompts are
// covered by the unit tests' fake handles (src/files/folderRegistry.test.ts)
// and by Bruce's check on his Mac.
import { NESTED_DOT_CASE, fileStoreConformanceCases, fileStoreTwinCases } from '../src/files/storeConformance';
import { expect, openHarness, test } from './harness/files-fixtures';

type Result = { name: string; ok: boolean; error?: string };

type Harness = {
  runCase(name: string): Promise<Result>;
  runTwinCase(name: string): Promise<Result>;
  handleRoundTrip(): Promise<{ same: boolean; access: string; name: string; afterDelete: boolean }>;
  registryBefore(): Promise<{ id: string; tier: string; files: string[] }>;
  registryAfter(): Promise<{
    list: Array<{ id: string; tier: string; name: string; folder?: { name: string; access: string } }>;
    current: string | null;
    today: string;
    nebula: string[];
  }>;
  outsideChangeThenSave(): Promise<{ error: string; onDisk: string; listed: string[] }>;
  outsideChangesHeard(useObserver: boolean): Promise<{ observer: boolean; heard: unknown[]; ms: number }>;
  observerRecords(): Promise<Record<string, Array<{ type: string; kind: string | null; path: string | null; from: string | null }>>>;
};

declare global {
  interface Window {
    folderHarness: Harness;
  }
}

const HARNESS = '/e2e/harness/folder.html';

test.skip(process.env.NEBULA_E2E_BUILT === '1', 'needs the dev server for e2e/harness/');
test.skip(({ browserName }) => browserName !== 'chromium', 'the folder tier is Chromium only');

test.describe('the folder store (FileStore conformance)', () => {
  // A folder hides every dot-entry, a nested .nebula too.
  for (const testCase of fileStoreConformanceCases.filter((candidate) => candidate.name !== NESTED_DOT_CASE)) {
    test(testCase.name, async ({ persistentContext }) => {
      const page = await openHarness(persistentContext, HARNESS);
      const result = await page.evaluate((name) => window.folderHarness.runCase(name), testCase.name);
      await page.close();
      expect(result.error ?? '', result.error).toBe('');
      expect(result.ok).toBe(true);
    });
  }
});

test.describe('the folder store (FileStore conformance, two stores)', () => {
  for (const testCase of fileStoreTwinCases) {
    test(testCase.name, async ({ persistentContext }) => {
      const page = await openHarness(persistentContext, HARNESS);
      const result = await page.evaluate((name) => window.folderHarness.runTwinCase(name), testCase.name);
      await page.close();
      expect(result.error ?? '', result.error).toBe('');
      expect(result.ok).toBe(true);
    });
  }
});

test('a folder is kept in IndexedDB by project id, and comes back the same folder', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  expect(await page.evaluate(() => window.folderHarness.handleRoundTrip())).toEqual({ same: true, access: 'granted', name: 'Kept', afterDelete: true });
  await page.close();
});

test('a folder project survives a reload: the same project, its edits on disk', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const before = await page.evaluate(() => window.folderHarness.registryBefore());
  expect(before.tier).toBe('folder');
  expect(before.files).toEqual(['Ideas.md', 'Today.md']);
  await page.reload();
  await page.waitForFunction(() => (window as unknown as { filesHarnessReady?: boolean }).filesHarnessReady === true);
  const after = await page.evaluate(() => window.folderHarness.registryAfter());
  expect(after.list).toEqual([{ id: before.id, tier: 'folder', name: 'Field notes', folder: { name: 'Field notes', access: 'granted' } }]);
  expect(after.current).toBe(before.id);
  expect(after.today).toBe('written through Nebula');
  expect(after.nebula).toEqual(['project.json']);
  await page.close();
});

test('a file another app changed after Nebula read it is never overwritten', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const result = await page.evaluate(() => window.folderHarness.outsideChangeThenSave());
  expect(result.error).toMatch(/^FileChangedError/);
  expect(result.onDisk).toBe('changed in another app');
  expect(result.listed).toEqual(['Plan.md']);
  await page.close();
});

for (const useObserver of [true, false]) {
  test(`changes another app makes are heard, ${useObserver ? 'through FileSystemObserver' : 'by looking every few seconds'}`, async ({ persistentContext }) => {
    const page = await openHarness(persistentContext, HARNESS);
    const result = await page.evaluate((observe) => window.folderHarness.outsideChangesHeard(observe), useObserver);
    await page.close();
    // Chromium 156 has FileSystemObserver (probed 2026-10-25).
    expect(result.observer).toBe(true);
    expect(result.heard).toEqual([
      { type: 'mkdir', path: 'Trips' },
      { type: 'write', path: 'Trips/Iceland.md' },
      { type: 'write', path: 'Kept.md' },
      { type: 'remove', path: 'Trips' },
    ]);
  });
}

// S10: does move() onto an existing file replace it? The
// answer is recorded in the storage notes; writeNew checks the name again
// right before move() whatever it is.
test('probe: move() of an OPFS file onto an existing name', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const answer = await page.evaluate(async () => {
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(`move-probe-${Date.now()}`, { create: true });
    const write = async (name: string, text: string) => {
      const handle = await dir.getFileHandle(name, { create: true });
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return handle;
    };
    await write('a.txt', 'old');
    const temp = await write('temp.txt', 'new');
    let outcome: string;
    try {
      await (temp as unknown as { move(parent: FileSystemDirectoryHandle, name: string): Promise<void> }).move(dir, 'a.txt');
      outcome = 'moved';
    } catch (error) {
      outcome = `threw ${(error as Error).name}`;
    }
    const now = await (await (await dir.getFileHandle('a.txt')).getFile()).text();
    return `${outcome}; a.txt holds ${JSON.stringify(now)}`;
  });
  await page.close();
  console.log(`S10 move() probe: ${answer}`);
  expect(answer).toMatch(/^(moved|threw \w+); a\.txt holds "(old|new)"$/);
});


// Round 3, item 2: the watcher checks only the paths a FileSystemObserver
// record names. What a real observer reports (Chromium 156, on an OPFS folder
// standing in for a picked one) is the rule it relies on; the records are
// printed so the log can quote them.
test('probe: what FileSystemObserver reports for changes another app makes', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const records = await page.evaluate(() => window.folderHarness.observerRecords());
  await page.close();
  console.log('OBSERVER RECORDS ' + JSON.stringify(records, null, 1));
  for (const list of Object.values(records)) {
    expect(list.length).toBeGreaterThan(0);
    for (const record of list) expect(typeof record.type).toBe('string');
  }
});

// Round 3, item 4 (S14): can move() move a folder? Where it can't, the
// copy-then-remove fallback runs, and it must remove only what it copied and
// verified. Run on OPFS (Chromium 156); a real local folder can't be picked
// from Playwright, so the answer there is unprobed. The outcomes are printed
// for the log.
test('probe: directory move() in the origin private file system', async ({ persistentContext }) => {
  const page = await openHarness(persistentContext, HARNESS);
  const answers = await page.evaluate(async () => {
    type Movable = { move(...args: unknown[]): Promise<void> };
    const root = await navigator.storage.getDirectory();
    const base = await root.getDirectoryHandle(`dir-move-probe-${Date.now()}`, { create: true });
    const put = async (dir: FileSystemDirectoryHandle, name: string, text: string) => {
      const writable = await (await dir.getFileHandle(name, { create: true })).createWritable();
      await writable.write(text);
      await writable.close();
    };
    const folder = await base.getDirectoryHandle('Folder', { create: true });
    await put(folder, 'a.txt', 'a');
    await put(await folder.getDirectoryHandle('Deep', { create: true }), 'b.txt', 'b');
    const target = await base.getDirectoryHandle('Target', { create: true });
    const out: Record<string, string> = {};
    const names = async (dir: FileSystemDirectoryHandle): Promise<string> => {
      const found: string[] = [];
      for await (const handle of (dir as unknown as { values(): AsyncIterable<FileSystemHandle> }).values()) {
        found.push(handle.kind === 'directory' ? `${handle.name}/[${await names(handle as FileSystemDirectoryHandle)}]` : handle.name);
      }
      return found.sort().join(',');
    };
    out.start = await names(base);
    const attempt = async (label: string, run: () => Promise<void>) => {
      try {
        await run();
        out[label] = 'moved';
      } catch (error) {
        out[label] = `threw ${(error as Error).name}`;
      }
    };
    await attempt('folder into another folder', () => (folder as unknown as Movable).move(target, 'Moved'));
    out.afterFirst = await names(base);
    const moved = await target.getDirectoryHandle('Moved').catch((error: Error) => error.name);
    if (typeof moved !== 'string') await attempt('folder renamed in place', () => (moved as unknown as Movable).move('Renamed'));
    else out['moved lookup'] = moved;
    out.afterSecond = await names(base);
    const other = await base.getDirectoryHandle('Other', { create: true });
    await put(other, 'x.txt', 'x');
    const clash = await base.getDirectoryHandle('Clash', { create: true });
    await put(clash, 'y.txt', 'y');
    await attempt('folder onto an existing folder', () => (clash as unknown as Movable).move(base, 'Other'));
    out.otherHolds = await names(other).catch((error: Error) => error.name);
    out.afterClash = await names(base);
    await root.removeEntry(base.name, { recursive: true });
    return out;
  });
  await page.close();
  console.log('DIRECTORY MOVE PROBE ' + JSON.stringify(answers, null, 1));
  expect(Object.keys(answers)).toContain('folder into another folder');
});
