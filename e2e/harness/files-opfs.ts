// Served by the Vite dev server for e2e/files-opfs.spec.ts: runs the FileStore
// conformance suite against OpfsFileStore in a real browser, and gives the
// spec small hooks for the cross-tab checks.
import { OpfsFileStore } from '../../src/files/opfsStore';
import { fileStoreConformanceCases, runFileStoreConformance, type ConformanceResult } from '../../src/files/storeConformance';
import type { FileChange } from '../../src/files/types';

const HARNESS_DIR = 'files-harness';

async function harnessRoot(): Promise<FileSystemDirectoryHandle> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(HARNESS_DIR, { create: true });
}

const folders = new Map<OpfsFileStore, string>();

async function freshStore(): Promise<OpfsFileStore> {
  const name = `case-${crypto.randomUUID()}`;
  const folder = await (await harnessRoot()).getDirectoryHandle(name, { create: true });
  const store = new OpfsFileStore(folder, { channel: `files-harness:${name}` });
  folders.set(store, name);
  return store;
}

async function cleanup(store: OpfsFileStore): Promise<void> {
  store.close();
  const name = folders.get(store);
  folders.delete(store);
  if (name) await (await harnessRoot()).removeEntry(name, { recursive: true });
}

function describeError(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

async function runCase(name: string): Promise<ConformanceResult> {
  const testCase = fileStoreConformanceCases.find((candidate) => candidate.name === name);
  if (!testCase) return { name, ok: false, error: `No conformance case named ${JSON.stringify(name)}` };
  const store = await freshStore();
  try {
    await testCase.run(store);
    return { name, ok: true };
  } catch (error) {
    return { name, ok: false, error: describeError(error) };
  } finally {
    await cleanup(store);
  }
}

/** The same case in an engine without FileSystemHandle.move(), so renames
 * take OpfsFileStore's copy-then-remove path. */
async function runCaseWithoutMove(name: string): Promise<ConformanceResult & { hadMove: boolean }> {
  const prototypes = [FileSystemHandle.prototype, FileSystemFileHandle.prototype, FileSystemDirectoryHandle.prototype];
  const saved = prototypes.map((prototype) => Object.getOwnPropertyDescriptor(prototype, 'move'));
  const hadMove = saved.some(Boolean);
  for (const prototype of prototypes) delete (prototype as unknown as { move?: unknown }).move;
  try {
    return { ...(await runCase(name)), hadMove };
  } finally {
    prototypes.forEach((prototype, index) => {
      const descriptor = saved[index];
      if (descriptor) Object.defineProperty(prototype, 'move', descriptor);
    });
  }
}

// Shared folders, for the checks across stores and tabs.
const shared = new Map<string, OpfsFileStore>();
const heard: Array<{ folder: string; change: FileChange }> = [];

async function sharedStore(folder: string, channel = `files-harness:${folder}`): Promise<OpfsFileStore> {
  const key = `${folder}|${channel}`;
  let store = shared.get(key);
  if (!store) {
    const handle = await (await harnessRoot()).getDirectoryHandle(folder, { create: true });
    store = new OpfsFileStore(handle, { channel });
    shared.set(key, store);
  }
  return store;
}

const harness = {
  caseNames: fileStoreConformanceCases.map((testCase) => testCase.name),
  runCase,
  runCaseWithoutMove,
  runAll: () => runFileStoreConformance(freshStore, (store) => cleanup(store as OpfsFileStore)),
  async watch(folder: string, channel?: string): Promise<void> {
    (await sharedStore(folder, channel)).watch((change) => heard.push({ folder, change }));
  },
  async write(folder: string, path: string, text: string, channel?: string): Promise<void> {
    await (await sharedStore(folder, channel)).write(path, text);
  },
  async read(folder: string, path: string): Promise<string> {
    return (await sharedStore(folder)).readText(path);
  },
  heard: () => heard,
};

Object.assign(window, { filesHarness: harness, filesHarnessReady: true });
