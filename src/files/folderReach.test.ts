/**
 * A folder Nebula can't reach is not a project removed.
 *
 * On a real local folder Chrome's swap file `<name>.crswap` exists from
 * createWritable() to close(), and other apps add and delete files at any
 * moment. A walk that asks for a file's details after it went, or iterates
 * a subfolder another app just deleted, must skip that entry: only the
 * folder itself decides whether the folder is gone, and only after two
 * looks in a row fail at its root. The store then says `unreachable`, never
 * `remove ''`, and `reachable` on the first good listing.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { FolderFileStore, folderFileStore, isSkippedInFolder, type FolderPage } from './folderStore';
import { OpfsFileStore } from './opfsStore';
import type { FileChange, FolderHandle } from './types';

const notFound = () => new DOMException('A requested file or directory could not be found', 'NotFoundError');

/** A local folder as Chrome's handles show it, enough for list(). */
class FakeFile {
  readonly kind = 'file' as const;
  readonly name: string;
  text: string;
  modified: number;
  vanished = false;
  reads = 0;
  constructor(name: string, text: string, modified = 1) {
    this.name = name;
    this.text = text;
    this.modified = modified;
  }
  async getFile(): Promise<File> {
    this.reads += 1;
    if (this.vanished) throw notFound();
    return new File([this.text], this.name, { lastModified: this.modified });
  }
}

class FakeDir {
  readonly kind = 'directory' as const;
  readonly children = new Map<string, FakeFile | FakeDir>();
  /** Called as each entry is enumerated, before the caller uses it. */
  onYield?: (name: string) => void;
  gone = false;
  walks = 0;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
  }
  async *values(): AsyncIterable<FakeFile | FakeDir> {
    this.walks += 1;
    if (this.gone) throw notFound();
    for (const child of [...this.children.values()]) {
      this.onYield?.(child.name);
      yield child;
    }
  }
  async *keys(): AsyncIterable<string> {
    if (this.gone) throw notFound();
    for (const name of this.children.keys()) yield name;
  }
  add(...entries: Array<FakeFile | FakeDir>): this {
    for (const entry of entries) this.children.set(entry.name, entry);
    return this;
  }
}

const page: FolderPage = { visible: () => true, on: () => () => {} };

/** The folder tier's own store over `root`, as folderFileStore makes it,
 * with no timers. */
function folderOver(root: FakeDir): FolderFileStore {
  return folderFileStore(root as unknown as FolderHandle, '', undefined, { page, observer: null, pollMs: 1e9, retryMs: 1e9 });
}

const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

function watch(store: FolderFileStore): FileChange[] {
  const heard: FileChange[] = [];
  stops.push(store.watch((change) => heard.push(change)));
  return heard;
}

describe('S1: an entry that goes mid-walk is that entry gone, never the folder', () => {
  it('a save’s .crswap moved into place mid-walk is never looked at, and nothing says the folder went', async () => {
    const root = new FakeDir('Notes').add(new FakeFile('note.md', 'hello'));
    const store = folderOver(root);
    const heard = watch(store);
    await store.check();

    const swap = new FakeFile('note.md.crswap', 'hello world');
    root.add(swap);
    root.onYield = (name) => {
      if (name !== 'note.md.crswap') return;
      swap.vanished = true;
      root.children.delete('note.md.crswap');
      const note = root.children.get('note.md') as FakeFile;
      note.text = 'hello world';
      note.modified = 2;
    };
    await store.check();
    expect(swap.reads).toBe(0);
    expect(heard).toEqual([]);
    // The save, seen on the next look.
    await store.check();
    expect(heard).toEqual([{ type: 'write', path: 'note.md' }]);
  });

  it('a file another app deletes between the listing and its details is skipped', async () => {
    const lock = new FakeFile('index.lock', '');
    const root = new FakeDir('Repo').add(new FakeFile('a.md', 'a'), lock);
    const store = folderOver(root);
    const heard = watch(store);
    await store.check();
    root.onYield = (name) => {
      if (name === 'index.lock') lock.vanished = true;
    };
    await store.check();
    expect(heard).toEqual([{ type: 'remove', path: 'index.lock' }]);
  });

  it('a subfolder another app deletes mid-walk is that subfolder removed', async () => {
    const build = new FakeDir('build').add(new FakeFile('out.js', 'x'));
    const root = new FakeDir('Repo').add(new FakeFile('a.md', 'a'), build);
    const store = folderOver(root);
    const heard = watch(store);
    await store.check();
    root.onYield = (name) => {
      if (name === 'build') build.gone = true;
    };
    await store.check();
    expect(heard).toEqual([{ type: 'remove', path: 'build' }]);
  });

  it('a root that goes mid-walk reports no removals: the listing fails at the root', async () => {
    const root = new FakeDir('Notes').add(new FakeFile('a.md', 'a'), new FakeDir('Trips').add(new FakeFile('b.md', 'b')));
    const store = folderOver(root);
    const heard = watch(store);
    await store.check();
    root.onYield = (name) => {
      if (name !== 'Trips') return;
      root.gone = true;
      (root.children.get('Trips') as FakeDir).gone = true;
    };
    await store.check();
    expect(heard).toEqual([]);
  });
});

describe('S1: names the folder tier never looks at', () => {
  it('skips dot-entries, node_modules, OS files, swap and temporary files before asking for their details', async () => {
    const skipped = [
      new FakeDir('.git').add(new FakeFile('HEAD', 'ref')),
      new FakeDir('.obsidian').add(new FakeFile('app.json', '{}')),
      new FakeDir('node_modules').add(new FakeFile('index.js', 'x')),
      new FakeFile('.DS_Store', 'bud1'),
      new FakeFile('Thumbs.db', 'x'),
      new FakeFile('desktop.ini', 'x'),
      new FakeFile('Plan.md.crswap', 'x'),
      new FakeFile('.nebula-write-0123', 'x'),
    ];
    const root = new FakeDir('Notes').add(new FakeFile('Plan.md', 'plan'), ...skipped);
    const store = folderOver(root);
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Plan.md']);
    for (const entry of skipped) expect(entry instanceof FakeFile ? entry.reads : entry.walks, entry.name).toBe(0);
  });

  it('the browser tier skips nothing it didn’t before', async () => {
    const root = new FakeDir('projects').add(new FakeFile('.DS_Store', 'x'), new FakeDir('node_modules').add(new FakeFile('a.js', 'a')));
    const store = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: null });
    expect((await store.list()).map((entry) => entry.path)).toEqual(['.DS_Store', 'node_modules', 'node_modules/a.js']);
  });

  it('names: what the filter skips, and what it keeps', () => {
    for (const name of ['.git', '.DS_Store', 'node_modules', 'Thumbs.db', 'thumbs.db', 'desktop.ini', 'Desktop.ini', 'a.md.crswap', '.nebula-write-1']) expect(isSkippedInFolder(name), name).toBe(true);
    for (const name of ['Plan.md', 'node_modules.md', 'git', 'Sketch.excalidraw']) expect(isSkippedInFolder(name), name).toBe(false);
  });
});

describe('S1: only the folder itself decides', () => {
  it('one failed look at the root says nothing; two in a row say unreachable, once; the first good look says reachable', async () => {
    const root = new FakeDir('Notes').add(new FakeFile('a.md', 'a'));
    const store = folderOver(root);
    const heard = watch(store);
    await store.check();
    root.gone = true;
    await store.check();
    expect(heard).toEqual([]);
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }]);
    await store.check();
    expect(heard).toHaveLength(1);
    root.gone = false;
    root.add(new FakeFile('b.md', 'made while away'));
    await store.check();
    expect(heard).toEqual([{ type: 'unreachable', folder: 'Notes' }, { type: 'reachable' }, { type: 'write', path: 'b.md' }]);
    expect(heard.some((change) => change.type === 'remove')).toBe(false);
  });

  it('a listing that fails while the folder itself is fine says nothing', async () => {
    const root = new FakeDir('Notes').add(new FakeFile('a.md', 'a'));
    const inner = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: null });
    let failing = false;
    const list = inner.list.bind(inner);
    inner.list = () => (failing ? Promise.reject(notFound()) : list());
    const store = new FolderFileStore(inner, { handle: root as unknown as FolderHandle, page, observer: null, pollMs: 1e9, retryMs: 1e9 });
    const heard = watch(store);
    await store.check();
    failing = true;
    await store.check();
    await store.check();
    await store.check();
    expect(heard).toEqual([]);
  });
});
