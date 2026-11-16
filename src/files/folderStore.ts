/**
 * The folder tier's FileStore: a project in a folder on
 * this computer, picked with showDirectoryPicker().
 *
 * A picked folder is a FileSystemDirectoryHandle, as an OPFS folder is, so
 * the reads and writes are OpfsFileStore's, unchanged: whole-file
 * replacement through createWritable (on a local file Chrome writes
 * `<name>.crswap` and moves it into place on close), `exclusive` creates and
 * `ifUnchanged` writes checked under the file's Web Lock, renames that refuse
 * an existing target. This class adds what a folder needs on top:
 *
 * - Chrome's swap files stay out of the list.
 * - Changes from outside Nebula. Another app (an editor, Obsidian, a drive's
 *   sync) can change the folder at any moment, never takes Nebula's locks
 *   and never tells its tabs. While someone watches, the store lists the
 *   folder again when the tab comes back into view or the window gains
 *   focus, every few seconds while the tab is visible, and whenever
 *   FileSystemObserver (where the browser has it) says something changed:
 *   then only the paths its records name are checked, and the whole folder
 *   is walked only when a record can't say (observedPaths);
 *   it compares each file's size and modified time with the last listing,
 *   and tells its watchers what was added, changed or removed, as the other
 *   tiers tell theirs.
 * - A folder Nebula can't reach (moved, deleted, a drive unplugged,
 *   permission taken back) is `unreachable`, said once two looks in a row
 *   fail at its root and the folder itself (folderAccess) says so; the first
 *   good look after says `reachable`, then what changed meanwhile. Never a
 *   remove of '': that means the project was removed.
 * - Names it never looks at (isSkippedInFolder): dot-entries, node_modules,
 *   OS metadata files, Chrome's swap files and Nebula's temporary ones.
 *
 * What it can't see: a change that keeps a file's size and modified time
 * (rare: same size in the same millisecond) shows only with the next one.
 * A save is never written over such a change, though: `ifUnchanged`
 * compares content, under the file's lock, just before writing.
 */
import { folderAccess, isSkippedInFolder, isSkippedPathInFolder } from './folderTier';

export { isSkippedInFolder };
import { ChangeListeners } from './listeners';
import { FolderTooBigError, errorName } from './errors';
import { OpfsFileStore } from './opfsStore';

export { FolderTooBigError };
/** The most entries (after the name filters) a folder project shows, and
 * the longest a walk may take (S8). */
export const FOLDER_MAX_ENTRIES = 10_000;
export const FOLDER_MAX_WALK_MS = 2000;
import { isInside } from './paths';
import { PathLocks } from './pathLocks';
import { isProjectSignal, type FileChange, type FileEntry, type FileStore, type FolderHandle, type WriteOptions } from './types';

function skippedPath(path: string): boolean {
  return isSkippedPathInFolder(path);
}

/** The most paths an observer's records may name before the whole folder is
 * walked instead: past it, one walk costs less than that many looks. */
const MAX_OBSERVED_PATHS = 200;

/** What a batch of FileSystemObserver records asks for (probed on Chromium
 * 156, e2e/folder-store.spec.ts): the paths they name, skipped names left
 * out, or `null` when the whole folder has to be walked because a record
 * can't say (no usable path, the root itself, `unknown`, `errored`, a move
 * that doesn't say from where). */
export function observedPaths(records: unknown[]): string[] | null {
  const paths = new Set<string>();
  const parse = (value: unknown): string | null => {
    if (!Array.isArray(value) || value.length === 0 || !value.every((part) => typeof part === 'string' && part !== '')) return null;
    return (value as string[]).join('/');
  };
  for (const item of records) {
    const record = item as { type?: unknown; relativePathComponents?: unknown; relativePathMovedFrom?: unknown } | null;
    const type = record?.type;
    if (type !== 'appeared' && type !== 'disappeared' && type !== 'modified' && type !== 'moved') return null;
    const path = parse(record?.relativePathComponents);
    if (path === null) return null;
    paths.add(path);
    if (type === 'moved') {
      const from = parse(record?.relativePathMovedFrom);
      if (from === null) return null;
      paths.add(from);
    }
  }
  return [...paths].filter((path) => !skippedPath(path));
}
/** How often to look while the tab is visible, without an observer. */
const POLL_MS = 4000;
/** And with one, in case it misses something. */
const OBSERVED_POLL_MS = 30_000;
/** A burst of observer records becomes one look. */
const OBSERVER_SETTLE_MS = 150;
/** After one look fails at the root, the next comes this soon. */
const RETRY_MS = 1000;
/** What a listing fails with once the folder is gone or out of reach. */
const GONE = new Set(['NotFoundError', 'NotAllowedError', 'SecurityError', 'InvalidStateError']);

/** The page the store watches from: whether it's visible, and when it comes
 * back into view or gains focus. */
export type FolderPage = {
  visible(): boolean;
  on(event: 'visible' | 'focus', handler: () => void): () => void;
};

/** FileSystemObserver, which Chromium has (probed on 156, 2026-10-25). */
type ObserverLike = { observe(handle: unknown, options: { recursive: boolean }): Promise<void>; disconnect(): void };
type ObserverConstructor = new (callback: (records: unknown[]) => void) => ObserverLike;

export type FolderFileStoreOptions = {
  /** The picked folder, for FileSystemObserver. */
  handle?: FolderHandle;
  page?: FolderPage;
  pollMs?: number;
  observedPollMs?: number;
  /** How soon the look after one that failed at the root comes. */
  retryMs?: number;
  /** FileSystemObserver unless given; null to go without. */
  observer?: ObserverConstructor | null;
};

function browserPage(): FolderPage | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return {
    visible: () => document.visibilityState !== 'hidden',
    on(event, handler) {
      if (event === 'focus') {
        window.addEventListener('focus', handler);
        return () => window.removeEventListener('focus', handler);
      }
      const onChange = () => {
        if (document.visibilityState === 'visible') handler();
      };
      document.addEventListener('visibilitychange', onChange);
      return () => document.removeEventListener('visibilitychange', onChange);
    },
  };
}

function browserObserver(): ObserverConstructor | null {
  const found = (globalThis as { FileSystemObserver?: unknown }).FileSystemObserver;
  return typeof found === 'function' ? (found as ObserverConstructor) : null;
}

/** What a listing says of each path: 'dir', or a file's size and time. */
type Snapshot = Map<string, string>;

function signatureOf(entry: FileEntry): string {
  return entry.type === 'dir' ? 'dir' : `${entry.size ?? ''}:${entry.modified ?? ''}`;
}

/** The changes from one listing to the next: what went (only the topmost
 * of a folder that went), then new folders, then new or changed files. */
export function differences(before: Snapshot, after: Snapshot): FileChange[] {
  // In one pass (S8): sorted so a folder's contents come right after it
  // (a '/' sorts first), each removed path is inside the last topmost one
  // or is topmost itself.
  const order = (path: string) => path.replaceAll('/', '\u0000');
  const removed = [...before.keys()]
    .filter((path) => !after.has(path) || (before.get(path) === 'dir') !== (after.get(path) === 'dir'))
    .map((path) => [order(path), path] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const changes: FileChange[] = [];
  let top: string | null = null;
  for (const [, path] of removed) {
    if (top !== null && isInside(path, top)) continue;
    top = path;
    changes.push({ type: 'remove', path });
  }
  const paths = [...after.keys()].sort();
  for (const path of paths) {
    if (after.get(path) === 'dir' && before.get(path) !== 'dir') changes.push({ type: 'mkdir', path });
  }
  for (const path of paths) {
    const now = after.get(path);
    if (now !== 'dir' && before.get(path) !== now) changes.push({ type: 'write', path });
  }
  return changes;
}

export class FolderFileStore implements FileStore {
  private readonly inner: FileStore;
  private readonly options: FolderFileStoreOptions;
  private readonly listeners = new ChangeListeners();
  /** The last listing, once someone watches. */
  private snapshot: Snapshot | null = null;
  /** True once `unreachable` was said, until `reachable`. */
  private unreachable = false;
  /** Looks in a row that failed at the root. */
  private failures = 0;
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private pollTimer: ReturnType<typeof setTimeout> | undefined;
  /** The poll's own spacing while someone watches; null when not polling. */
  private pollBase: number | null = null;
  private page: FolderPage | null = null;
  /** How long the last walk took, and when it ended (S8). */
  private lastWalkMs = 0;
  private lastEnd = 0;
  /** The folder holds more than Nebula shows (S8): said once, and no more
   * looks until the page reloads. */
  private tooBig = false;
  /** The snapshot following this store's own changes (and its tabs'). */
  private own: Promise<void> = Promise.resolve();
  private looking: Promise<void> | null = null;
  /** A whole look is wanted again, and the paths an observer named that are
   * waiting for a partial one. */
  private again = false;
  private wanted = new Set<string>();
  /** What the observer said since the last look it asked for. */
  private observed = new Set<string>();
  private observedWhole = false;
  private stopWatching: Array<() => void> = [];
  private settleTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(inner: FileStore, options: FolderFileStoreOptions = {}) {
    this.inner = inner;
    this.options = options;
  }

  async list(): Promise<FileEntry[]> {
    // folderFileStore's inner store skips these as it walks; any other (a
    // test's memory store) is filtered here.
    return (await this.inner.list()).filter((entry) => !skippedPath(entry.path));
  }

  stat(path: string): Promise<FileEntry | null> {
    return this.inner.stat(path);
  }

  readText(path: string): Promise<string> {
    return this.inner.readText(path);
  }

  readBlob(path: string): Promise<Blob> {
    return this.inner.readBlob(path);
  }

  // The arguments whole, so no write option is dropped.
  write(path: string, data: string | Blob, options?: WriteOptions): Promise<void> {
    return this.inner.write(path, data, options);
  }

  mkdir(path: string): Promise<void> {
    return this.inner.mkdir(path);
  }

  rename(from: string, to: string): Promise<void> {
    return this.inner.rename(from, to);
  }

  remove(path: string): Promise<void> {
    return this.inner.remove(path);
  }

  watch(listener: (change: FileChange) => void): () => void {
    const stop = this.listeners.add(listener);
    if (this.listeners.size === 1) this.start();
    return () => {
      stop();
      if (this.listeners.size === 0) this.stop();
    };
  }

  /** Lists the folder now and tells the watchers what changed outside
   * Nebula since the last look. One look at a time; asked during one, it
   * looks once more after. */
  check(): Promise<void> {
    return this.ask(null);
  }

  /** A look at once, whole (`paths` null) or of the paths an observer named.
   * Looks never overlap: asked during one, it looks again after, and a whole
   * look asked for covers every path waiting. */
  private ask(paths: string[] | null): Promise<void> {
    if (this.tooBig) return Promise.resolve();
    if (paths === null || paths.length > MAX_OBSERVED_PATHS) this.again = true;
    else for (const path of paths) this.wanted.add(path);
    if (this.looking) return this.looking;
    const run = async (): Promise<void> => {
      while (this.again || this.wanted.size > 0) {
        // Only a store that has looked, and can reach its folder, checks
        // paths; every other state is the whole look's to decide.
        if (this.again || !this.snapshot || this.unreachable || this.failures > 0) {
          this.again = false;
          this.wanted.clear();
          await this.look();
          continue;
        }
        const batch = [...this.wanted];
        this.wanted.clear();
        if (!(await this.lookAt(batch))) this.again = true;
      }
    };
    this.looking = run().finally(() => {
      this.looking = null;
      this.planNext();
    });
    return this.looking;
  }

  /** Checks only `paths` against the last listing, and says what
   * changed there. False when it can't tell, and the whole folder must be
   * walked instead: a folder it doesn't know (its contents aren't named), an
   * entry that fails to read, or a path that's gone while the folder itself
   * may be (only the root decides that, S1). */
  private async lookAt(paths: string[]): Promise<boolean> {
    await this.own;
    const handle = this.options.handle;
    if (!this.snapshot || !handle || this.tooBig) return false;
    const found = new Map<string, FileEntry | null>();
    try {
      for (const path of paths) {
        const entry = await this.inner.stat(path);
        // A directory this store doesn't know has contents nobody named.
        if (entry?.type === 'dir' && this.snapshot.get(path) !== 'dir') return false;
        found.set(path, entry);
      }
    } catch {
      return false;
    }
    // Something that was there is gone: the folder may be, too.
    if ([...found].some(([path, entry]) => entry === null && [...this.snapshot!.keys()].some((known) => isInside(known, path)))) {
      if ((await folderAccess(handle).catch(() => 'missing' as const)) !== 'granted') return false;
    }
    const before = this.snapshot;
    const after: Snapshot = new Map(before);
    for (const [path, entry] of found) {
      if (entry === null || entry.type === 'dir') {
        for (const known of [...after.keys()]) if (isInside(known, path) && !(entry && known === path)) after.delete(known);
      }
      if (entry) after.set(path, signatureOf(entry));
    }
    this.snapshot = after;
    this.lastEnd = Date.now();
    if (this.listeners.size === 0) return true;
    for (const change of differences(before, after)) this.listeners.emit(change);
    return true;
  }

  private async look(): Promise<void> {
    await this.own;
    let after: Snapshot;
    const started = Date.now();
    try {
      after = await this.listing();
    } catch (error) {
      if (error instanceof FolderTooBigError) {
        // Never a removal from a walk that stopped at the cap.
        if (!this.tooBig) {
          this.tooBig = true;
          this.listeners.emit({ type: 'too-big', folder: this.options.handle?.name ?? error.folder });
        }
        return;
      }
      if (!(await this.failedAtRoot(error))) {
        console.warn('Nebula could not look at the folder', error);
        return;
      }
      // Once is a hiccup (a drive waking up); twice in a row, it's out of
      // reach. The snapshot stays, so coming back says what changed.
      this.failures += 1;
      if (this.failures < 2) {
        this.retrySoon();
        return;
      }
      if (!this.unreachable) {
        this.unreachable = true;
        this.listeners.emit({ type: 'unreachable', folder: this.options.handle?.name });
      }
      return;
    }
    this.lastEnd = Date.now();
    this.lastWalkMs = this.lastEnd - started;
    this.failures = 0;
    clearTimeout(this.retryTimer);
    const before = this.snapshot;
    this.snapshot = after;
    if (this.unreachable) {
      this.unreachable = false;
      this.listeners.emit({ type: 'reachable' });
    }
    if (!before || this.listeners.size === 0) return;
    for (const change of differences(before, after)) this.listeners.emit(change);
  }

  /** Whether a listing failed because the folder itself is out of reach:
   * the handle says so (folderAccess), not the listing's error alone. */
  private async failedAtRoot(error: unknown): Promise<boolean> {
    const handle = this.options.handle;
    if (!handle) return GONE.has(errorName(error) ?? '');
    return (await folderAccess(handle).catch(() => 'missing' as const)) !== 'granted';
  }

  private retrySoon(): void {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      if (this.listeners.size > 0) void this.check();
    }, this.options.retryMs ?? RETRY_MS);
  }

  private async listing(): Promise<Snapshot> {
    return new Map((await this.list()).map((entry) => [entry.path, signatureOf(entry)]));
  }

  /** This store's own change (or another tab's, which the inner store
   * hears): its watchers hear it from there, so the snapshot takes it in
   * and the next look doesn't report it again. */
  private follow(change: FileChange): void {
    this.listeners.emit(change);
    if (isProjectSignal(change)) return;
    this.own = this.own.then(async () => {
      const snapshot = this.snapshot;
      if (!snapshot) return;
      const drop = (root: string) => {
        for (const path of [...snapshot.keys()]) if (isInside(path, root)) snapshot.delete(path);
      };
      if (change.type === 'remove') drop(change.path);
      else if (change.type === 'mkdir') snapshot.set(change.path, 'dir');
      else if (change.type === 'rename') {
        const moved = [...snapshot.entries()].filter(([path]) => isInside(path, change.from));
        drop(change.from);
        for (const [path, signature] of moved) snapshot.set(change.to + path.slice(change.from.length), signature);
      } else {
        const entry = await this.inner.stat(change.path).catch(() => null);
        if (entry) snapshot.set(change.path, signatureOf(entry));
        else snapshot.delete(change.path);
      }
    });
  }

  private start(): void {
    this.snapshot = null;
    this.unreachable = false;
    this.failures = 0;
    this.tooBig = false;
    this.pollBase = null;
    this.stopWatching.push(this.inner.watch((change) => this.follow(change)));
    void this.check();

    const page = this.options.page ?? browserPage();
    this.page = page;
    // A burst of records is one look, and a whole walk stays spaced (S8);
    // a look at the paths they name is cheap, and isn't.
    const lookSoon = () => {
      clearTimeout(this.settleTimer);
      const spaced = this.observedWhole ? this.lastEnd + 10 * this.lastWalkMs - Date.now() : 0;
      this.settleTimer = setTimeout(() => {
        const paths = this.observedWhole ? null : [...this.observed];
        this.observed.clear();
        this.observedWhole = false;
        void this.ask(paths);
      }, Math.max(OBSERVER_SETTLE_MS, spaced));
    };
    if (page) {
      this.stopWatching.push(page.on('visible', () => void this.check()));
      this.stopWatching.push(page.on('focus', () => void this.check()));
    }

    const every = (ms: number) => {
      this.pollBase = ms;
      this.planNext();
    };
    this.stopWatching.push(() => {
      this.pollBase = null;
      clearTimeout(this.pollTimer);
      clearTimeout(this.settleTimer);
      clearTimeout(this.retryTimer);
    });

    const Observer = this.options.observer === undefined ? browserObserver() : this.options.observer;
    const handle = this.options.handle;
    if (Observer && handle) {
      let observer: ObserverLike | null = null;
      try {
        // The records name what changed: only those paths are checked, and
        // those that name only skipped paths (.git, node_modules) are no
        // reason to look at all. One that can't say walks the whole folder.
        observer = new Observer((records) => {
          const named = observedPaths(records);
          if (named === null) this.observedWhole = true;
          else if (named.length === 0) return;
          else for (const path of named) this.observed.add(path);
          lookSoon();
        });
      } catch {
        observer = null;
      }
      if (observer) {
        const watching = observer;
        this.stopWatching.push(() => watching.disconnect());
        every(this.options.observedPollMs ?? OBSERVED_POLL_MS);
        watching.observe(handle, { recursive: true }).catch(() => {
          // This folder can't be observed here: look every few seconds instead.
          if (this.listeners.size > 0) every(this.options.pollMs ?? POLL_MS);
        });
        return;
      }
    }
    every(this.options.pollMs ?? POLL_MS);
  }

  /** The next poll: no sooner than the poll's own spacing, nor than ten
   * times as long as the last walk took (S8), and only while visible. */
  private planNext(): void {
    clearTimeout(this.pollTimer);
    // A look in progress plans the next one when it ends.
    if (this.pollBase === null || this.listeners.size === 0 || this.tooBig || this.looking) return;
    const delay = Math.max(this.pollBase, 10 * this.lastWalkMs);
    this.pollTimer = setTimeout(() => {
      if (!this.page || this.page.visible()) void this.check();
      else this.planNext();
    }, delay);
  }

  private stop(): void {
    for (const stop of this.stopWatching.splice(0)) stop();
    this.snapshot = null;
  }
}

/** A folder project's store: OpfsFileStore over the picked folder, its
 * changes heard by the project's other tabs (`nebula:project:<id>`), and its
 * Web Locks named under `folders/<id>/`, apart from every browser project's.
 * An empty id (a look at a folder before it's a project) stays local. */
export function folderFileStore(handle: FolderHandle, id: string, locks?: PathLocks, options: Omit<FolderFileStoreOptions, 'handle'> = {}): FolderFileStore {
  const directory = handle as unknown as FileSystemDirectoryHandle;
  const prefix = `folders/${id || '-'}`;
  return new FolderFileStore(
    new OpfsFileStore(directory, {
      ...(id ? { channel: `nebula:project:${id}` } : {}),
      locks: { locks: locks ?? new PathLocks(), prefix },
      listing: { skip: isSkippedInFolder, maxEntries: FOLDER_MAX_ENTRIES, maxMs: FOLDER_MAX_WALK_MS },
    }),
    { ...options, handle },
  );
}
