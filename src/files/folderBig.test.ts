/**
 * A large folder never hangs the tab: removals are
 * worked out in one pass, the walk stops at 10,000 entries (after the name
 * filters) or 2 s, and the next look waits at least ten times as long as
 * the last walk took.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_MAX_ENTRIES, FolderFileStore, FolderTooBigError, differences, folderFileStore, isSkippedInFolder, type FolderPage } from './folderStore';
import { OpfsFileStore } from './opfsStore';
import { MemoryFileStore } from './memoryStore';
import type { FileChange, FileStore, FolderHandle } from './types';

const page: FolderPage = { visible: () => true, on: () => () => {} };
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('S8: removals in one pass', () => {
  it('8,000 files removed while their folders stay take well under 0.2 s, and only the topmost of a folder removed is said', () => {
    const before = new Map<string, string>();
    const after = new Map<string, string>();
    for (let i = 0; i < 200; i += 1) {
      before.set(`node_modules/pkg${i}`, 'dir');
      after.set(`node_modules/pkg${i}`, 'dir');
    }
    before.set('node_modules', 'dir');
    after.set('node_modules', 'dir');
    for (let i = 0; i < 8000; i += 1) before.set(`node_modules/pkg${i % 200}/f${i}.js`, '1:1');
    before.set('Gone', 'dir');
    before.set('Gone/a.md', '1:1');
    before.set('Gone/Deeper', 'dir');
    before.set('Gone/Deeper/b.md', '1:1');
    before.set('Gone.md', '1:1');
    const start = performance.now();
    const changes = differences(before, after);
    const took = performance.now() - start;
    expect(took).toBeLessThan(200);
    const removed = changes.filter((change) => change.type === 'remove').map((change) => (change as { path: string }).path);
    expect(removed).toHaveLength(8002);
    expect(removed).toContain('Gone');
    expect(removed).toContain('Gone.md');
    expect(removed).not.toContain('Gone/a.md');
    expect(removed).not.toContain('Gone/Deeper');
  });

  it('a file that became a folder is removed, then made', () => {
    const changes = differences(new Map([['x', '1:1']]), new Map([['x', 'dir']]));
    expect(changes).toEqual([
      { type: 'remove', path: 'x' },
      { type: 'mkdir', path: 'x' },
    ]);
  });
});

/** A folder's handle over a memory disk, as the walk sees it. */
class MemoryDir {
  readonly kind = 'directory' as const;
  readonly name: string;
  readonly children = new Map<string, MemoryDir | { kind: 'file'; name: string; getFile(): Promise<File> }>();
  constructor(name: string) {
    this.name = name;
  }
  async *values() {
    for (const child of this.children.values()) yield child;
  }
  async *keys() {
    for (const name of this.children.keys()) yield name;
  }
  file(name: string): void {
    this.children.set(name, { kind: 'file', name, getFile: async () => new File(['x'], name, { lastModified: 1 }) });
  }
  dir(name: string): MemoryDir {
    const child = new MemoryDir(name);
    this.children.set(name, child);
    return child;
  }
}

describe('S8: the cap', () => {
  it('a walk past 10,000 entries (after the filters) stops, and says the folder is too big', async () => {
    const root = new MemoryDir('Documents');
    const sub = root.dir('Archive');
    for (let i = 0; i < FOLDER_MAX_ENTRIES; i += 1) sub.file(`f${i}.md`);
    const hidden = root.dir('node_modules');
    for (let i = 0; i < 50; i += 1) hidden.file(`x${i}.js`);
    const store = folderFileStore(root as unknown as FolderHandle, '', undefined, { page, observer: null, pollMs: 1e9 });
    await expect(store.list()).rejects.toThrow('‘Documents’ holds more than 10,000 files, more than Nebula can show. Choose a folder of notes and drawings inside it.');
    await expect(store.list()).rejects.toBeInstanceOf(FolderTooBigError);
    sub.children.delete('f0.md');
    expect(await store.list()).toHaveLength(FOLDER_MAX_ENTRIES);
  });

  it('an open folder that grows past the cap says so once, reports no removals and stops looking', async () => {
    const root = new MemoryDir('Notes');
    root.file('Kept.md');
    const inner = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: null, listing: { skip: isSkippedInFolder, maxEntries: FOLDER_MAX_ENTRIES } });
    let walks = 0;
    const list = inner.list.bind(inner);
    inner.list = () => {
      walks += 1;
      return list();
    };
    const store = new FolderFileStore(inner, { handle: root as unknown as FolderHandle, page, observer: null, pollMs: 10 });
    const heard: FileChange[] = [];
    stops.push(store.watch((change) => heard.push(change)));
    await store.check();
    const big = root.dir('Everything');
    for (let i = 0; i < FOLDER_MAX_ENTRIES + 1; i += 1) big.file(`f${i}`);
    await store.check();
    expect(heard).toEqual([{ type: 'too-big', folder: 'Notes' }]);
    const after = walks;
    await wait(100);
    await store.check();
    expect(walks).toBe(after);
    expect(heard).toHaveLength(1);
  });
});

describe('S8: looks are spaced by how long the last one took', () => {
  it('a walk that took 40 ms is followed by the next no sooner than 400 ms later, whatever the poll', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.md', 'a');
    let walks = 0;
    const slow: FileStore = {
      list: async () => {
        walks += 1;
        await wait(40);
        return disk.list();
      },
      stat: (p) => disk.stat(p),
      readText: (p) => disk.readText(p),
      readBlob: (p) => disk.readBlob(p),
      write: (...args) => disk.write(...args),
      mkdir: (p) => disk.mkdir(p),
      rename: (a, b) => disk.rename(a, b),
      remove: (p) => disk.remove(p),
      watch: () => () => {},
    };
    const store = new FolderFileStore(slow, { page, observer: null, pollMs: 10 });
    stops.push(store.watch(() => {}));
    await wait(350);
    // The first look at once; the next one 400 ms after it ended at the soonest.
    expect(walks).toBe(1);
    await wait(250);
    expect(walks).toBe(2);
  });
});
