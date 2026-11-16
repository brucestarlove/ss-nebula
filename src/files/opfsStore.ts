import { blobToText, holdsText, sameBlobs } from './bytes';
import { EntryTypeError, FileChangedError, FileExistsError, FileNotFoundError, FolderTooBigError, MoveChangedError, errorName } from './errors';
import { browserFileLocks, fileLockName, holdingListedFiles, type FileLockManager } from './fileLocks';
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
  /** The cross-tab per-file locks: navigator.locks unless a test says
   * otherwise. Without them the store refuses every read and write: unlocked, a write's precondition is a check-then-write another tab
   * can slip into. */
  fileLocks?: FileLockManager | null;
  /** How list() walks a folder other apps change too (the folder tier). The
   * browser tier gives none and lists as it always has. */
  listing?: ListingOptions;
};

/** The folder tier's walk: names it never looks at, and
 * an entry that goes while it's listed is that entry gone. */
export type ListingOptions = {
  /** Left out of list(): never asked for its details, never walked into.
   * The root's `.nebula` is hidden as ever. */
  skip(name: string): boolean;
  /** The walk stops past this many entries (after `skip`), or after
   * `maxMs` of walking, with FolderTooBigError (S8). */
  maxEntries?: number;
  maxMs?: number;
};

/** Thrown by an OpfsFileStore with no Web Locks. */
export class NoWebLocksError extends Error {
  constructor() {
    super('This browser has no Web Locks, so files can’t be kept safe from another tab’s changes.');
    this.name = 'NoWebLocksError';
  }
}

type Handle = FileSystemFileHandle | FileSystemDirectoryHandle;

// Parts of the File System API that TypeScript's DOM library doesn't declare yet.
type IterableDirectory = FileSystemDirectoryHandle & { values(): AsyncIterable<Handle> };
type MovableHandle = FileSystemHandle & { move?: (parent: FileSystemDirectoryHandle, name: string) => Promise<void> };

type ChannelMessage = { nebulaFiles: 1; from: string; change: FileChange };

const HIDDEN = '.nebula';
const READ_ATTEMPTS = 4;
/** A new file's name while it's written (see writeNew). list() never shows these. */
const TEMP_PREFIX = '.nebula-write-';
/** Chrome's swap file for a save in progress. */
/** A blob up to this size is read into memory while its file is locked; a
 * larger one (video, say) streams from the file as before. */
const SNAPSHOT_MAX_BYTES = 16 * 1024 * 1024;
/** A temporary file this old is left over from a tab that closed mid-write. */
const STALE_TEMP_MS = 24 * 60 * 60 * 1000;
/** What an entry that went mid-walk fails with (the folder tier's walk):
 * that entry is skipped, and the root is looked at again. */
const VANISHED = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'InvalidStateError']);
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

const MOVE_STATES = new Set(['moving', 'moved', 'move-failed']);

/** registry.ts's MoveMessage: `{ nebulaMove: 1, state }`. */
function isMoveMessage(value: unknown): value is { nebulaMove: 1; state: 'moving' | 'moved' | 'move-failed' } {
  if (typeof value !== 'object' || value === null) return false;
  const message = value as Record<string, unknown>;
  return message.nebulaMove === 1 && typeof message.state === 'string' && MOVE_STATES.has(message.state);
}

function randomId(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** Whether two handles are one entry on the disk (isSameEntry, where the
 * engine has it). */
async function sameEntry(a: Handle, b: Handle): Promise<boolean> {
  const check = (a as { isSameEntry?: (other: Handle) => Promise<boolean> }).isSameEntry;
  if (typeof check !== 'function') return false;
  try {
    return await check.call(a, b);
  } catch {
    return false;
  }
}

/** Whether anything, file or folder, has the name in `parent` now. */
async function taken(parent: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  for (const look of [() => parent.getFileHandle(name), () => parent.getDirectoryHandle(name)]) {
    try {
      await look();
      return true;
    } catch (error) {
      if (errorName(error) !== 'NotFoundError' && errorName(error) !== 'TypeMismatchError') throw error;
      if (errorName(error) === 'TypeMismatchError') return true;
    }
  }
  return false;
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
  private readonly fileLocks: FileLockManager | null;
  /** Files this store has read or written (see writeNow). */
  private readonly known = new Set<string>();
  private readonly listing: ListingOptions | null;
  /** The stale swap files were looked for (once per store, S15). */

  constructor(root: FileSystemDirectoryHandle, options: OpfsFileStoreOptions = {}) {
    this.root = root;
    this.listing = options.listing ?? null;
    this.channelName = typeof BroadcastChannel === 'function' ? options.channel : undefined;
    this.locks = options.locks?.locks ?? new PathLocks();
    this.lockPrefix = options.locks?.prefix ?? '';
    this.fileLocks = 'fileLocks' in options ? (options.fileLocks ?? null) : browserFileLocks();
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
   * Locks; without them nothing runs (round 6, H10: fail closed), and the
   * OPFS probe has already sent Nebula to memory.
   */
  private withFile<T>(path: string, mode: 'shared' | 'exclusive', action: () => Promise<T>): Promise<T> {
    const locks = this.fileLocks;
    if (!locks) return Promise.reject(new NoWebLocksError());
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
    if (!this.fileLocks) return Promise.reject(new NoWebLocksError());
    return Promise.resolve(holdingListedFiles(this.fileLocks, list, action));
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
      // Move to a folder…, said by the tab moving the project (S3).
      else if (isMoveMessage(event.data)) this.listeners.emit({ type: event.data.state });
    };
  }

  async list(): Promise<FileEntry[]> {
    if (this.listing) return this.listFolder(this.listing);
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

  /** The folder tier's walk (S1): a skipped name is never looked at, and an
   * entry that goes mid-walk (a save's swap file moved into place, a file or
   * folder another app deletes) is left out. Only the root decides that the
   * folder is gone: when anything went, the root is read once more, and a
   * root that's gone fails the whole listing, so no removals are guessed
   * from a walk of a folder that went. */
  private async listFolder(listing: ListingOptions): Promise<FileEntry[]> {
    let vanished = false;
    let count = 0;
    const started = Date.now();
    const max = listing.maxEntries ?? Infinity;
    const tooBig = () => new FolderTooBigError(this.root.name, listing.maxEntries ?? 10_000);
    const walk = async (folder: FileSystemDirectoryHandle, prefix: string, into: FileEntry[]): Promise<void> => {
      for await (const handle of (folder as IterableDirectory).values()) {
        const path = prefix ? `${prefix}/${handle.name}` : handle.name;
        if (path === HIDDEN || handle.name.startsWith(TEMP_PREFIX) || listing.skip(handle.name)) continue;
        count += 1;
        if (count > max || (listing.maxMs !== undefined && Date.now() - started > listing.maxMs)) throw tooBig();
        try {
          const own = [await this.entry(path, handle)];
          if (handle.kind === 'directory') await walk(handle as FileSystemDirectoryHandle, path, own);
          for (const entry of own) into.push(entry);
        } catch (error) {
          if (!VANISHED.has(errorName(error) ?? '')) throw error;
          vanished = true;
        }
      }
    };
    const entries: FileEntry[] = [];
    await walk(this.root, '', entries);
    if (vanished) {
      const iterator = (this.root as IterableDirectory).values()[Symbol.asyncIterator]();
      await iterator.next();
      await iterator.return?.();
    }
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
    // write in another tab can't pass the check too.
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
    // until it closes: no other write, in any tab, lands in between.
    if (expected === 'absent' && (existing || folderThere)) throw new FileChangedError(path);
    if (expected !== undefined && expected !== 'absent') {
      if (!existing) throw new FileChangedError(path, true);
      if (!(await holdsText(await existing.getFile(), expected.text))) throw new FileChangedError(path);
    }
    if (folderThere) throw options.exclusive ? new FileExistsError(path) : new EntryTypeError(path, 'file');
    if (existing && options.exclusive) throw new FileExistsError(path);
    // An existing file keeps its old contents until the writable closes.
    if (existing) await writeInto(existing, data);
    else await this.writeNew(parent, name, data, path);
    this.known.add(path);
    this.emit({ type: 'write', path });
  }

  /** A new file is written under a temporary name and moved into place, so
   * no reader, in this tab or another, sees it empty or half written: a file made by getFileHandle() is there, empty, until its
   * writable closes. Where move() is missing, the finished file is copied
   * into place and the temporary one removed. */
  private async writeNew(parent: FileSystemDirectoryHandle, name: string, data: string | Blob, path = name): Promise<void> {
    const temp = `${TEMP_PREFIX}${randomId()}`;
    const handle = await parent.getFileHandle(temp, { create: true });
    try {
      await writeInto(handle, data);
      // Checked again right before the move, under the same lock (S10): an
      // app that made this name while the file was written (a folder on
      // disk; nothing in OPFS does) is never replaced.
      if (await taken(parent, name)) throw new FileExistsError(path);
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
    const existing = await this.handle(to);
    if (existing) {
      // On a case-insensitive disk (macOS, Windows) `a.md` finds `A.md`: the
      // same entry, so it may take the other case (S13). Anything else there
      // is refused, as is a rename to the very same name.
      if (from === to || dirname(from) !== dirname(to) || !(await sameEntry(source, existing))) throw new FileExistsError(to);
      await this.changeCase(from, to, source);
      return;
    }
    if (isInside(to, from)) throw new InvalidPathError(to, `inside ${JSON.stringify(from)}, the folder being moved`);
    await this.relocate(from, to, source);
    this.moveKnown(from, to);
    this.emit({ type: 'rename', from, to });
  }

  /** Moves the entry to `to`, with move() where the engine has one that can,
   * else by copying and removing (copyThenRemove). */
  private async relocate(from: string, to: string, source: Handle): Promise<void> {
    const targetParent = await this.folder(dirname(to), true);
    const move = (source as MovableHandle).move;
    if (typeof move === 'function') {
      try {
        await move.call(source, targetParent, basename(to));
        return;
      } catch (error) {
        // Some engines can't move folders yet: fall back to copying below.
        if (errorName(error) !== 'NotSupportedError' && errorName(error) !== 'InvalidModificationError') throw error;
      }
    }
    await this.copyThenRemove(from, to, source);
  }

  /** `a.md` to `A.md` where both are one entry: through a temporary name
   * next to it, which is visible, not hidden, so that a crash between the
   * two steps never hides a person's file. A failure on the way puts the
   * entry back under its own name. */
  private async changeCase(from: string, to: string, source: Handle): Promise<void> {
    const temp = joinPath(dirname(from), `${basename(to)}.${randomId().slice(0, 6)}.renaming`);
    await this.relocate(from, temp, source);
    try {
      const moved = await this.handle(temp);
      if (!moved) throw new FileNotFoundError(temp);
      await this.relocate(temp, to, moved);
    } catch (error) {
      const stranded = await this.handle(temp).catch(() => null);
      if (stranded) await this.relocate(temp, from, stranded).catch(() => {});
      throw error;
    }
    this.moveKnown(from, to);
    this.emit({ type: 'rename', from, to });
  }

  /**
   * Moves by copying, where the engine can't move (Chromium has no move()
   * on a folder: probed, e2e/folder-store.spec.ts) (S14). It removes only
   * what it copied and checked, never the source recursively:
   *
   * 1. every file is copied to a name that is free (never over a file),
   *    keeping a list of what it made;
   * 2. every copy is compared with the file now in the source; one that
   *    differs means another app changed it, and the copy is taken away (only
   *    the files and folders this made, and only a file still holding what
   *    it wrote) with the source untouched: MoveChangedError;
   * 3. each source file is compared again just before it goes, and only a
   *    file equal to its copy is removed; then each folder it leaves empty
   *    (not recursively, so a file another app added meanwhile stays, with
   *    its folders).
   */
  private async copyThenRemove(from: string, to: string, source: Handle): Promise<void> {
    type Dir = FileSystemDirectoryHandle;
    // What this made in the new place, and for a file the source it copies.
    const made: Array<{ parent: Dir; name: string; file?: { size: number; modified: number } }> = [];
    const pairs: Array<{ from: FileSystemFileHandle; to: FileSystemFileHandle; parent: Dir; name: string; path: string }> = [];
    const sourceDirs: Array<{ parent: Dir; name: string }> = [];

    const copy = async (handle: Handle, from: { parent: Dir; name: string }, into: { parent: Dir; name: string }, path: string): Promise<void> => {
      if (handle.kind === 'file') {
        const file = await (handle as FileSystemFileHandle).getFile();
        if (await taken(into.parent, into.name)) throw new FileExistsError(joinPath(dirname(to), path || basename(to)));
        const target = await into.parent.getFileHandle(into.name, { create: true });
        const record: { parent: Dir; name: string; file: { size: number; modified: number } } = { ...into, file: { size: 0, modified: 0 } };
        made.push(record);
        await writeInto(target, file);
        const written = await target.getFile();
        record.file = { size: written.size, modified: written.lastModified };
        pairs.push({ from: handle as FileSystemFileHandle, to: target, parent: from.parent, name: from.name, path });
        return;
      }
      let folder: Dir;
      try {
        folder = await into.parent.getDirectoryHandle(into.name);
      } catch (error) {
        if (errorName(error) !== 'NotFoundError') throw error;
        folder = await into.parent.getDirectoryHandle(into.name, { create: true });
        made.push(into);
      }
      sourceDirs.push(from);
      for await (const child of (handle as IterableDirectory).values()) {
        await copy(child, { parent: handle as Dir, name: child.name }, { parent: folder, name: child.name }, joinPath(path, child.name));
      }
    };

    /** Takes away what this copied: only a file still as it was written,
     * then the folders it made, which stay if anything is in them. */
    const undo = async (): Promise<void> => {
      for (const item of [...made].reverse()) {
        try {
          if (item.file) {
            // Ours if it is as it was when written (size and time), or
            // still empty because its write failed.
            const now = await (await item.parent.getFileHandle(item.name)).getFile();
            if (now.size === 0 || (now.size === item.file.size && now.lastModified === item.file.modified)) await item.parent.removeEntry(item.name);
          } else await item.parent.removeEntry(item.name);
        } catch {
          // Gone already, or not empty (another app's file is in it): stays.
        }
      }
    };

    const sourceParent = await this.folder(dirname(from), false);
    const targetParent = await this.folder(dirname(to), true);
    try {
      await copy(source, { parent: sourceParent, name: basename(from) }, { parent: targetParent, name: basename(to) }, '');
      // Every copy is what the source holds now (S14).
      for (const pair of pairs) {
        const [original, copied] = await Promise.all([pair.from.getFile(), pair.to.getFile()]).catch(() => {
          throw new MoveChangedError(joinPath(from, pair.path));
        });
        if (!(await sameBlobs(original, copied).catch(() => false))) throw new MoveChangedError(joinPath(from, pair.path));
      }
    } catch (error) {
      await undo();
      throw error;
    }
    // Only now does anything of the source go, file by file, each compared
    // again first.
    for (const pair of pairs) {
      try {
        const [original, copied] = await Promise.all([pair.from.getFile(), pair.to.getFile()]);
        if (!(await sameBlobs(original, copied))) throw new MoveChangedError(joinPath(from, pair.path));
        await pair.parent.removeEntry(pair.name);
      } catch (error) {
        if (errorName(error) === 'NotFoundError') continue;
        console.warn('Nebula kept a file where it was: it changed while its folder was being moved', joinPath(from, pair.path), error);
      }
    }
    for (const dir of [...sourceDirs].reverse()) {
      try {
        // Not recursive: a folder another app put something in stays.
        await dir.parent.removeEntry(dir.name);
      } catch {
        // Not empty, or gone already.
      }
    }
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
