/**
 * Where the browser tier keeps its tree: `nebula/` in the origin private file
 * system when OPFS really works here, and memory when it doesn't (private
 * browsing, Playwright's ephemeral WebKit). Then nothing is kept, and the UI
 * must say so (docs/slice-3.md, decision 8).
 */
import { blobToText } from './bytes';
import { MemoryFileStore } from './memoryStore';
import { OpfsFileStore } from './opfsStore';
import { webLocks, type LockManagerLike } from './locks';
import { PathLocks } from './pathLocks';
import { createBrowserRegistry, type BrowserRegistry } from './registry';

export type OpfsProbe = { ok: true; root: FileSystemDirectoryHandle } | { ok: false; reason: string };

export type BrowserRegistryHandle = {
  registry: BrowserRegistry;
  /** false when OPFS isn't available: projects live in memory and are gone when the tab closes. */
  persistent: boolean;
  /** Why nothing will be kept, when `persistent` is false. */
  reason?: string;
};

/** The folder under the OPFS root that holds registry.json and projects/. */
export const OPFS_TREE = 'nebula';
const PROBE_PREFIX = '.nebula-probe-';

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function defaultStorage(): StorageManager | undefined {
  return typeof navigator !== 'undefined' ? navigator.storage : undefined;
}

/** Whether OPFS really keeps files here: getDirectory(), then a createWritable
 * round trip on a scratch file, which is removed again. */
export async function probeOpfs(storage: StorageManager | undefined = defaultStorage()): Promise<OpfsProbe> {
  if (!storage || typeof storage.getDirectory !== 'function') {
    return { ok: false, reason: 'This browser has no origin private file system.' };
  }
  let root: FileSystemDirectoryHandle;
  try {
    root = await storage.getDirectory();
  } catch (error) {
    return { ok: false, reason: `The browser refused its file system (${describe(error)}).` };
  }
  const name = `${PROBE_PREFIX}${Math.random().toString(36).slice(2, 10)}`;
  try {
    const handle = await root.getFileHandle(name, { create: true });
    if (typeof handle.createWritable !== 'function') return { ok: false, reason: 'This browser cannot write files here (no createWritable).' };
    const writable = await handle.createWritable();
    await writable.write('nebula');
    await writable.close();
    const back = await blobToText(await handle.getFile());
    if (back !== 'nebula') return { ok: false, reason: 'A file written to the browser did not read back.' };
    return { ok: true, root };
  } catch (error) {
    return { ok: false, reason: `The browser could not keep a file (${describe(error)}).` };
  } finally {
    await root.removeEntry(name).catch(() => {});
  }
}

type IterableDirectory = FileSystemDirectoryHandle & { values(): AsyncIterable<FileSystemHandle> };

/** The registry on OPFS's `nebula/` tree, each project a store of its own
 * whose watchers hear the project's other tabs. The stores share one set of
 * path locks, so removing a project waits for its writes in flight. */
export async function createOpfsRegistry(root: FileSystemDirectoryHandle, options: { locks?: LockManagerLike | null } = {}): Promise<BrowserRegistry> {
  const tree = await root.getDirectoryHandle(OPFS_TREE, { create: true });
  const locks = new PathLocks();
  return createBrowserRegistry(new OpfsFileStore(tree, { channel: 'nebula:registry', locks: { locks, prefix: '' } }), {
    ...('locks' in options ? { locks: options.locks } : {}),
    async projectStore(dir, id) {
      const projects = await tree.getDirectoryHandle('projects', { create: true });
      return new OpfsFileStore(await projects.getDirectoryHandle(dir, { create: true }), {
        channel: `nebula:project:${id}`,
        locks: { locks, prefix: `projects/${dir}` },
      });
    },
    // The folder names alone, not every file of every project.
    async projectDirs() {
      let projects: FileSystemDirectoryHandle;
      try {
        projects = await tree.getDirectoryHandle('projects');
      } catch (error) {
        if (error instanceof DOMException && (error.name === 'NotFoundError' || error.name === 'TypeMismatchError')) return [];
        throw error;
      }
      const dirs: string[] = [];
      for await (const handle of (projects as IterableDirectory).values()) if (handle.kind === 'directory') dirs.push(handle.name);
      return dirs.sort();
    },
  });
}

/** Opens the browser tier: `const { registry, persistent } = await openBrowserRegistry()`.
 * OPFS is used only with Web Locks, which keep two tabs from writing
 * registry.json at once. Every engine with OPFS and createWritable has them;
 * one without keeps nothing rather than risk tabs undoing each other
 * (review finding 10; a lock file can outlive a crashed tab). */
export async function openBrowserRegistry(options: { storage?: StorageManager; locks?: LockManagerLike | null } = {}): Promise<BrowserRegistryHandle> {
  const probe = await probeOpfs('storage' in options ? options.storage : defaultStorage());
  const locks = 'locks' in options ? options.locks : webLocks();
  if (probe.ok && locks) return { registry: await createOpfsRegistry(probe.root, 'locks' in options ? { locks } : {}), persistent: true };
  return {
    registry: createBrowserRegistry(new MemoryFileStore(), { lockName: 'nebula:registry:memory' }),
    persistent: false,
    reason: probe.ok ? 'This browser has no Web Locks, so Nebula can’t keep its tabs from overwriting each other’s changes, and keeps nothing here.' : probe.reason,
  };
}
