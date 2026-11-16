import { beforeEach, describe, expect, it } from 'vitest';
import { blobToBytes } from './bytes';
import { MemoryFolderHandles } from './folderHandles';
import type { FolderTier } from './folderTier';
import { MemoryFileStore } from './memoryStore';
import { createBrowserRegistry, type BrowserRegistry } from './registry';
import type { FolderHandle } from './types';

/** A picked folder, standing in for a FileSystemDirectoryHandle: its files
 * are a memory store, and the test says what the browser answers. */
class FakeFolder implements FolderHandle {
  readonly kind = 'directory' as const;
  permission: PermissionState = 'granted';
  /** What requestPermission() answers (and then keeps). */
  answer: PermissionState = 'granted';
  gone = false;
  asked = 0;
  readonly name: string;
  readonly files: MemoryFileStore;

  constructor(name: string, files = new MemoryFileStore()) {
    this.name = name;
    this.files = files;
  }

  async queryPermission(): Promise<PermissionState> {
    return this.permission;
  }

  async requestPermission(): Promise<PermissionState> {
    this.asked += 1;
    this.permission = this.answer;
    return this.permission;
  }

  async isSameEntry(other: FolderHandle): Promise<boolean> {
    return other === this || (other instanceof SameFolder && other.of === this);
  }
}

/** Another handle to the same folder, as a second pick of it gives. */
class SameFolder extends FakeFolder {
  readonly of: FakeFolder;

  constructor(of: FakeFolder) {
    super(of.name, of.files);
    this.of = of;
  }

  override async isSameEntry(other: FolderHandle): Promise<boolean> {
    return other === this || other === this.of || (other instanceof SameFolder && other.of === this.of);
  }
}

type Json = Record<string, unknown>;

let root: MemoryFileStore;
let handles: MemoryFolderHandles;
let clock: number;
let registry: BrowserRegistry;

const now = () => new Date(clock);
const tick = () => {
  clock += 60_000;
};

function folderTier(): FolderTier {
  return {
    handles,
    store: (handle) => (handle as FakeFolder).files,
    exists: async (handle) => !(handle as FakeFolder).gone,
  };
}

async function registryJson(): Promise<{ version: number; projects: Json[]; current: string | null } & Json> {
  return JSON.parse(await root.readText('registry.json'));
}

async function metaIn(folder: FakeFolder): Promise<Json> {
  return JSON.parse(await folder.files.readText('.nebula/project.json'));
}

async function paths(store: MemoryFileStore): Promise<string[]> {
  return (await store.list()).map((entry) => entry.path);
}

beforeEach(() => {
  root = new MemoryFileStore();
  handles = new MemoryFolderHandles();
  clock = Date.UTC(2026, 9, 25, 9, 0, 0);
  registry = createBrowserRegistry(root, { now, folders: folderTier() });
});

describe('a folder project', () => {
  it('lives in the folder picked: its project.json goes there, its handle is kept by id, and nothing goes in the browser’s projects', async () => {
    const notes = new FakeFolder('Notes');
    const record = await registry.create({ name: 'Notes', color: '#7C8CFF', folder: notes });

    expect(record).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{10}$/),
      name: 'Notes',
      color: '#7c8cff',
      created: '2026-10-25T09:00:00.000Z',
      createdBy: 'nebula',
      tier: 'folder',
      folder: { name: 'Notes', access: 'granted' },
    });
    expect(await metaIn(notes)).toEqual({ id: record.id, name: 'Notes', color: '#7c8cff', created: '2026-10-25T09:00:00.000Z', createdBy: 'nebula' });
    expect(await handles.get(record.id)).toBe(notes);
    expect(await registryJson()).toEqual({
      version: 1,
      projects: [{ id: record.id, tier: 'folder', folder: 'Notes', name: 'Notes', color: '#7c8cff', created: '2026-10-25T09:00:00.000Z' }],
      current: null,
    });
    expect(await paths(root)).toEqual(['registry.json']);
    expect(await registry.list()).toEqual([record]);
  });

  it('opens a folder that already holds files as they are, adding only .nebula/ beside them', async () => {
    const vault = new FakeFolder('Vault');
    await vault.files.write('Ideas.md', '# Ideas');
    await vault.files.write('Sketches/plan.excalidraw.md', 'plan');
    const { id } = await registry.create({ name: 'Vault', color: '#7c8cff', folder: vault });

    const store = await registry.open(id);
    expect(await paths(store as MemoryFileStore)).toEqual(['Ideas.md', 'Sketches', 'Sketches/plan.excalidraw.md']);
    expect(await vault.files.readText('Ideas.md')).toBe('# Ideas');
    expect(await vault.files.stat('.nebula/project.json')).not.toBeNull();
  });

  it('keeps the id, name and colour of a folder that already has a project.json', async () => {
    const shared = new FakeFolder('Shared');
    const meta = { id: 'orbitnotes', name: 'Orbit notes', color: '#2dd4bf', created: '2026-01-02T03:04:05.000Z', createdBy: 'nebula' };
    await shared.files.write('.nebula/project.json', JSON.stringify(meta));

    const record = await registry.create({ name: 'Shared', color: '#7c8cff', folder: shared });
    expect(record).toMatchObject({ id: 'orbitnotes', name: 'Orbit notes', color: '#2dd4bf', created: '2026-01-02T03:04:05.000Z', tier: 'folder' });
    expect(await metaIn(shared)).toEqual(meta);
  });

  it('is never a duplicate: the same folder picked again is the same project', async () => {
    const notes = new FakeFolder('Notes');
    const first = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    tick();
    const again = await registry.create({ name: 'Notes', color: '#fb7a5a', folder: new SameFolder(notes) });

    expect(again.id).toBe(first.id);
    expect(again.color).toBe('#7c8cff');
    expect((await registry.list()).map((project) => project.id)).toEqual([first.id]);
    expect((await registryJson()).projects).toHaveLength(1);
  });

  it('is the same project after this browser forgot which folder it was', async () => {
    const notes = new FakeFolder('Notes');
    const first = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    await handles.delete(first.id);
    expect(await registry.list()).toMatchObject([{ id: first.id, folder: { name: 'Notes', access: 'missing' } }]);

    const again = await registry.create({ name: 'Notes', color: '#7c8cff', folder: new SameFolder(notes) });
    expect(again.id).toBe(first.id);
    expect(await registry.list()).toMatchObject([{ id: first.id, folder: { access: 'granted' } }]);
  });

  it('is the same project when its folder moved and is picked where it is now', async () => {
    const notes = new FakeFolder('Notes');
    const first = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    notes.gone = true;
    // Moved: a handle to the new place, with the same files.
    const moved = new FakeFolder('Notes', notes.files);
    const again = await registry.create({ name: 'Notes', color: '#7c8cff', folder: moved });

    expect(again.id).toBe(first.id);
    expect(await handles.get(first.id)).toBe(moved);
    expect(await registry.list()).toHaveLength(1);
  });

  it('is a project of its own when it’s a copy of a folder Nebula still opens', async () => {
    const notes = new FakeFolder('Notes');
    const first = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    const copy = new FakeFolder('Notes copy');
    await copy.files.write('.nebula/project.json', await notes.files.readText('.nebula/project.json'));

    const second = await registry.create({ name: 'Notes copy', color: '#7c8cff', folder: copy });
    expect(second.id).not.toBe(first.id);
    expect(second.name).toBe('Notes');
    expect((await metaIn(copy)).id).toBe(second.id);
    expect((await metaIn(notes)).id).toBe(first.id);
    expect(await registry.list()).toHaveLength(2);
  });

  it('takes a new id when its project.json names a project in the browser (a downloaded .zip unpacked into a folder)', async () => {
    const browser = await registry.create({ name: 'Night Sky', color: '#7c8cff' });
    const unpacked = new FakeFolder('Night Sky');
    await unpacked.files.write('.nebula/project.json', JSON.stringify({ id: browser.id, name: 'Night Sky', color: '#7c8cff', created: browser.created, createdBy: 'nebula' }));

    const record = await registry.create({ name: 'Night Sky', color: '#7c8cff', folder: unpacked });
    expect(record.id).not.toBe(browser.id);
    expect(record.tier).toBe('folder');
    expect((await registry.list()).map((project) => project.tier).sort()).toEqual(['browser', 'folder']);
  });

  it('opens, and is then the current project', async () => {
    await registry.create({ name: 'Other', color: '#7c8cff' });
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    tick();
    const store = await registry.open(id);
    await store.write('Today.md', 'hello');

    expect(await notes.files.readText('Today.md')).toBe('hello');
    expect(await registry.current()).toBe(id);
    expect((await registry.list())[0]).toMatchObject({ id, lastOpened: '2026-10-25T09:01:00.000Z' });
    expect(await registry.files(id)).toBe(notes.files);
  });

  it('puts project.json back from what it remembers when the folder lost it', async () => {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#fb7a5a', folder: notes });
    await notes.files.remove('.nebula');

    await registry.open(id);
    expect(await metaIn(notes)).toMatchObject({ id, name: 'Notes', color: '#fb7a5a' });
  });

  it('takes name and colour from the folder’s project.json, which another computer may have changed', async () => {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    await notes.files.write('.nebula/project.json', JSON.stringify({ ...(await metaIn(notes)), name: 'Field notes', color: '#2dd4bf' }));

    expect(await registry.list()).toMatchObject([{ id, name: 'Field notes', color: '#2dd4bf' }]);
  });

  it('renames and recolours in the folder’s project.json, and remembers it for when the folder can’t be read', async () => {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    const updated = await registry.update(id, { name: 'Field notes', color: '#2DD4BF' });

    expect(updated).toMatchObject({ id, name: 'Field notes', color: '#2dd4bf', tier: 'folder', folder: { name: 'Notes', access: 'granted' } });
    expect(await metaIn(notes)).toMatchObject({ id, name: 'Field notes', color: '#2dd4bf' });
    notes.permission = 'prompt';
    expect(await registry.list()).toMatchObject([{ id, name: 'Field notes', color: '#2dd4bf', folder: { access: 'prompt' } }]);
  });
});

describe('removing a folder project', () => {
  it('forgets it, and never deletes the folder or its files', async () => {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    await notes.files.write('Today.md', 'keep me');
    await notes.files.write('Deep/inside.md', 'me too');
    const before = await paths(notes.files);

    await registry.remove(id);

    expect(await registry.list()).toEqual([]);
    expect(await handles.get(id)).toBeNull();
    expect((await registryJson()).projects).toEqual([]);
    expect(await paths(notes.files)).toEqual(before);
    expect(await notes.files.readText('Today.md')).toBe('keep me');
    expect(await notes.files.stat('.nebula/project.json')).not.toBeNull();
  });

  it('forgets one whose folder Nebula can’t open, touching nothing', async () => {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    notes.permission = 'denied';
    await registry.remove(id);
    notes.permission = 'granted';
    expect(await registry.list()).toEqual([]);
    expect(await notes.files.stat('.nebula/project.json')).not.toBeNull();
  });
});

describe('a folder Nebula can’t open now', () => {
  async function made(): Promise<{ notes: FakeFolder; id: string }> {
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#fb7a5a', folder: notes });
    return { notes, id };
  }

  it('waits for the person’s OK when the browser forgot the permission: listed as it was, and not opened', async () => {
    const { notes, id } = await made();
    notes.permission = 'prompt';

    expect(await registry.list()).toMatchObject([{ id, name: 'Notes', color: '#fb7a5a', tier: 'folder', folder: { name: 'Notes', access: 'prompt' } }]);
    await expect(registry.open(id)).rejects.toMatchObject({ name: 'FolderUnavailableError', access: 'prompt' });
    expect(notes.asked).toBe(0);
  });

  it('says so when the person said no', async () => {
    const { notes, id } = await made();
    notes.permission = 'denied';
    expect(await registry.list()).toMatchObject([{ id, folder: { access: 'denied' } }]);
    await expect(registry.open(id)).rejects.toMatchObject({ name: 'FolderUnavailableError', access: 'denied' });
  });

  it('says so when the folder is gone, and never makes an empty project in its place', async () => {
    const { notes, id } = await made();
    notes.gone = true;
    expect(await registry.list()).toMatchObject([{ id, folder: { access: 'missing' } }]);
    await expect(registry.open(id)).rejects.toMatchObject({ name: 'FolderUnavailableError', access: 'missing' });
    await expect(registry.files(id)).rejects.toMatchObject({ name: 'FolderUnavailableError', access: 'missing' });
    expect(await paths(root)).toEqual(['registry.json']);
  });

  it('opens once the permission is back', async () => {
    const { notes, id } = await made();
    notes.permission = 'prompt';
    await expect(registry.open(id)).rejects.toMatchObject({ access: 'prompt' });
    notes.permission = 'granted';
    await expect(registry.open(id)).resolves.toBe(notes.files);
  });

  it('keeps it as the current project, so the next visit offers the same folder', async () => {
    const { notes, id } = await made();
    await registry.open(id);
    notes.permission = 'prompt';
    expect(await registry.current()).toBe(id);
  });
});

describe('records saved before the folder tier', () => {
  // registry.json as Nebula 2.0.0 wrote it, with what a later build may add
  // (an unknown field, another tier's entry): read and carried exactly.
  const saved = {
    version: 1,
    projects: [
      { id: 'nightsky01', dir: 'nightsky01', tier: 'browser', lastOpened: '2026-10-22T10:00:00.000Z' },
      { id: 'board-a', dir: 'q8w7e6r5t4', tier: 'browser', pinned: true },
      { id: 'srv1', tier: 'server', root: '/home/x' },
    ],
    current: 'nightsky01',
    note: 'kept',
  };

  async function seed(): Promise<void> {
    await root.write('registry.json', `${JSON.stringify(saved, null, 2)}\n`);
    for (const [dir, id, name] of [
      ['nightsky01', 'nightsky01', 'Night Sky'],
      ['q8w7e6r5t4', 'board-a', 'Board A'],
    ]) {
      await root.write(`projects/${dir}/.nebula/project.json`, JSON.stringify({ id, name, color: '#7c8cff', created: '2026-10-22T09:00:00.000Z', createdBy: 'nebula' }));
    }
  }

  it('lists them exactly as before', async () => {
    await seed();
    const list = await registry.list();
    expect(list).toEqual([
      { id: 'nightsky01', name: 'Night Sky', color: '#7c8cff', created: '2026-10-22T09:00:00.000Z', createdBy: 'nebula', tier: 'browser', lastOpened: '2026-10-22T10:00:00.000Z' },
      { id: 'board-a', name: 'Board A', color: '#7c8cff', created: '2026-10-22T09:00:00.000Z', createdBy: 'nebula', tier: 'browser' },
    ]);
    expect(await registry.current()).toBe('nightsky01');
  });

  it('carries every saved entry and field through when a folder project is added', async () => {
    await seed();
    const notes = new FakeFolder('Notes');
    const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: notes });
    const json = await registryJson();
    expect(json.projects.slice(0, 3)).toEqual(saved.projects);
    expect(json.note).toBe('kept');
    expect(json.current).toBe('nightsky01');
    expect(json.projects[3]).toMatchObject({ id, tier: 'folder' });
  });

  it('reads the same with no folder tier at all (a browser that keeps nothing)', async () => {
    const plain = createBrowserRegistry(root, { now });
    await seed();
    expect((await plain.list()).map((project) => project.id)).toEqual(['nightsky01', 'board-a']);
  });
});

describe('moving a browser project to a folder', () => {
  async function browserProject(): Promise<{ id: string; dir: string }> {
    const { id } = await registry.create({ name: 'Night Sky', color: '#2dd4bf' });
    const store = await registry.open(id);
    await store.write('Guides/Observing plan.md', '# Plan');
    await store.write('Sky.png', new Blob([new Uint8Array([137, 80, 78, 71, 0, 255, 1, 2])], { type: 'image/png' }));
    await store.mkdir('Empty');
    await store.write('.nebula/workspace.json', '{"tabs":["Guides/Observing plan.md"]}');
    const dir = ((await registryJson()).projects.find((project) => project.id === id) as { dir: string }).dir;
    return { id, dir };
  }

  async function bytes(store: { readBlob(path: string): Promise<Blob> }, path: string): Promise<number[]> {
    return [...(await blobToBytes(await store.readBlob(path)))];
  }

  async function browserFiles(dir: string): Promise<string[]> {
    return (await root.list()).map((entry) => entry.path).filter((path) => path.startsWith(`projects/${dir}/`));
  }

  it('copies every file, checks each, then becomes a folder project with the same id, and the browser copy goes', async () => {
    const { id, dir } = await browserProject();
    const target = new FakeFolder('Night Sky');
    const moved = await registry.create({ name: 'Night Sky', color: '#2dd4bf', folder: target, from: id });

    expect(moved).toMatchObject({ id, name: 'Night Sky', color: '#2dd4bf', tier: 'folder', folder: { name: 'Night Sky', access: 'granted' } });
    expect(await paths(target.files)).toEqual(['Empty', 'Guides', 'Guides/Observing plan.md', 'Sky.png']);
    expect(await target.files.readText('Guides/Observing plan.md')).toBe('# Plan');
    expect(await bytes(target.files, 'Sky.png')).toEqual([137, 80, 78, 71, 0, 255, 1, 2]);
    expect(await target.files.readText('.nebula/workspace.json')).toBe('{"tabs":["Guides/Observing plan.md"]}');
    expect((await metaIn(target)).id).toBe(id);
    expect(await browserFiles(dir)).toEqual([]);
    expect(await registry.list()).toEqual([moved]);
    expect(await registry.current()).toBe(id);
    expect(await handles.get(id)).toBe(target);
  });

  it('refuses a folder with anything in it, saying why, and changes nothing', async () => {
    const { id, dir } = await browserProject();
    const before = await browserFiles(dir);
    const busy = new FakeFolder('Busy');
    await busy.files.write('Someone else’s.md', 'theirs');
    await expect(registry.create({ name: 'Night Sky', color: '#2dd4bf', folder: busy, from: id })).rejects.toMatchObject({
      name: 'FolderNotEmptyError',
      message: 'The folder ‘Busy’ isn’t empty. Choose an empty folder, so nothing in it is mixed up with the project or written over.',
    });
    const hidden = new FakeFolder('Hidden');
    await hidden.files.write('.nebula/project.json', '{}');
    await expect(registry.create({ name: 'Night Sky', color: '#2dd4bf', folder: hidden, from: id })).rejects.toMatchObject({ name: 'FolderNotEmptyError' });
    expect(await paths(busy.files)).toEqual(['Someone else’s.md']);
    expect(await browserFiles(dir)).toEqual(before);
    expect(await registry.list()).toMatchObject([{ id, tier: 'browser' }]);
  });

  it('leaves the browser project exactly as it was, and the folder empty, when a copy doesn’t read back the same', async () => {
    const { id, dir } = await browserProject();
    const before = await browserFiles(dir);
    const files = new MemoryFileStore();
    // A disk that keeps one file wrong.
    const lossy = Object.assign(Object.create(files) as MemoryFileStore, {
      write: (path: string, data: string | Blob, options?: Parameters<MemoryFileStore['write']>[2]) =>
        files.write(path, path === 'Sky.png' ? new Blob([new Uint8Array([0])]) : data, options),
    });
    const target = new FakeFolder('Night Sky', lossy);
    await expect(registry.create({ name: 'Night Sky', color: '#2dd4bf', folder: target, from: id })).rejects.toMatchObject({ name: 'FolderMoveError' });
    expect(await browserFiles(dir)).toEqual(before);
    expect(await registry.list()).toMatchObject([{ id, tier: 'browser' }]);
    expect(await handles.get(id)).toBeNull();
    expect(await paths(files)).toEqual([]);
    expect(await files.stat('.nebula')).toBeNull();
  });

  it('leaves the browser project as it was when the folder can’t be written', async () => {
    const { id, dir } = await browserProject();
    const before = await browserFiles(dir);
    const files = new MemoryFileStore();
    let writes = 0;
    const full = Object.assign(Object.create(files) as MemoryFileStore, {
      write: async (path: string, data: string | Blob, options?: Parameters<MemoryFileStore['write']>[2]) => {
        writes += 1;
        if (writes === 3) throw new DOMException('The disk is full', 'QuotaExceededError');
        return files.write(path, data, options);
      },
    });
    await expect(registry.create({ name: 'Night Sky', color: '#2dd4bf', folder: new FakeFolder('Night Sky', full), from: id })).rejects.toMatchObject({
      name: 'QuotaExceededError',
    });
    expect(await browserFiles(dir)).toEqual(before);
    expect(await registry.list()).toMatchObject([{ id, tier: 'browser' }]);
    expect(await paths(files)).toEqual([]);
  });
});
