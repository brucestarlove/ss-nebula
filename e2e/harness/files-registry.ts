// Served by the Vite dev server for e2e/files-registry.spec.ts (and the other
// files-* specs): the browser registry, migration, sample and zip, driven
// from Playwright through window.filesRegistry.
import { readObsidianExcalidrawMarkdown } from '../../src/nebula/excalidraw/obsidianMarkdown';
import { migrateLegacyCanvases } from '../../src/files/migration';
import { openBrowserRegistry, OPFS_TREE } from '../../src/files/opfsRegistry';
import { requestPersistentStorage, storageStatus } from '../../src/files/persist';
import type { BrowserRegistry } from '../../src/files/registry';
import { seedSampleProject } from '../../src/files/sample';
import { projectToZip } from '../../src/files/zip';
import type { FileChange, FileStore } from '../../src/files/types';

let registry: BrowserRegistry | null = null;
let persistent = false;
const stores = new Map<string, FileStore>();
const heard: Array<{ id: string; change: FileChange }> = [];

function opened(): BrowserRegistry {
  if (!registry) throw new Error('Call open() first');
  return registry;
}

async function store(id: string): Promise<FileStore> {
  let found = stores.get(id);
  if (!found) {
    found = await opened().open(id);
    stores.set(id, found);
  }
  return found;
}

async function walk(folder: FileSystemDirectoryHandle, prefix: string, into: string[]): Promise<string[]> {
  for await (const handle of (folder as FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> }).values()) {
    const path = prefix ? `${prefix}/${handle.name}` : handle.name;
    into.push(handle.kind === 'directory' ? `${path}/` : path);
    if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, path, into);
  }
  return into;
}

/** Reads a file under its shared Web Lock, as Nebula does (see e2e/app-fixtures.ts:
 * WebKit can show a file empty to a read while a write closes). */
async function readOpfs(path: string): Promise<string> {
  const read = async (): Promise<string> => {
    let folder = await navigator.storage.getDirectory();
    const segments = path.split('/');
    for (const segment of segments.slice(0, -1)) folder = await folder.getDirectoryHandle(segment);
    return (await (await folder.getFileHandle(segments.at(-1) as string)).getFile()).text();
  };
  const tree = `${OPFS_TREE}/`;
  if (!path.startsWith(tree)) return read();
  return navigator.locks.request(`nebula:file:${path.slice(tree.length)}`, { mode: 'shared' }, read);
}

const harness = {
  async open(): Promise<{ persistent: boolean; reason?: string }> {
    const handle = await openBrowserRegistry();
    registry = handle.registry;
    persistent = handle.persistent;
    stores.clear();
    return { persistent: handle.persistent, reason: handle.reason };
  },
  /** Removes the whole browser tier, for a clean start. */
  async wipe(): Promise<void> {
    await (await navigator.storage.getDirectory()).removeEntry(OPFS_TREE, { recursive: true }).catch(() => {});
  },
  create: (name: string, color: string) => opened().create({ name, color }),
  list: () => opened().list(),
  current: () => opened().current(),
  update: (id: string, patch: { name?: string; color?: string }) => opened().update(id, patch),
  remove: (id: string) => opened().remove(id),
  async write(id: string, path: string, text: string): Promise<void> {
    await (await store(id)).write(path, text);
  },
  async read(id: string, path: string): Promise<string> {
    return (await store(id)).readText(path);
  },
  async paths(id: string): Promise<string[]> {
    return (await (await store(id)).list()).map((entry) => entry.path);
  },
  async watch(id: string): Promise<void> {
    (await store(id)).watch((change) => heard.push({ id, change }));
  },
  heard: () => heard,
  seedSample: () => seedSampleProject(opened()),
  storage: async () => ({ requested: await requestPersistentStorage(), status: await storageStatus() }),
  /** The project as a .zip, base64 for the trip back to Node. */
  async zip(id: string, folder?: string): Promise<string> {
    const bytes = new Uint8Array(await (await projectToZip(await opened().files(id), { folder })).arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return btoa(binary);
  },
  async entries(id: string): Promise<Array<{ path: string; type: string; size?: number }>> {
    return (await (await store(id)).list()).map(({ path, type, size }) => ({ path, type, size }));
  },
  async migrate(seed: Record<string, string>) {
    for (const [key, value] of Object.entries(seed)) localStorage.setItem(key, value);
    return migrateLegacyCanvases({ storage: localStorage, registry: opened(), persistent });
  },
  localStorage: () => Object.fromEntries(Object.keys(localStorage).map((key) => [key, localStorage.getItem(key)])),
  clearLocalStorage: () => localStorage.clear(),
  async canvas(id: string, path: string) {
    const scene = readObsidianExcalidrawMarkdown(await (await store(id)).readText(path));
    return { elements: scene.elements, files: scene.files };
  },
  /** Every path in the origin's file system under nebula/. */
  opfsTree: async () => walk(await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_TREE), '', []),
  readOpfs,
  /** Deletes a project's folder behind the registry's back. */
  async dropFolder(id: string): Promise<void> {
    const registryJson = JSON.parse(await readOpfs(`${OPFS_TREE}/registry.json`)) as { projects: Array<{ id: string; dir: string }> };
    const dir = registryJson.projects.find((project) => project.id === id)?.dir;
    if (!dir) throw new Error(`${id} is not registered`);
    const projects = await (await (await navigator.storage.getDirectory()).getDirectoryHandle(OPFS_TREE)).getDirectoryHandle('projects');
    await projects.removeEntry(dir, { recursive: true });
  },
};

Object.assign(window, { filesRegistry: harness, filesHarnessReady: true });
