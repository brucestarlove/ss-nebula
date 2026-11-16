/**
 * Move to a folder… never loses another tab's work (Secu folder-1, S3, and
 * the move's other findings), over the registry with memory stores and fake
 * folder handles, as folderRegistry.test.ts does.
 *
 * The browser project's files are held under their own Web Locks (the names
 * its store uses) from before the copy until the browser copy is deleted;
 * the browser copy is listed again under them right before the registry
 * switches, and the move is announced on the project's channel.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFolderHandles } from './folderHandles';
import type { FolderTier } from './folderTier';
import { MemoryFileStore } from './memoryStore';
import { createBrowserRegistry, type BrowserRegistry, type MoveState } from './registry';
import type { FileStore, FolderHandle, WriteOptions } from './types';
import { FolderTooBigError } from './errors';

class FakeFolder implements FolderHandle {
  readonly kind = 'directory' as const;
  permission: PermissionState = 'granted';
  gone = false;
  readonly name: string;
  readonly files: MemoryFileStore;
  readonly same: FakeFolder | null;
  constructor(name: string, files = new MemoryFileStore(), same: FakeFolder | null = null) {
    this.name = name;
    this.files = files;
    this.same = same;
  }
  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }
  async requestPermission(): Promise<PermissionState> {
    return this.permission;
  }
  private get origin(): FakeFolder {
    return this.same ?? this;
  }
  async isSameEntry(other: FolderHandle): Promise<boolean> {
    return other instanceof FakeFolder && other.origin === this.origin;
  }
}

type Hooks = { beforeWrite?: (path: string, options?: WriteOptions) => Promise<void> | void };

/** A store whose writes a test can step into. */
function hooked(inner: FileStore, hooks: Hooks): FileStore {
  return {
    list: () => inner.list(),
    stat: (p) => inner.stat(p),
    readText: (p) => inner.readText(p),
    readBlob: (p) => inner.readBlob(p),
    async write(path, data, options) {
      await hooks.beforeWrite?.(path, options);
      return inner.write(path, data, options);
    },
    mkdir: (p) => inner.mkdir(p),
    rename: (a, b) => inner.rename(a, b),
    remove: (p) => inner.remove(p),
    watch: (l) => inner.watch(l),
  };
}

let disk: MemoryFileStore;
let handles: MemoryFolderHandles;
let targetHooks: Hooks;
let rootHooks: Hooks;
let announced: Array<{ id: string; state: MoveState }>;
let registry: BrowserRegistry;

function tier(): FolderTier {
  return {
    handles,
    store: (handle) => hooked((handle as FakeFolder).files, targetHooks),
    exists: async (handle) => !(handle as FakeFolder).gone,
  };
}

beforeEach(() => {
  disk = new MemoryFileStore({ holdable: true });
  handles = new MemoryFolderHandles();
  targetHooks = {};
  rootHooks = {};
  announced = [];
  registry = createBrowserRegistry(hooked(disk, rootHooks), {
    folders: tier(),
    locks: null,
    fileLocks: disk.holdableLocks,
    announceMove: (id, state) => announced.push({ id, state }),
  });
});

async function browserProject(files: Record<string, string>): Promise<{ id: string; dir: string }> {
  const created = await registry.create({ name: 'Field notes', color: '#7aa2f7' });
  const store = await registry.files(created.id);
  for (const [path, text] of Object.entries(files)) await store.write(path, text);
  const json = JSON.parse(await disk.readText('registry.json')) as { projects: Array<{ id: string; dir: string }> };
  return { id: created.id, dir: json.projects.find((p) => p.id === created.id)!.dir };
}

const move = (id: string, folder: FakeFolder) => registry.create({ name: 'Field notes', color: '#7aa2f7', folder, from: id });
const browserFiles = async (dir: string) => (await disk.list()).filter((e) => e.path.startsWith(`projects/${dir}/`) && e.type === 'file').map((e) => e.path.slice(`projects/${dir}/`.length));

describe('S3: another tab’s save during Move to a folder…', () => {
  it('a save waiting for its file while the move holds it fails visibly, and nothing it saw saved is lost', async () => {
    const { id, dir } = await browserProject({ 'note.md': 'draft one' });
    const tabB = disk.twin();
    let save: Promise<void> | null = null;
    rootHooks.beforeWrite = (path) => {
      if (path !== 'registry.json' || save) return;
      // Tab B's autosave, after the check and before the switch: it waits for the move's lock.
      save = tabB.write(`projects/${dir}/note.md`, 'draft one, and the paragraph tab B typed', { ifUnchanged: { text: 'draft one' } });
    };
    const folder = new FakeFolder('Notes');
    await move(id, folder);
    expect(save).not.toBeNull();
    await expect(save).rejects.toMatchObject({ name: 'FileChangedError' });
    expect(await folder.files.readText('note.md')).toBe('draft one');
    expect(await browserFiles(dir)).toEqual([]);
  });

  it('a file another tab makes before the last look aborts the move: the browser project stays whole', async () => {
    const { id, dir } = await browserProject({ 'note.md': 'draft one' });
    const tabB = disk.twin();
    targetHooks.beforeWrite = async (path) => {
      if (path === '.nebula/project.json') await tabB.write(`projects/${dir}/new.md`, 'made in tab B', { exclusive: true });
    };
    const folder = new FakeFolder('Notes');
    await expect(move(id, folder)).rejects.toThrow('Something changed in ‘Field notes’ while it was moving, so it stays in this browser. Try again.');
    expect((await registry.list()).find((project) => project.id === id)?.tier).toBe('browser');
    expect((await browserFiles(dir)).sort()).toEqual(['.nebula/project.json', 'new.md', 'note.md']);
    expect((await folder.files.list()).filter((entry) => entry.type === 'file')).toEqual([]);
  });

  it('a file another tab makes after the last look is never deleted with the browser copy', async () => {
    const { id, dir } = await browserProject({ 'note.md': 'draft one' });
    const tabB = disk.twin();
    let made = false;
    rootHooks.beforeWrite = async (path) => {
      if (path !== 'registry.json' || made) return;
      made = true;
      await tabB.write(`projects/${dir}/late.md`, 'made in tab B', { exclusive: true });
    };
    const folder = new FakeFolder('Notes');
    await move(id, folder);
    const inFolder = await folder.files.stat('late.md');
    const inBrowser = (await browserFiles(dir)).includes('late.md');
    expect(inFolder !== null || inBrowser).toBe(true);
    if (inBrowser) expect((await registry.list()).some((project) => project.tier === 'browser')).toBe(true);
  });

  it('announces the move on the project’s channel: moving, then moved, or move-failed', async () => {
    const { id } = await browserProject({ 'note.md': 'x' });
    await move(id, new FakeFolder('Notes'));
    expect(announced).toEqual([
      { id, state: 'moving' },
      { id, state: 'moved' },
    ]);
    const second = await browserProject({ 'a.md': 'a' });
    const full = new FakeFolder('Full');
    await full.files.write('there.md', 'x');
    await expect(move(second.id, full)).rejects.toThrow();
    expect(announced.slice(2)).toEqual([]);
    targetHooks.beforeWrite = () => {
      throw new DOMException('The disk is full', 'QuotaExceededError');
    };
    await expect(move(second.id, new FakeFolder('Empty'))).rejects.toThrow();
    expect(announced.slice(2)).toEqual([
      { id: second.id, state: 'moving' },
      { id: second.id, state: 'move-failed' },
    ]);
  });
});

describe('S8: a folder over the cap', () => {
  it('is refused when it’s picked, and nothing is made', async () => {
    const big = new FakeFolder('Documents');
    await big.files.write('a.md', 'a');
    const list = big.files.list.bind(big.files);
    big.files.list = async () => {
      await list();
      throw new FolderTooBigError('Documents');
    };
    await expect(registry.create({ name: 'Documents', color: '#7aa2f7', folder: big })).rejects.toThrow('‘Documents’ holds more than 10,000 files, more than Nebula can show. Choose a folder of notes and drawings inside it.');
    expect(await registry.list()).toEqual([]);
    expect(await big.files.stat('.nebula/project.json')).toBeNull();
  });
});

describe('S4: a failed move cleans up only what it wrote', () => {
  it('a sync client’s files that arrive in the folder mid-move stay; the move’s own go', async () => {
    const { id } = await browserProject({ 'Guides/plan.md': 'mine', 'Guides/zz.md': 'mine too' });
    const folder = new FakeFolder('Dropbox/Notes');
    targetHooks.beforeWrite = async (path, options) => {
      if (path === 'Guides/zz.md' && options?.exclusive) {
        await folder.files.write('Guides/zz.md', 'from the other laptop');
        await folder.files.write('Guides/their-only-copy.md', 'precious');
      }
    };
    await expect(move(id, folder)).rejects.toThrow();
    expect(await (await registry.files(id)).readText('Guides/plan.md')).toBe('mine');
    expect(await folder.files.readText('Guides/their-only-copy.md')).toBe('precious');
    expect(await folder.files.readText('Guides/zz.md')).toBe('from the other laptop');
    expect(await folder.files.stat('Guides/plan.md')).toBeNull();
    expect(await folder.files.stat('.nebula')).toBeNull();
  });

  it('a file of the move’s that another app changed meanwhile stays, and so does its folder', async () => {
    const { id } = await browserProject({ 'a.md': 'mine' });
    const folder = new FakeFolder('Notes');
    targetHooks.beforeWrite = async (path) => {
      if (path === '.nebula/project.json') {
        await folder.files.write('a.md', 'edited in another app mid-move');
        throw new DOMException('The disk is full', 'QuotaExceededError');
      }
    };
    await expect(move(id, folder)).rejects.toThrow();
    expect(await folder.files.readText('a.md')).toBe('edited in another app mid-move');
  });
});

describe('S5: what a new folder holds of the system’s own', () => {
  it('a lone .DS_Store, Thumbs.db or desktop.ini is empty enough, and is left as it was', async () => {
    const { id } = await browserProject({ 'note.md': 'x' });
    const folder = new FakeFolder('New folder');
    await folder.files.write('.DS_Store', 'Bud1');
    await folder.files.write('Thumbs.db', 'x');
    await folder.files.write('desktop.ini', 'x');
    await move(id, folder);
    expect(await folder.files.readText('note.md')).toBe('x');
    expect(await folder.files.readText('.DS_Store')).toBe('Bud1');
  });

  it('a folder holding a .nebula is still refused', async () => {
    const { id } = await browserProject({ 'note.md': 'x' });
    const folder = new FakeFolder('Other project');
    await folder.files.write('.nebula/project.json', '{"id":"someone-else"}');
    await expect(move(id, folder)).rejects.toThrow(/isn’t empty/);
  });
});

describe('S6: one folder, one project', () => {
  it('re-picking a known folder whose .nebula/ went re-attaches its project and writes project.json back', async () => {
    const folder = new FakeFolder('Notes');
    await folder.files.write('a.md', 'hello');
    const first = await registry.create({ name: 'Notes', color: '#7aa2f7', folder });
    await folder.files.remove('.nebula');
    const again = new FakeFolder('Notes', folder.files, folder);
    const second = await registry.create({ name: 'Notes', color: '#7aa2f7', folder: again });
    expect(second.id).toBe(first.id);
    expect((await registry.list()).map((project) => project.id)).toEqual([first.id]);
    expect(JSON.parse(await folder.files.readText('.nebula/project.json'))).toMatchObject({ id: first.id, name: 'Notes' });
  });
});

describe('S7: a copy is a project of its own', () => {
  for (const access of ['prompt', 'denied'] as const) {
    it(`a copy picked while the original is ‘${access}’ gets a new id`, async () => {
      const original = new FakeFolder('Notes');
      await original.files.write('a.md', 'original');
      const made = await registry.create({ name: 'Notes', color: '#7aa2f7', folder: original });
      original.permission = access;
      const copyFiles = new MemoryFileStore();
      await copyFiles.write('a.md', 'the copy');
      await copyFiles.write('.nebula/project.json', await original.files.readText('.nebula/project.json'));
      const copy = new FakeFolder('Notes copy', copyFiles);
      const record = await registry.create({ name: 'Notes copy', color: '#7aa2f7', folder: copy });
      expect(record.id).not.toBe(made.id);
      expect(await handles.get(made.id)).toBe(original);
    });
  }

  it('the original moved away (missing) is followed to where it went', async () => {
    const original = new FakeFolder('Notes');
    const made = await registry.create({ name: 'Notes', color: '#7aa2f7', folder: original });
    original.gone = true;
    const moved = new FakeFolder('Notes', original.files);
    const record = await registry.create({ name: 'Notes', color: '#7aa2f7', folder: moved });
    expect(record.id).toBe(made.id);
  });
});

describe('S9: the byte check reads in slices', () => {
  it('never reads a whole file into memory to compare it', async () => {
    const { id, dir } = await browserProject({});
    const big = new Blob([new Uint8Array(20 * 1024 * 1024)]);
    await disk.write(`projects/${dir}/video.mp4`, big);
    // Every read of bytes, as jsdom's Blob does it (FileReader).
    const wholeReads: number[] = [];
    const read = FileReader.prototype.readAsArrayBuffer;
    FileReader.prototype.readAsArrayBuffer = function (this: FileReader, blob: Blob) {
      wholeReads.push(blob.size);
      return read.call(this, blob);
    };
    try {
      await move(id, new FakeFolder('Videos'));
    } finally {
      FileReader.prototype.readAsArrayBuffer = read;
    }
    expect(Math.max(...wholeReads)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });
});

describe('S11: a move a closed tab left unfinished', () => {
  async function leftHalfway() {
    const { id, dir } = await browserProject({ 'a.md': 'a', 'b.md': 'b' });
    const folder = new FakeFolder('Notes');
    // What a tab closed mid-move leaves: the marker, part of the files, no project.json.
    await folder.files.write('.nebula/moving.json', JSON.stringify({ from: id, started: '2026-10-25T03:00:00Z' }));
    await folder.files.write('a.md', 'a');
    return { id, dir, folder };
  }

  it('is written as it goes: the marker first, project.json last, the marker gone when done', async () => {
    const { id } = await browserProject({ 'a.md': 'a' });
    const folder = new FakeFolder('Notes');
    const order: string[] = [];
    targetHooks.beforeWrite = (path) => {
      order.push(path);
    };
    await move(id, folder);
    expect(order[0]).toBe('.nebula/moving.json');
    expect(order[order.length - 1]).toBe('.nebula/project.json');
    expect(await folder.files.stat('.nebula/moving.json')).toBeNull();
  });

  it('opening that folder is refused, saying how to finish', async () => {
    const { folder } = await leftHalfway();
    await expect(registry.create({ name: 'Notes', color: '#7aa2f7', folder })).rejects.toThrow('‘Notes’ holds an unfinished move of ‘Field notes’. The project is still in this browser: choose Move to a folder… again to finish it.');
  });

  it('moving the same project there again finishes it', async () => {
    const { id, folder } = await leftHalfway();
    await move(id, folder);
    expect(await folder.files.readText('a.md')).toBe('a');
    expect(await folder.files.readText('b.md')).toBe('b');
    expect(await folder.files.stat('.nebula/moving.json')).toBeNull();
    expect((await registry.list()).find((project) => project.id === id)?.tier).toBe('folder');
  });

  it('anything else there is refused as not empty', async () => {
    const { id, folder } = await leftHalfway();
    await folder.files.write('theirs.md', 'not the project’s');
    await expect(move(id, folder)).rejects.toThrow(/isn’t empty/);
    expect(await folder.files.readText('theirs.md')).toBe('not the project’s');
  });
});

describe('S13: a project whose paths collide only by case', () => {
  it('is refused before anything is written, naming the colliding paths (only the topmost of each)', async () => {
    const { id, dir } = await browserProject({ 'Docs/a.md': 'a', 'docs/b.md': 'b', 'Docs/deep/x.md': 'x', 'note.md': 'n', 'Note.md': 'N', 'other/x.md': 'fine' });
    const folder = new FakeFolder('Notes');
    await expect(move(id, folder)).rejects.toMatchObject({ name: 'FolderCaseCollisionError' });
    await expect(move(id, folder)).rejects.toThrow('‘Docs’ and ‘docs’');
    await expect(move(id, folder)).rejects.toThrow('‘Note.md’ and ‘note.md’');
    // Nothing under 'Docs/…' is named on its own, and nothing else is.
    await expect(move(id, folder)).rejects.not.toThrow(/Docs\/a\.md|other/);
    expect(announced).toEqual([]);
    expect(await folder.files.list()).toEqual([]);
    expect((await registry.list()).find((project) => project.id === id)?.tier).toBe('browser');
    expect((await browserFiles(dir)).sort()).toContain('Docs/a.md');
  });

  it('moves a project whose names differ by more than case', async () => {
    const { id } = await browserProject({ 'a/x.md': '1', 'b/x.md': '2', 'Docs.md': '3', 'Docs-2.md': '4' });
    const folder = new FakeFolder('Notes');
    await move(id, folder);
    expect(await folder.files.readText('a/x.md')).toBe('1');
    expect((await registry.list()).find((project) => project.id === id)?.tier).toBe('folder');
  });
});

describe('S15: registry.json entries keep the fields this build does not know', () => {
  it('a project moved to a folder keeps its entry’s unknown fields, and loses only the browser tier’s own `dir`', async () => {
    const { id } = await browserProject({ 'note.md': 'n' });
    const file = JSON.parse(await disk.readText('registry.json')) as { projects: Array<Record<string, unknown>>; future?: unknown };
    file.projects = file.projects.map((project) => (project.id === id ? { ...project, syncedFrom: { device: 'laptop', at: 3 }, pinned: true } : project));
    file.future = { keep: 'me' };
    await disk.write('registry.json', JSON.stringify(file));
    await move(id, new FakeFolder('Notes'));
    const after = JSON.parse(await disk.readText('registry.json')) as { projects: Array<Record<string, unknown>>; future?: unknown };
    const entry = after.projects.find((project) => project.id === id)!;
    expect(entry).toMatchObject({ tier: 'folder', folder: 'Notes', syncedFrom: { device: 'laptop', at: 3 }, pinned: true });
    expect(entry).not.toHaveProperty('dir');
    expect(after.future).toEqual({ keep: 'me' });
  });
});
