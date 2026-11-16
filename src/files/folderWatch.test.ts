import { afterEach, describe, expect, it } from 'vitest';
import { FolderFileStore, type FolderPage } from './folderStore';
import { ChangeListeners } from './listeners';
import { MemoryFileStore } from './memoryStore';
import type { FileChange, FileStore, FolderHandle } from './types';

/**
 * Changes from outside Nebula (slice 7, task 3): another app (an editor,
 * Obsidian, Dropbox's sync) changes the folder and never takes Nebula's
 * locks or tells its tabs. The store notices and says so through watch().
 */

/** The disk under the store: a memory store whose own changes reach the
 * folder store's watchers, as OpfsFileStore's do, while changes made to
 * `disk` directly (another app's) reach nobody. */
function overDisk(disk: MemoryFileStore, options: { failList?: () => Error | null; log?: string[]; folderGone?: () => boolean } = {}): FileStore {
  const listeners = new ChangeListeners();
  return {
    list: () => {
      options.log?.push('list');
      const error = options.failList?.();
      return error ? Promise.reject(error) : disk.list();
    },
    stat: (path) => {
      options.log?.push(`stat ${path}`);
      // A folder that's gone has nothing in it, whatever the path.
      return options.folderGone?.() ? Promise.resolve(null) : disk.stat(path);
    },
    readText: (path) => disk.readText(path),
    readBlob: (path) => disk.readBlob(path),
    async write(...args) {
      await disk.write(...args);
      listeners.emit({ type: 'write', path: args[0] });
    },
    async mkdir(path) {
      await disk.mkdir(path);
      listeners.emit({ type: 'mkdir', path });
    },
    async rename(from, to) {
      await disk.rename(from, to);
      listeners.emit({ type: 'rename', from, to });
    },
    async remove(path) {
      await disk.remove(path);
      listeners.emit({ type: 'remove', path });
    },
    watch: (listener) => listeners.add(listener),
  };
}

/** The page: whether it's visible, and its visibility and focus events. */
class FakePage implements FolderPage {
  shown = true;
  private readonly handlers = new Map<string, Set<() => void>>();

  visible(): boolean {
    return this.shown;
  }

  on(event: 'visible' | 'focus', handler: () => void): () => void {
    const set = this.handlers.get(event) ?? new Set();
    set.add(handler);
    this.handlers.set(event, set);
    return () => set.delete(handler);
  }

  fire(event: 'visible' | 'focus'): void {
    for (const handler of this.handlers.get(event) ?? []) handler();
  }

  get listening(): number {
    return [...this.handlers.values()].reduce((sum, set) => sum + set.size, 0);
  }
}

/** FileSystemObserver as Chromium has it, driven by the test. */
class FakeObserver {
  static made: FakeObserver[] = [];
  static fail = false;
  readonly callback: (records: unknown[]) => void;
  observed: Array<{ handle: unknown; options: unknown }> = [];
  disconnected = false;

  constructor(callback: (records: unknown[]) => void) {
    this.callback = callback;
    FakeObserver.made.push(this);
  }

  async observe(handle: unknown, options: unknown): Promise<void> {
    if (FakeObserver.fail) throw new DOMException('Not here', 'NotSupportedError');
    this.observed.push({ handle, options });
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Something changed in the folder: the records as Chromium gives them
   * (probed: e2e/folder-store.spec.ts), a path for each. */
  fire(...records: unknown[]): void {
    this.callback(records);
  }
}

/** One FileSystemObserver record: `path` as relativePathComponents. */
const record = (type: string, path: string, from?: string) => ({
  type,
  relativePathComponents: path.split('/'),
  ...(from === undefined ? {} : { relativePathMovedFrom: from.split('/') }),
});

const folder: FolderHandle = { kind: 'directory', name: 'Notes' };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(check: () => boolean, ms = 1000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await wait(5);
  }
}

let stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops) stop();
  stops = [];
  FakeObserver.made = [];
  FakeObserver.fail = false;
});

/** A folder store over a fresh disk, watched; no timers unless asked. */
async function watched(options: { pollMs?: number; observedPollMs?: number; observer?: typeof FakeObserver | null; failList?: () => Error | null; folderGone?: () => boolean; log?: string[] } = {}) {
  const disk = new MemoryFileStore();
  await disk.write('Kept.md', 'kept');
  const page = new FakePage();
  const folderGone = options.folderGone;
  // The folder itself, which says whether it's still there (folderAccess).
  const handle: FolderHandle = folderGone
    ? Object.assign(Object.create(null) as object, {
        kind: 'directory' as const,
        name: 'Notes',
        async *keys() {
          if (folderGone()) throw new DOMException('Gone', 'NotFoundError');
          yield 'Kept.md';
        },
      })
    : folder;
  const store = new FolderFileStore(overDisk(disk, { failList: options.failList, log: options.log, folderGone: options.folderGone }), {
    handle,
    retryMs: 60_000,
    page,
    pollMs: options.pollMs ?? 60_000,
    observedPollMs: options.observedPollMs ?? 60_000,
    observer: options.observer === undefined ? null : options.observer,
  });
  const heard: FileChange[] = [];
  const stop = store.watch((change) => heard.push(change));
  stops.push(stop);
  await store.check();
  return { disk, page, store, heard, stop };
}

describe('changes another app makes to the folder', () => {
  it('are heard: what was added, changed and removed, a removed folder once', async () => {
    const { disk, store, heard } = await watched();
    await disk.write('Ideas.md', 'idea');
    await disk.write('Trips/Iceland.md', 'north');
    await store.check();
    expect(heard).toEqual([
      { type: 'mkdir', path: 'Trips' },
      { type: 'write', path: 'Ideas.md' },
      { type: 'write', path: 'Trips/Iceland.md' },
    ]);

    heard.length = 0;
    await disk.write('Ideas.md', 'a longer idea');
    await store.check();
    expect(heard).toEqual([{ type: 'write', path: 'Ideas.md' }]);

    heard.length = 0;
    await disk.remove('Trips');
    await store.check();
    expect(heard).toEqual([{ type: 'remove', path: 'Trips' }]);

    heard.length = 0;
    await store.check();
    expect(heard).toEqual([]);
  });

  it('are not confused with this store’s own changes, which are heard once', async () => {
    const { store, heard } = await watched();
    await store.write('Mine.md', 'mine');
    await store.mkdir('Box');
    await store.rename('Kept.md', 'Box/Kept.md');
    await store.check();
    expect(heard).toEqual([
      { type: 'write', path: 'Mine.md' },
      { type: 'mkdir', path: 'Box' },
      { type: 'rename', from: 'Kept.md', to: 'Box/Kept.md' },
    ]);
  });

  it('are looked for when the tab comes back into view, and when the window gains focus', async () => {
    const { disk, page, heard } = await watched();
    await disk.write('Seen.md', 'on return');
    page.fire('visible');
    await until(() => heard.length === 1);
    expect(heard).toEqual([{ type: 'write', path: 'Seen.md' }]);
    await disk.write('Focus.md', 'on focus');
    page.fire('focus');
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ type: 'write', path: 'Focus.md' });
  });

  it('are looked for every few seconds while the tab is visible, and not while it’s hidden', async () => {
    const { disk, page, heard } = await watched({ pollMs: 20 });
    await disk.write('Polled.md', 'p');
    await until(() => heard.length === 1);

    page.shown = false;
    await disk.write('Hidden.md', 'h');
    await wait(100);
    expect(heard).toHaveLength(1);
    page.shown = true;
    page.fire('visible');
    await until(() => heard.length === 2);
    expect(heard[1]).toEqual({ type: 'write', path: 'Hidden.md' });
  });

  it('are heard through FileSystemObserver where the browser has one, which watches the whole folder', async () => {
    const { disk, heard } = await watched({ observer: FakeObserver, pollMs: 20 });
    const observer = FakeObserver.made[0];
    expect(observer.observed).toEqual([{ handle: folder, options: { recursive: true } }]);
    // With an observer the store looks only now and then on its own.
    await disk.write('Quiet.md', 'q');
    await wait(100);
    expect(heard).toEqual([]);
    observer.fire(record('appeared', 'Quiet.md'));
    await until(() => heard.length === 1);
    expect(heard).toEqual([{ type: 'write', path: 'Quiet.md' }]);
  });

  it('are polled for when the observer can’t watch this folder', async () => {
    FakeObserver.fail = true;
    const { disk, heard } = await watched({ observer: FakeObserver, pollMs: 20 });
    await disk.write('Polled.md', 'p');
    await until(() => heard.length === 1);
    expect(heard).toEqual([{ type: 'write', path: 'Polled.md' }]);
  });

  it('stop being looked for once nobody watches', async () => {
    const { disk, page, heard, stop } = await watched({ observer: FakeObserver, pollMs: 20, observedPollMs: 20 });
    stop();
    expect(FakeObserver.made[0].disconnected).toBe(true);
    expect(page.listening).toBe(0);
    await disk.write('Later.md', 'l');
    await wait(100);
    expect(heard).toEqual([]);
  });

  it('include the whole folder going out of reach (moved, deleted, a drive unplugged): unreachable, said once two looks fail, never a remove', async () => {
    let gone: Error | null = null;
    const { store, heard } = await watched({ failList: () => gone, folderGone: () => gone !== null });
    gone = new DOMException('A requested file or directory could not be found', 'NotFoundError');
    await store.check();
    expect(heard).toEqual([]);
    await store.check();
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }]);
    gone = null;
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }, { type: 'reachable' }]);
  });
});

describe('a save over a file another app changed', () => {
  it('fails as a conflict, and the other app’s version stays', async () => {
    const disk = new MemoryFileStore();
    const store = new FolderFileStore(overDisk(disk), { handle: folder, observer: null, page: new FakePage() });
    await store.write('Plan.md', 'as read');
    const seen = await store.readText('Plan.md');
    await disk.write('Plan.md', 'changed in another app');
    await expect(store.write('Plan.md', 'my edit', { ifUnchanged: { text: seen } })).rejects.toMatchObject({ name: 'FileChangedError' });
    expect(await disk.readText('Plan.md')).toBe('changed in another app');
  });
});

/** Round 3, item 2: an observer's records name the paths to look at, and only
 * those are checked; the whole folder is walked again only when a record
 * can't say (no usable path, the root, a new folder, `unknown`, too many). */
describe('FileSystemObserver records name what to check', () => {
  const SETTLE = 400;
  async function observed(options: { folderGone?: () => boolean; failList?: () => Error | null } = {}) {
    const log: string[] = [];
    const watch = await watched({ observer: FakeObserver, log, ...options });
    await watch.disk.write('Other.md', 'other');
    await watch.store.check();
    watch.heard.length = 0;
    log.length = 0;
    return { ...watch, log, observer: FakeObserver.made[0] };
  }
  const walks = (log: string[]) => log.filter((entry) => entry === 'list').length;

  it('checks only the path a record names: a changed file, and nothing else in the folder', async () => {
    const { disk, heard, log, observer } = await observed();
    await disk.write('Kept.md', 'kept, and changed elsewhere');
    await disk.write('Other.md', 'also changed, but no record says so');
    observer.fire(record('modified', 'Kept.md'));
    await until(() => heard.length === 1);
    await wait(SETTLE);
    expect(heard).toEqual([{ type: 'write', path: 'Kept.md' }]);
    expect(walks(log)).toBe(0);
    expect(log).toEqual(['stat Kept.md']);
  });

  it('hears a file that appeared in a folder it already knows, and one that disappeared, with the folder untouched', async () => {
    const { disk, store, heard, log, observer } = await observed();
    await disk.write('Box/Old.md', 'old');
    await store.check();
    heard.length = 0;
    log.length = 0;
    await disk.write('Box/New.md', 'new');
    await disk.remove('Box/Old.md');
    observer.fire(record('appeared', 'Box/New.md'), record('disappeared', 'Box/Old.md'));
    await until(() => heard.length === 2);
    expect(heard).toEqual([
      { type: 'remove', path: 'Box/Old.md' },
      { type: 'write', path: 'Box/New.md' },
    ]);
    expect(walks(log)).toBe(0);
  });

  it('hears a folder that went as one removal, whatever the records name inside it', async () => {
    const { disk, store, heard, log, observer } = await observed();
    await disk.write('Trips/Iceland.md', 'north');
    await disk.write('Trips/Deep/Fjord.md', 'fjord');
    await store.check();
    heard.length = 0;
    log.length = 0;
    await disk.remove('Trips');
    observer.fire(record('disappeared', 'Trips/Deep/Fjord.md'), record('disappeared', 'Trips/Deep'), record('disappeared', 'Trips'), record('disappeared', 'Trips/Iceland.md'));
    await until(() => heard.length >= 1);
    await wait(SETTLE);
    expect(heard).toEqual([{ type: 'remove', path: 'Trips' }]);
    expect(walks(log)).toBe(0);
  });

  it('hears a rename another app made at both of its paths', async () => {
    const { disk, heard, log, observer } = await observed();
    await disk.rename('Kept.md', 'Renamed.md');
    observer.fire(record('moved', 'Renamed.md', 'Kept.md'));
    await until(() => heard.length === 2);
    expect(heard).toEqual([
      { type: 'remove', path: 'Kept.md' },
      { type: 'write', path: 'Renamed.md' },
    ]);
    expect(walks(log)).toBe(0);
  });

  it('says nothing for the echo of its own save, and does not walk for it', async () => {
    const { store, heard, log, observer } = await observed();
    await store.write('Mine.md', 'mine');
    expect(heard).toEqual([{ type: 'write', path: 'Mine.md' }]);
    heard.length = 0;
    observer.fire(record('appeared', 'Mine.md'), record('modified', 'Mine.md'));
    await wait(SETTLE);
    expect(heard).toEqual([]);
    expect(walks(log)).toBe(0);
  });

  it('looks at a folder that appeared by walking, since what is in it is not named', async () => {
    const { disk, heard, log, observer } = await observed();
    await disk.write('Dropped/One.md', '1');
    await disk.write('Dropped/Two.md', '2');
    observer.fire(record('appeared', 'Dropped'));
    await until(() => heard.length === 3);
    expect(heard).toEqual([
      { type: 'mkdir', path: 'Dropped' },
      { type: 'write', path: 'Dropped/One.md' },
      { type: 'write', path: 'Dropped/Two.md' },
    ]);
    expect(walks(log)).toBe(1);
  });

  it.each([
    ['a record that names no path', { type: 'modified' }],
    ['a record with an empty path (the root itself)', { type: 'modified', relativePathComponents: [] }],
    ['a record of type unknown (changes were lost)', { type: 'unknown', relativePathComponents: ['Kept.md'] }],
    ['a record of type errored (observing stopped)', { type: 'errored', relativePathComponents: [] }],
    ['a moved record that doesn’t say from where', { type: 'moved', relativePathComponents: ['Kept.md'] }],
  ])('walks the whole folder for %s', async (_label, bad) => {
    const { disk, heard, log, observer } = await observed();
    await disk.write('Elsewhere.md', 'not named by any record');
    observer.fire(bad);
    await until(() => heard.length === 1);
    expect(heard).toEqual([{ type: 'write', path: 'Elsewhere.md' }]);
    expect(walks(log)).toBe(1);
  });

  it('walks the whole folder, rather than check path by path, for a great many records', async () => {
    const { disk, heard, log, observer } = await observed();
    const records = [];
    for (let index = 0; index < 300; index += 1) {
      await disk.write(`Bulk/${index}.md`, 'x');
      records.push(record('appeared', `Bulk/${index}.md`));
    }
    observer.fire(...records);
    await until(() => heard.length > 300, 3000);
    expect(walks(log)).toBe(1);
    expect(log.filter((entry) => entry.startsWith('stat'))).toEqual([]);
  });

  it('does not look for records that name only skipped paths (.git, node_modules, swap files)', async () => {
    const { disk, heard, log, observer } = await observed();
    await disk.write('Kept.md', 'changed, but the record is about something else');
    observer.fire(record('modified', '.git/index'), record('appeared', 'a/node_modules/x/y.js'), record('modified', 'Kept.md.crswap'));
    await wait(SETTLE);
    expect(heard).toEqual([]);
    expect(log).toEqual([]);
  });

  it('never reads a folder that went as its files removed: the root is asked, the whole look decides, and only two failed looks say unreachable', async () => {
    let gone = false;
    const { heard, log, observer, store } = await observed({
      folderGone: () => gone,
      failList: () => (gone ? new DOMException('A requested file or directory could not be found', 'NotFoundError') : null),
    });
    gone = true;
    observer.fire(record('disappeared', 'Kept.md'), record('disappeared', 'Other.md'));
    await wait(SETTLE);
    expect(heard).toEqual([]);
    expect(walks(log)).toBeGreaterThanOrEqual(1);
    await store.check();
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }]);
    gone = false;
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }, { type: 'reachable' }]);
  });

  it('a record heard while the folder is out of reach is a whole look, which says what came back', async () => {
    let gone = false;
    const { disk, heard, observer, store } = await observed({
      folderGone: () => gone,
      failList: () => (gone ? new DOMException('Gone', 'NotFoundError') : null),
    });
    gone = true;
    await store.check();
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }]);
    gone = false;
    await disk.write('Back.md', 'b');
    observer.fire(record('modified', 'Other.md'));
    await until(() => heard.length === 3);
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }, { type: 'reachable' }, { type: 'write', path: 'Back.md' }]);
  });
});
