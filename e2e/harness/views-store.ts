/**
 * A tiny in-memory FileStore for lane C's unit tests and harness page. Lane A
 * builds the real memory and OPFS stores in src/files; this one only has to
 * honour the contract in src/files/types.ts, plus a few test hooks:
 * unreadable paths, a write log, and synchronous peeks.
 */
import { holdsText } from '../../src/files/bytes';
import { FileChangedError } from '../../src/files/errors';
import type { FileChange, FileEntry, FileStore } from '../../src/files/types';

type Stored = { data: string | Blob; modified: number };

export type MemoryFileStore = FileStore & {
  /** Every write, in order: what was written where. */
  readonly writes: Array<{ path: string; data: string | Blob }>;
  /** Reads of these paths fail, as an unreadable file would. */
  readonly unreadable: Set<string>;
  /** The stored text, synchronously (undefined for missing files and blobs). */
  peek(path: string): string | undefined;
  /** Moves the clock the store stamps files with. */
  setNow(now: () => number): void;
};

const encoder = new TextEncoder();

function sizeOf(data: string | Blob): number {
  return typeof data === 'string' ? encoder.encode(data).length : data.size;
}

function blobText(blob: Blob): Promise<string> {
  if (typeof blob.text === 'function') return blob.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
}

function nameOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

function parentsOf(path: string): string[] {
  const parts = path.split('/');
  const parents: string[] = [];
  for (let index = 1; index < parts.length; index += 1) parents.push(parts.slice(0, index).join('/'));
  return parents;
}

export function createMemoryFileStore(initial: Record<string, string | Blob> = {}): MemoryFileStore {
  const files = new Map<string, Stored>();
  const dirs = new Set<string>();
  const listeners = new Set<(change: FileChange) => void>();
  const writes: Array<{ path: string; data: string | Blob }> = [];
  const unreadable = new Set<string>();
  let now = () => Date.now();

  const emit = (change: FileChange) => {
    for (const listener of [...listeners]) listener(change);
  };

  const put = (path: string, data: string | Blob) => {
    for (const parent of parentsOf(path)) dirs.add(parent);
    files.set(path, { data, modified: now() });
  };

  for (const [path, data] of Object.entries(initial)) put(path, data);

  const read = (path: string): Stored => {
    if (unreadable.has(path)) throw new Error(`Couldn't read ${path}`);
    const stored = files.get(path);
    if (!stored) throw new Error(`No file at ${path}`);
    return stored;
  };

  const entryFor = (path: string): FileEntry | null => {
    const stored = files.get(path);
    if (stored) return { path, name: nameOf(path), type: 'file', size: sizeOf(stored.data), modified: stored.modified };
    if (dirs.has(path)) return { path, name: nameOf(path), type: 'dir' };
    return null;
  };

  return {
    writes,
    unreadable,
    peek(path) {
      const data = files.get(path)?.data;
      return typeof data === 'string' ? data : undefined;
    },
    setNow(next) {
      now = next;
    },
    async list() {
      const paths = [...dirs, ...files.keys()].filter((path) => !path.startsWith('.nebula'));
      return paths
        .sort()
        .map((path) => entryFor(path))
        .filter((entry): entry is FileEntry => entry !== null);
    },
    async stat(path) {
      return entryFor(path);
    },
    async readText(path) {
      const { data } = read(path);
      return typeof data === 'string' ? data : blobText(data);
    },
    async readBlob(path) {
      const { data } = read(path);
      return typeof data === 'string' ? new Blob([data]) : data;
    },
    async write(path, data, options) {
      const expected = options?.ifUnchanged;
      if (expected === 'absent' && (files.has(path) || dirs.has(path))) throw new FileChangedError(path);
      if (expected !== undefined && expected !== 'absent') {
        const stored = files.get(path);
        if (!stored) throw new FileChangedError(path, true);
        const same = typeof stored.data === 'string' ? stored.data === expected.text : await holdsText(stored.data, expected.text);
        // A blob is compared over an await: the file must still be that one.
        if (!same || files.get(path) !== stored) throw new FileChangedError(path);
      }
      // Checked and written in one step: nothing awaits in between.
      if (options?.exclusive && (files.has(path) || dirs.has(path))) {
        throw Object.assign(new Error(`Something already exists at ${path}`), { name: 'FileExistsError' });
      }
      put(path, data);
      writes.push({ path, data });
      emit({ type: 'write', path });
    },
    async mkdir(path) {
      dirs.add(path);
      for (const parent of parentsOf(path)) dirs.add(parent);
      emit({ type: 'mkdir', path });
    },
    async rename(from, to) {
      if (files.has(to) || dirs.has(to)) throw new Error(`Something already exists at ${to}`);
      const stored = files.get(from);
      if (stored) {
        files.delete(from);
        for (const parent of parentsOf(to)) dirs.add(parent);
        files.set(to, stored);
      } else if (dirs.has(from)) {
        for (const [path, value] of [...files]) {
          if (!path.startsWith(`${from}/`)) continue;
          files.delete(path);
          files.set(`${to}${path.slice(from.length)}`, value);
        }
        for (const dir of [...dirs]) {
          if (dir !== from && !dir.startsWith(`${from}/`)) continue;
          dirs.delete(dir);
          dirs.add(`${to}${dir.slice(from.length)}`);
        }
      } else {
        throw new Error(`No file at ${from}`);
      }
      emit({ type: 'rename', from, to });
    },
    async remove(path) {
      files.delete(path);
      for (const key of [...files.keys()]) if (key.startsWith(`${path}/`)) files.delete(key);
      for (const dir of [...dirs]) if (dir === path || dir.startsWith(`${path}/`)) dirs.delete(dir);
      emit({ type: 'remove', path });
    },
    watch(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
