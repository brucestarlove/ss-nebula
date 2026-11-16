// Served by the Vite dev server for e2e/folder-store.spec.ts: the folder
// tier's store and registry in a real browser. showDirectoryPicker() can't
// be driven from Playwright, so a folder of the origin private file system
// stands in for a picked one: it is the same FileSystemDirectoryHandle
// interface. Real folders' permission prompts are covered by the unit tests'
// fake handles (src/files/folderRegistry.test.ts) and by Bruce's check on
// his Mac.
import { indexedDbFolderHandles } from '../../src/files/folderHandles';
import { FolderFileStore, folderFileStore } from '../../src/files/folderStore';
import { OpfsFileStore } from '../../src/files/opfsStore';
import { folderAccess } from '../../src/files/folderTier';
import { createOpfsRegistry } from '../../src/files/opfsRegistry';
import { PathLocks } from '../../src/files/pathLocks';
import { fileStoreConformanceCases, fileStoreTwinCases, type ConformanceResult } from '../../src/files/storeConformance';
import type { FileChange, FolderHandle } from '../../src/files/types';

const HARNESS_DIR = 'folder-harness';
const HANDLE_DB = 'nebula-folders-harness';

async function harnessRoot(): Promise<FileSystemDirectoryHandle> {
  return (await navigator.storage.getDirectory()).getDirectoryHandle(HARNESS_DIR, { create: true });
}

/** A folder standing in for one the person picked: `picked/<name>`. */
async function pickedFolder(name: string): Promise<FileSystemDirectoryHandle> {
  const picked = await (await harnessRoot()).getDirectoryHandle('picked', { create: true });
  return picked.getDirectoryHandle(name, { create: true });
}

async function dropFolder(name: string): Promise<void> {
  const picked = await (await harnessRoot()).getDirectoryHandle('picked', { create: true });
  await picked.removeEntry(name, { recursive: true }).catch(() => {});
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const asFolder = (handle: FileSystemDirectoryHandle) => handle as unknown as FolderHandle;

/** Writes a file the way another app does: straight to the folder, with no
 * Web Lock and no message to Nebula's tabs. */
async function writeOutside(folder: FileSystemDirectoryHandle, path: string, text: string): Promise<void> {
  const parts = path.split('/');
  let dir = folder;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
  const writable = await file.createWritable();
  await writable.write(text);
  await writable.close();
}

async function readOutside(folder: FileSystemDirectoryHandle, path: string): Promise<string> {
  const parts = path.split('/');
  let dir = folder;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part);
  return (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
}

async function runCase(name: string): Promise<ConformanceResult> {
  const testCase = fileStoreConformanceCases.find((candidate) => candidate.name === name);
  if (!testCase) return { name, ok: false, error: `No conformance case named ${JSON.stringify(name)}` };
  const folder = `case-${crypto.randomUUID()}`;
  const store = folderFileStore(asFolder(await pickedFolder(folder)), folder);
  try {
    await testCase.run(store);
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: describe(error) };
  } finally {
    await dropFolder(folder);
  }
}

/** Two stores over one picked folder, as two tabs of the project have: the
 * same id (so the same channel and Web Locks), their own path locks. */
async function runTwinCase(name: string): Promise<ConformanceResult> {
  const testCase = fileStoreTwinCases.find((candidate) => candidate.name === name);
  if (!testCase) return { name, ok: false, error: `No twin case named ${JSON.stringify(name)}` };
  const folder = `twin-${crypto.randomUUID()}`;
  const handle = asFolder(await pickedFolder(folder));
  const here = folderFileStore(handle, folder, new PathLocks());
  const there = folderFileStore(handle, folder, new PathLocks());
  try {
    await testCase.run(here, there);
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: describe(error) };
  } finally {
    await dropFolder(folder);
  }
}

const harness = {
  conformanceNames: fileStoreConformanceCases.map((testCase) => testCase.name),
  twinNames: fileStoreTwinCases.map((testCase) => testCase.name),
  runCase,
  runTwinCase,

  /** A folder's handle kept in IndexedDB and read back: the same folder,
   * still allowed, then gone once deleted. */
  async handleRoundTrip(): Promise<{ same: boolean; access: string; name: string; afterDelete: boolean }> {
    const folder = await pickedFolder('Kept');
    const handles = indexedDbFolderHandles(indexedDB, HANDLE_DB);
    await handles.put('kept01', asFolder(folder));
    const back = await handles.get('kept01');
    const same = back ? await (back as unknown as FileSystemDirectoryHandle).isSameEntry(folder) : false;
    const access = await folderAccess(back);
    await handles.delete('kept01');
    const afterDelete = (await handles.get('kept01')) === null;
    return { same, access, name: back?.name ?? '', afterDelete };
  },

  /** Step one of a reload: a folder project made in the OPFS registry (the
   * folder already holds files), a file written through it. */
  async registryBefore(): Promise<{ id: string; tier: string; files: string[] }> {
    await dropFolder('Field notes');
    const folder = await pickedFolder('Field notes');
    await writeOutside(folder, 'Ideas.md', '# Ideas');
    const registryRoot = await (await harnessRoot()).getDirectoryHandle('registry', { create: true });
    const registry = await createOpfsRegistry(registryRoot, { folderHandles: indexedDbFolderHandles(indexedDB, HANDLE_DB) });
    const record = await registry.create({ name: 'Field notes', color: '#7c8cff', folder: asFolder(folder) });
    const store = await registry.open(record.id);
    await store.write('Today.md', 'written through Nebula');
    return { id: record.id, tier: record.tier, files: (await store.list()).map((entry) => entry.path) };
  },

  /** Step two, after the reload: the same project, its folder still allowed,
   * its files on disk. */
  async registryAfter(): Promise<{ list: Array<{ id: string; tier: string; name: string; folder?: { name: string; access: string } }>; current: string | null; today: string; nebula: string[] }> {
    const registryRoot = await (await harnessRoot()).getDirectoryHandle('registry', { create: true });
    const registry = await createOpfsRegistry(registryRoot, { folderHandles: indexedDbFolderHandles(indexedDB, HANDLE_DB) });
    const list = (await registry.list()).map(({ id, tier, name, folder }) => ({ id, tier, name, ...(folder ? { folder } : {}) }));
    const folder = await pickedFolder('Field notes');
    const nebula: string[] = [];
    for await (const name of (await folder.getDirectoryHandle('.nebula') as unknown as { keys(): AsyncIterable<string> }).keys()) nebula.push(name);
    return { list, current: await registry.current(), today: await readOutside(folder, 'Today.md'), nebula: nebula.sort() };
  },

  /** Read, another app changes the file, then a save expecting what was
   * read: it must fail, and the other app's version stay. */
  async outsideChangeThenSave(): Promise<{ error: string; onDisk: string; listed: string[] }> {
    await dropFolder('Conflict');
    const folder = await pickedFolder('Conflict');
    const store = folderFileStore(asFolder(folder), 'conflict');
    await store.write('Plan.md', 'mine, as read');
    const seen = await store.readText('Plan.md');
    await writeOutside(folder, 'Plan.md', 'changed in another app');
    let error = '';
    try {
      await store.write('Plan.md', 'my edit', { ifUnchanged: { text: seen } });
    } catch (caught) {
      error = describe(caught);
    }
    return { error, onDisk: await readOutside(folder, 'Plan.md'), listed: (await store.list()).map((entry) => entry.path) };
  },

  /** Another app adds, changes and deletes files while a folder store is
   * watched, with FileSystemObserver (where the browser has it) or by
   * looking every 200 ms: what the store's watcher heard, in order. */
  async outsideChangesHeard(useObserver: boolean): Promise<{ observer: boolean; heard: FileChange[]; ms: number }> {
    const name = `outside-${useObserver ? 'observed' : 'polled'}`;
    await dropFolder(name);
    const folder = await pickedFolder(name);
    await writeOutside(folder, 'Kept.md', 'kept');
    const store = new FolderFileStore(new OpfsFileStore(folder, { locks: { locks: new PathLocks(), prefix: `folders/${name}` } }), {
      handle: asFolder(folder),
      ...(useObserver ? {} : { observer: null }),
      pollMs: 200,
      observedPollMs: 60_000,
    });
    const heard: FileChange[] = [];
    const stop = store.watch((change) => heard.push(change));
    await store.check();
    const started = performance.now();
    const waitFor = async (count: number) => {
      const end = performance.now() + 5000;
      while (heard.length < count && performance.now() < end) await new Promise((resolve) => setTimeout(resolve, 20));
    };
    await writeOutside(folder, 'Trips/Iceland.md', 'north');
    await waitFor(2);
    await writeOutside(folder, 'Kept.md', 'kept, and changed elsewhere');
    await waitFor(3);
    await folder.removeEntry('Trips', { recursive: true });
    await waitFor(4);
    const ms = Math.round(performance.now() - started);
    stop();
    await dropFolder(name);
    return { observer: typeof (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver === 'function', heard, ms };
  },

  /** What a real FileSystemObserver reports for the changes another app
   * makes (probe, Round 3): each step's records as { type, kind, path,
   * from }, where `path` is relativePathComponents joined by '/'. */
  async observerRecords(): Promise<Record<string, Array<{ type: string; kind: string | null; path: string | null; from: string | null }>>> {
    const name = 'observer-records';
    await dropFolder(name);
    const folder = await pickedFolder(name);
    await writeOutside(folder, 'Kept.md', 'kept');
    await writeOutside(folder, 'Sub/Deep/Note.md', 'deep');
    const Observer = (globalThis as unknown as { FileSystemObserver: new (callback: (records: Array<Record<string, unknown>>) => void) => { observe(handle: unknown, options: unknown): Promise<void>; disconnect(): void } }).FileSystemObserver;
    let current: Array<{ type: string; kind: string | null; path: string | null; from: string | null }> = [];
    const observer = new Observer((records) => {
      for (const record of records) {
        const parts = record.relativePathComponents as string[] | undefined;
        const from = record.relativePathMovedFrom as string[] | undefined;
        current.push({
          type: String(record.type),
          kind: (record.changedHandle as { kind?: string } | null | undefined)?.kind ?? null,
          path: Array.isArray(parts) ? parts.join('/') : null,
          from: Array.isArray(from) ? from.join('/') : null,
        });
      }
    });
    await observer.observe(folder, { recursive: true });
    const out: Record<string, typeof current> = {};
    const step = async (label: string, act: () => Promise<void>) => {
      current = [];
      await act();
      await new Promise((resolve) => setTimeout(resolve, 600));
      out[label] = current;
    };
    await step('modify a file', () => writeOutside(folder, 'Kept.md', 'kept, changed'));
    await step('new file in a new folder', () => writeOutside(folder, 'Fresh/One.md', 'one'));
    await step('new file in an old folder', () => writeOutside(folder, 'Sub/Deep/Two.md', 'two'));
    await step('delete a file', async () => {
      const dir = await (await folder.getDirectoryHandle('Sub')).getDirectoryHandle('Deep');
      await dir.removeEntry('Two.md');
    });
    await step('rename a file (move)', async () => {
      const handle = await folder.getFileHandle('Kept.md');
      await (handle as unknown as { move(name: string): Promise<void> }).move('Renamed.md');
    });
    await step('delete a folder recursively', () => folder.removeEntry('Sub', { recursive: true }));
    await step('make a folder', async () => {
      await folder.getDirectoryHandle('Empty', { create: true });
    });
    observer.disconnect();
    await dropFolder(name);
    return out;
  },
};

Object.assign(window, { folderHarness: harness, filesHarnessReady: true });
