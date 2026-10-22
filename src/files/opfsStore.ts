import { blobToText, holdsText } from './bytes';
import { EntryTypeError, FileChangedError, FileExistsError, FileNotFoundError, errorName } from './errors';
import { browserFileLocks, fileLockName, holdingListedFiles } from './fileLocks';
import { ChangeListeners } from './listeners';
import { InvalidPathError, basename, comparePaths, dirname, isInside, joinPath, normalizePath } from './paths';
import { PathLocks } from './pathLocks';
import type { FileChange, FileEntry, FileStore, WriteOptions } from './types';

export type OpfsFileStoreOptions = {
  /** BroadcastChannel name shared by every store of this project, in every
   * tab of the origin, so their watchers hear each other. Omit to stay local. */
  channel?: string;
  /** Changes to overlapping paths wait for each other (a rename or a remove
   * waits for the writes in flight inside it). Stores over one tree in this
   * tab can share these, each saying where its folder sits in the tree, so
   * the registry removing a project waits for that project's writes too. */
  locks?: { locks: PathLocks; prefix: string };
};

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

// Parts of the File System API that TypeScript's DOM library doesn't declare yet.
type IterableDirectory = FileSystemDirectoryHandle & { values(): AsyncIterable<Handle> };
type MovableHandle = FileSystemHandle & { move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void> };

type ChannelMessage = { nebulaFiles: 1; from: string; change: FileChange };

const HIDDEN = '.nebula';
const READ_ATTEMPTS = 4;
/** A new file's name while it's written (see writeNew). list() never shows these. */
const TEMP_PREFIX = '.nebula-write-';
/** A blob up to this size is read into memory while its file is locked; a
 * larger one (video, say) streams from the file as before. */
const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
/** A temporary file this old is left over from a tab that closed mid-write. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
/** What move() throws in engines that can't move this entry. */
const MOVE_UNSUPPORTED = new Set(['NotSupportedError', 'InvalidModificationError']);

function isChange(value: unknown): value is FileChange {
  if (typeof value !== 'object' || value === null) return false;
  const change = value as Record<string, unknown>;
  if (change.type === 'rename') return typeof change.from === 'string' && typeof change.to === 'string';
  return (change.type === 'write' || change.type === 'mkdir' || change.type === 'remove') && typeof change.path === 'string';
}

function isMessage(value: unknown): value is ChannelMessage {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.nebulaFiles === 1 && typeof message.from === 'string' && isChange(message.change);
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Writes `data` over the file through a writable, which replaces the file's
 * contents only when it closes. */
async function writeInto(handle: FileSystemFileHandle, data: string | Blob): Promise<void> {
  let writable: FileSystemWritableFileStream | undefined;
  try {
    writable = await handle.createWritable();
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable?.abort().catch(() => {});
    throw error;
  }
}

/** Turns OPFS's DOMExceptions into the store's errors, which name the path. */
function translate(error: unknown, path: string, expected: 'file' | 'folder' = 'file'): unknown {
  switch (errorName(error)) {
    case 'NotFoundError':
      return new FileNotFoundError(path);
    case 'TypeMismatchError':
      return new EntryTypeError(path, expected);
    default:
      return error;
  }
}

/** A FileStore over a directory of the origin private file system (OPFS).
 * Writes go through createWritable, which replaces the file when the stream
 * closes; a new file is written under a temporary name and moved into place.
 * Watchers hear changes from this store at once and, through a
 * BroadcastChannel, from every other store of the same project. */
export class OpfsFileStore implements FileStore {
  private readonly root: FileSystemDirectoryHandle;
  private readonly channelName: string | undefined;
  private readonly id = randomId();
  private readonly listeners = new ChangeListeners();
  private channel: BroadcastChannel | null = null;
  private readonly locks: PathLocks;
  private readonly lockPrefix: string;
  /** Files this store has read or written (see writeNow). */
  private readonly known = new Set<string>();

  constructor(root: FileSystemDirectoryHandle, options: OpfsFileStoreOptions = {}) {
    this.root = root;
    this.channelName = typeof BroadcastChannel === 'function' ? options.channel : undefined;
    this.locks = options.locks?.locks ?? new PathLocks();
    this.lockPrefix = options.locks?.prefix ?? '';
  }

  /** Runs a change once every earlier change to an overlapping path is done. */
  private exclusive<T>(paths: string[], action: () => Promise<T>): Promise<T> {
    return this.locks.run(
      paths.map((path) => (this.lockPrefix ? `${this.lockPrefix}/${path}` : path)),
      action,
    );
  }

  /**
   * Reads and writes of one file never overlap, in this tab or another: reads
   * share a Web Lock named for the file's place in the tree, and a write holds
   * it alone from createWritable() to close(). WebKit's getFile() isn't a
   * snapshot, so a read during a writable's close() can return old and new
   * bytes mixed, with no error. Every engine with OPFS writables has Web
   * Locks; without them (tests) the action runs as before.
   */
  private withFile<T>(path: string, mode: 'shared' | 'exclusive', action: () => Promise<T>): Promise<T> {
    const locks = browserFileLocks();
    if (!locks) return action();
    // request() resolves with what the callback's promise resolves with.
    return locks.request(fileLockName(this.place(path)), { mode }, action) as Promise<T>;
  }

  /** A path's place in the whole tree, which names its Web Lock. */
  private place(path: string): string {
    return this.lockPrefix ? `${this.lockPrefix}/${path}` : path;
  }

  /**
   * Runs a rename or a remove holding, exclusively, the Web Lock of every
   * file it moves (at both ends) or deletes (re-review R4), taken in sorted
   * order so two tabs can't deadlock. Another tab's write in flight to one of
   * them lands first; a write asked for later waits for the change.
   */
  private withFilesUnder<T>(root: string, to: string | null, action: () => Promise<T>): Promise<T> {
    const list = async (): Promise<string[]> => {
      const files = await this.filesUnder(root);
      const places = files.map((path) => this.place(path));
      return to === null ? places : [...places, ...files.map((path) => this.place(to + path.slice(root.length)))];
    };
    return Promise.resolve(holdingListedFiles(browserFileLocks(), list, action));
  }

  /** Every file at or under `path` (none when nothing is there), hidden
   * ones included; a new file's temporary name is left out (its writer
   * holds the lock of the name it will take). */
  private async filesUnder(path: string): Promise<string[]> {
    const handle = await this.handle(path);
    if (!handle) return [];
    if (handle.kind === 'file') return [path];
    const files: string[] = [];
    const walk = async (folder: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const child of (folder as IterableDirectory).values()) {
        const childPath = `${prefix}/${child.name}`;
        if (child.kind === 'directory') await walk(child as FileSystemDirectoryHandle, childPath);
        else if (!child.name.startsWith(TEMP_PREFIX)) files.push(childPath);
      }
    };
    await walk(handle as FileSystemDirectoryHandle, path);
    return files;
  }

  /** Paths under `root` this store knows, moved to `to` or (null) forgotten. */
  private moveKnown(root: string, to: string | null): void {
    for (const path of [...this.known]) {
      if (!isInside(path, root)) continue;
      this.known.delete(path);
      if (to !== null) this.known.add(to + path.slice(root.length));
    }
  }

  /** The folder at `path` ('' is the root). Missing folders are created when
   * `create` is set; otherwise NotFoundError. */
  private async folder(path: string, create: boolean): Promise<FileSystemDirectoryHandle> {
    let handle = this.root;
    if (path === '') return handle;
    let walked = '';
    for (const segment of path.split('/')) {
      walked = walked ? `${walked}/${segment}` : segment;
      try {
        handle = await handle.getDirectoryHandle(segment, { create });
      } catch (error) {
        throw translate(error, walked, 'folder');
      }
    }
    return handle;
  }

  /** The handle at `path`, or null when nothing (or a file above it) is there. */
  private async handle(path: string): Promise<Handle | null> {
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await this.folder(dirname(path), false);
    } catch (error) {
      if (errorName(error) === 'NotFoundError' || errorName(error) === 'TypeMismatchError') return null;
      throw error;
    }
    const name = basename(path);
    try {
      return await parent.getFileHandle(name);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') return null;
      if (errorName(error) !== 'TypeMismatchError') throw error;
    }
    try {
      return await parent.getDirectoryHandle(name);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') return null;
      throw error;
    }
  }

  private async fileHandle(path: string): Promise<FileSystemFileHandle> {
    const handle = await this.handle(normalizePath(path));
    if (!handle) throw new FileNotFoundError(path);
    if (handle.kind !== 'file') throw new EntryTypeError(path, 'file');
    return handle as FileSystemFileHandle;
  }

  /** The file's current contents. A File from getFile() is a snapshot that
   * Chromium refuses to read once the file is replaced, so a read that races
   * a write takes a fresh snapshot and tries again. */
  private async readFile<T>(path: string, read: (file: File) => Promise<T>): Promise<T> {
    return this.withFile(normalizePath(path), 'shared', async () => {
      for (let attempt = 1; ; attempt += 1) {
        const file = await (await this.fileHandle(path)).getFile();
        try {
          const result = await read(file);
          this.known.add(path);
          return result;
        } catch (error) {
          if (errorName(error) !== 'NotReadableError' || attempt >= READ_ATTEMPTS) throw error;
        }
      }
    });
  }

  private async entry(path: string, handle: Handle): Promise<FileEntry> {
    if (handle.kind === 'directory') return { path, name: basename(path), type: 'dir' };
    const file = await (handle as FileSystemFileHandle).getFile();
    return { path, name: basename(path), type: 'file', size: file.size, modified: file.lastModified };
  }

  private emit(change: FileChange): void {
    this.listeners.emit(change);
    if (!this.channelName) return;
    const message: ChannelMessage = { nebulaFiles: 1, from: this.id, change };
    // A short-lived channel posts; the long-lived one exists only while
    // someone watches. Messages posted before close() are still delivered.
    const channel = new BroadcastChannel(this.channelName);
    channel.postMessage(message);
    channel.close();
  }

  private openChannel(): void {
    if (this.channel || !this.channelName) return;
    this.channel = new BroadcastChannel(this.channelName);
    this.channel.onmessage = (event: MessageEvent) => {
      if (isMessage(event.data) && event.data.from !== this.id) this.listeners.emit(event.data.change);
    };
  }

  async list(): Promise<FileEntry[]> {
    const entries: FileEntry[] = [];
    const stale: Array<{ folder: FileSystemDirectoryHandle; name: string }> = [];
    const walk = async (folder: FileSystemDirectoryHandle, prefix: string): Promise<void> => {
      for await (const handle of (folder as IterableDirectory).values()) {
        const path = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (path === HIDDEN) continue;
        if (handle.kind === 'file' && handle.name.startsWith(TEMP_PREFIX)) {
          // A new file being written, or one a closed tab left half written.
          const file = await (handle as FileSystemFileHandle).getFile().catch(() => null);
          if (file && Date.now() - file.lastModified > STALE_TEMP_MS) stale.push({ folder, name: handle.name });
          continue;
        }
        entries.push(await this.entry(path, handle));
        if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, path);
      }
    };
    await walk(this.root, '');
    for (const { folder, name } of stale) await folder.removeEntry(name).catch(() => {});
    return entries.sort((a, b) => comparePaths(a.path, b.path));
  }

  async stat(path: string): Promise<FileEntry | null> {
    const handle = await this.handle(normalizePath(path));
    return handle ? this.entry(path, handle) : null;
  }

  async readText(path: string): Promise<string> {
    return this.readFile(path, (file) => blobToText(file));
  }

  async readBlob(path: string): Promise<Blob> {
    return this.readFile(path, async (file) => {
      // Read now, inside the lock, so a write after it can't change what the
      // caller reads later (a text file decoded from its bytes, a zip entry).
      if (file.size <= SNAPSHOT_MAX_BYTES) return new Blob([await file.arrayBuffer()], { type: file.type });
      // Fail now, not later in the caller, if the snapshot is already stale.
      await file.slice(0, 1).arrayBuffer();
      return file;
    });
  }

  async write(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    normalizePath(path);
    // One change at a time per path, and none inside a folder being renamed
    // or removed (WebKit also locks a file while a writable is open). The
    // file's Web Lock is held from the check to the write, so an exclusive
    // write in another tab can't pass the check too (round 4, F1).
    return this.exclusive([path], () => this.withFile(normalizePath(path), 'exclusive', () => this.writeNow(path, data, options)));
  }

  private async writeNow(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    const expected = options.ifUnchanged;
    // A file this store has seen whose folder is gone was moved or removed by
    // another tab: never bring the folder back (re-review R4). Only the first
    // write of a new file makes its folders; this one fails as not found. A
    // write expecting a text never makes folders: the file isn't there.
    const create = !this.known.has(path) && (expected === undefined || expected === 'absent');
    let parent: FileSystemDirectoryHandle;
    try {
      parent = await this.folder(dirname(path), create);
    } catch (error) {
      if (expected !== undefined && expected !== 'absent' && (errorName(error) === 'NotFoundError' || errorName(error) === 'TypeMismatchError')) {
        throw new FileChangedError(path, true);
      }
      throw error;
    }
    const name = basename(path);
    let existing: FileSystemFileHandle | null = null;
    let folderThere = false;
    try {
      existing = await parent.getFileHandle(name);
    } catch (error) {
      if (errorName(error) === 'TypeMismatchError') folderThere = true;
      else if (errorName(error) !== 'NotFoundError') throw error;
    }
    // Checked under the file's exclusive Web Lock, which this write holds
    // until it closes: no other write, in any tab, lands in between (round 5).
    if (expected === 'absent' && (existing || folderThere)) throw new FileChangedError(path);
    if (expected !== undefined && expected !== 'absent') {
      if (!existing) throw new FileChangedError(path, true);
      if (!(await holdsText(await existing.getFile(), expected.text))) throw new FileChangedError(path);
    }
    if (folderThere) throw options.exclusive ? new FileExistsError(path) : new EntryTypeError(path, 'file');
    if (existing && options.exclusive) throw new FileExistsError(path);
    // An existing file keeps its old contents until the writable closes.
    if (existing) await writeInto(existing, data);
    else await this.writeNew(parent, name, data);
    this.known.add(path);
    this.emit({ type: 'write', path });
  }

  /** A new file is written under a temporary name and moved into place, so
   * no reader, in this tab or another, sees it empty or half written (review
   * finding 11): a file made by getFileHandle() is there, empty, until its
   * writable closes. Where move() is missing, the finished file is copied
   * into place and the temporary one removed. */
  private async writeNew(parent: FileSystemDirectoryHandle, name: string, data: string | Blob): Promise<void> {
    const temp = `${TEMP_PREFIX}${randomId()}`;
    const handle = await parent.getFileHandle(temp, { create: true });
    try {
      await writeInto(handle, data);
      const move = (handle as MovableHandle).move;
      if (typeof move === 'function') {
        try {
          await move.call(handle, parent, name);
          return;
        } catch (error) {
          if (!MOVE_UNSUPPORTED.has(errorName(error) ?? '')) throw error;
        }
      }
      const target = await parent.getFileHandle(name, { create: true });
      try {
        await writeInto(target, await handle.getFile());
      } catch (error) {
        // Don't leave an empty file behind where nothing was before.
        await parent.removeEntry(name).catch(() => {});
        throw error;
      }
    } finally {
      // Gone already when it was moved.
      await parent.removeEntry(temp).catch(() => {});
    }
  }

  async mkdir(path: string): Promise<void> {
    normalizePath(path);
    return this.exclusive([path], async () => {
      const existing = await this.handle(path);
      if (existing?.kind === 'directory') return;
      if (existing) throw new EntryTypeError(path, 'folder');
      await this.folder(path, true);
      this.emit({ type: 'mkdir', path });
    });
  }

  async rename(from: string, to: string): Promise<void> {
    normalizePath(from);
    normalizePath(to);
    return this.exclusive([from, to], () => this.withFilesUnder(from, to, () => this.renameNow(from, to)));
  }

  private async renameNow(from: string, to: string): Promise<void> {
    const source = await this.handle(from);
    if (!source) throw new FileNotFoundError(from);
    if (await this.handle(to)) throw new FileExistsError(to);
    if (isInside(to, from)) throw new InvalidPathError(to, `inside ${JSON.stringify(from)}, the folder being moved`);
    const targetParent = await this.folder(dirname(to), true);
    const move = (source as MovableHandle).move;
    let moved = false;
    if (typeof move === 'function') {
      try {
        await move.call(source, targetParent, basename(to));
        moved = true;
      } catch (error) {
        // Some engines can't move folders yet: fall back to copying below.
        if (errorName(error) !== 'NotSupportedError' && errorName(error) !== 'InvalidModificationError') throw error;
      }
    }
    if (!moved) await this.copyThenRemove(from, to, source);
    this.moveKnown(from, to);
    this.emit({ type: 'rename', from, to });
  }

  private async copyThenRemove(from: string, to: string, source: Handle): Promise<void> {
    const copy = async (handle: Handle, target: string): Promise<void> => {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        const parent = await this.folder(dirname(target), true);
        const writable = await (await parent.getFileHandle(basename(target), { create: true })).createWritable();
        await writable.write(file);
        await writable.close();
        return;
      }
      await this.folder(target, true);
      for await (const child of (handle as IterableDirectory).values()) await copy(child, joinPath(target, child.name));
    };
    try {
      await copy(source, to);
    } catch (error) {
      // Leave the source as it was and take away the partial copy.
      await (await this.folder(dirname(to), false)).removeEntry(basename(to), { recursive: true }).catch(() => {});
      throw error;
    }
    await (await this.folder(dirname(from), false)).removeEntry(basename(from), { recursive: true });
  }

  async remove(path: string): Promise<void> {
    normalizePath(path);
    return this.exclusive([path], () =>
      this.withFilesUnder(path, null, async () => {
        if (!(await this.handle(path))) throw new FileNotFoundError(path);
        const parent = await this.folder(dirname(path), false);
        try {
          await parent.removeEntry(basename(path), { recursive: true });
        } catch (error) {
          throw translate(error, path);
        }
        this.moveKnown(path, null);
        this.emit({ type: 'remove', path });
      }),
    );
  }

  watch(listener: (change: FileChange) => void): () => void {
    this.openChannel();
    const stop = this.listeners.add(listener);
    return () => {
      stop();
      if (this.listeners.size === 0) this.close();
    };
  }

  /** Stops listening to other tabs until the next watch(). The store keeps working. */
  close(): void {
    this.channel?.close();
    this.channel = null;
  }
}
