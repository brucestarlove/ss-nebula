import { blobToText, holdsText } from './bytes';
import { ChangeListeners } from './listeners';
import { EntryTypeError, FileChangedError, FileExistsError, FileNotFoundError } from './errors';
import { PageLockManager, holdingListedFiles } from './fileLocks';
import { InvalidPathError, ancestors, basename, comparePaths, dirname, isInside, normalizePath } from './paths';
import { PathLocks } from './pathLocks';
import type { FileChange, FileEntry, FileStore, WriteOptions } from './types';

type Node = { type: 'dir' } | { type: 'file'; data: Blob; modified: number };

const HIDDEN = '.nebula';

export type MemoryFileStoreOptions = {
  /** Called as each change is about to apply, with the change it will make.
   * What it returns is awaited first, so a test can make changes take time
   * (or hold one in flight) the way a real disk does. Without it, every change
   * applies at once, inside the call. */
  delay?: (change: FileChange) => Promise<void> | void;
};

/** What twins share: the files, the watchers and the per-file locks, as
 * stores of one project in two tabs share OPFS, a BroadcastChannel and Web
 * Locks. */
type Shared = { nodes: Map<string, Node>; listeners: ChangeListeners; fileLocks: PageLockManager };

/** A FileStore held in memory: tests, and the browser tier when OPFS can't keep anything. */
export class MemoryFileStore implements FileStore {
  private readonly nodes: Map<string, Node>;
  private readonly listeners: ChangeListeners;
  private readonly fileLocks: PageLockManager;
  private readonly locks = new PathLocks();
  private readonly delay: MemoryFileStoreOptions['delay'];
  /** Files this store has read or written (see write()). */
  private readonly known = new Set<string>();

  constructor(options: MemoryFileStoreOptions = {}, shared?: Shared) {
    this.delay = options.delay;
    this.nodes = shared?.nodes ?? new Map();
    this.listeners = shared?.listeners ?? new ChangeListeners();
    this.fileLocks = shared?.fileLocks ?? new PageLockManager();
  }

  /** Another store over the same files, as another tab's store of this
   * project is: it sees every file, and the watchers of each hear the other's
   * changes, but it keeps its own path locks, its own delay and its own idea
   * of which files it has seen. Tests use it to play two tabs. */
  twin(options: MemoryFileStoreOptions = {}): MemoryFileStore {
    return new MemoryFileStore(options, { nodes: this.nodes, listeners: this.listeners, fileLocks: this.fileLocks });
  }

  private entry(path: string, node: Node): FileEntry {
    return node.type === 'file'
      ? { path, name: basename(path), type: 'file', size: node.data.size, modified: node.modified }
      : { path, name: basename(path), type: 'dir' };
  }

  /** Creates the folders above `path`; rejects when one of them is a file. */
  private makeParents(path: string): void {
    const parents = ancestors(path);
    for (const parent of parents) {
      if (this.nodes.get(parent)?.type === 'file') throw new EntryTypeError(parent, 'folder');
    }
    for (const parent of parents) if (!this.nodes.has(parent)) this.nodes.set(parent, { type: 'dir' });
  }

  private file(path: string): Extract<Node, { type: 'file' }> {
    const node = this.nodes.get(normalizePath(path));
    if (!node) throw new FileNotFoundError(path);
    if (node.type !== 'file') throw new EntryTypeError(path, 'file');
    return node;
  }

  /** The files a change holds: the one written, or every file a rename
   * moves (at both ends) or a remove deletes. */
  private filesOf(change: FileChange): string[] {
    if (change.type === 'mkdir') return [];
    if (change.type === 'write') return [change.path];
    const root = change.type === 'rename' ? change.from : change.path;
    const files = [...this.nodes.entries()].filter(([path, node]) => node.type === 'file' && isInside(path, root)).map(([path]) => path);
    return change.type === 'rename' ? [...files, ...files.map((path) => change.to + path.slice(root.length))] : files;
  }

  /** Runs `apply` once every earlier change to an overlapping path has
   * settled, every file it touches is free in every twin, and the delay (if
   * any) has passed; at once otherwise, so that without a delay the change is
   * made inside the call. */
  private change<T>(change: FileChange, apply: () => T): Promise<T> {
    const paths = change.type === 'rename' ? [change.from, change.to] : [change.path];
    return this.locks.run(paths, () =>
      holdingListedFiles(this.fileLocks, () => this.filesOf(change), () => {
        const waiting = this.delay?.(change);
        return waiting ? waiting.then(apply) : apply();
      }),
    );
  }

  /** Paths under `root` this store knows, moved to `to` or (null) forgotten. */
  private moveKnown(root: string, to: string | null): void {
    for (const path of [...this.known]) {
      if (!isInside(path, root)) continue;
      this.known.delete(path);
      if (to !== null) this.known.add(to + path.slice(root.length));
    }
  }

  async list(): Promise<FileEntry[]> {
    return [...this.nodes.entries()]
      .filter(([path]) => path !== HIDDEN && !path.startsWith(`${HIDDEN}/`))
      .sort(([a], [b]) => comparePaths(a, b))
      .map(([path, node]) => this.entry(path, node));
  }

  async stat(path: string): Promise<FileEntry | null> {
    const node = this.nodes.get(normalizePath(path));
    return node ? this.entry(path, node) : null;
  }

  async readText(path: string): Promise<string> {
    const text = blobToText(this.file(path).data);
    this.known.add(path);
    return text;
  }

  async readBlob(path: string): Promise<Blob> {
    const data = this.file(path).data;
    this.known.add(path);
    return data;
  }

  async write(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    normalizePath(path);
    return this.change({ type: 'write', path }, () => {
      // Checked and written in one step, under the file's lock in every twin.
      const expected = options.ifUnchanged;
      if (expected === undefined) return this.writeNow(path, data, options);
      const node = this.nodes.get(path);
      if (expected === 'absent') {
        if (node) throw new FileChangedError(path);
        return this.writeNow(path, data, options);
      }
      if (node?.type !== 'file') throw new FileChangedError(path, true);
      // The bytes are read while the lock is held: nothing lands meanwhile.
      return holdsText(node.data, expected.text).then((same) => {
        if (!same || this.nodes.get(path) !== node) throw new FileChangedError(path);
        this.writeNow(path, data, options);
      });
    });
  }

  private writeNow(path: string, data: string | Blob, options: WriteOptions): void {
    if (options.exclusive && this.nodes.has(path)) throw new FileExistsError(path);
    if (this.nodes.get(path)?.type === 'dir') throw new EntryTypeError(path, 'file');
    // A file this store has seen whose folder is gone was moved or removed
    // by another store (tab): never bring the folder back (re-review R4).
    // Only the first write of a new file makes its folders.
    const parent = dirname(path);
    if (parent && this.known.has(path) && !this.nodes.has(parent)) throw new FileNotFoundError(parent);
    this.makeParents(path);
    this.nodes.set(path, { type: 'file', data: typeof data === 'string' ? new Blob([data]) : data, modified: Date.now() });
    this.known.add(path);
    this.listeners.emit({ type: 'write', path });
  }

  async mkdir(path: string): Promise<void> {
    normalizePath(path);
    return this.change({ type: 'mkdir', path }, () => {
      const node = this.nodes.get(path);
      if (node?.type === 'file') throw new EntryTypeError(path, 'folder');
      this.makeParents(path);
      if (node) return;
      this.nodes.set(path, { type: 'dir' });
      this.listeners.emit({ type: 'mkdir', path });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    normalizePath(from);
    normalizePath(to);
    return this.change({ type: 'rename', from, to }, () => {
      if (!this.nodes.has(from)) throw new FileNotFoundError(from);
      if (this.nodes.has(to)) throw new FileExistsError(to);
      if (isInside(to, from)) throw new InvalidPathError(to, `inside ${JSON.stringify(from)}, the folder being moved`);
      this.makeParents(to);
      const moving = [...this.nodes.entries()].filter(([path]) => isInside(path, from));
      for (const [path] of moving) this.nodes.delete(path);
      for (const [path, node] of moving) this.nodes.set(to + path.slice(from.length), node);
      this.moveKnown(from, to);
      this.listeners.emit({ type: 'rename', from, to });
    });
  }

  async remove(path: string): Promise<void> {
    normalizePath(path);
    return this.change({ type: 'remove', path }, () => {
      if (!this.nodes.has(path)) throw new FileNotFoundError(path);
      for (const key of [...this.nodes.keys()]) if (isInside(key, path)) this.nodes.delete(key);
      this.moveKnown(path, null);
      this.listeners.emit({ type: 'remove', path });
    });
  }

  watch(listener: (change: FileChange) => void): () => void {
    return this.listeners.add(listener);
  }
}
