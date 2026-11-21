import { beforeEach, describe, expect, it } from 'vitest';
import type { LockManagerLike } from './locks';
import { MemoryFileStore } from './memoryStore';
import { createBrowserRegistry, type BrowserRegistry } from './registry';
import type { FileChange, FileStore } from './types';

type RegistryJson = { version: number; projects: Array<{ id: string; dir: string; tier: string; lastOpened?: string }>; current: string | null };

let root: MemoryFileStore;
let clock: number;
let registry: BrowserRegistry;

const now = () => new Date(clock);
const tick = () => {
  clock += 60_000;
};

async function registryJson(): Promise<RegistryJson> {
  return JSON.parse(await root.readText('registry.json')) as RegistryJson;
}

async function dirOf(id: string): Promise<string> {
  const entry = (await registryJson()).projects.find((project) => project.id === id);
  if (!entry) throw new Error(`${id} is not registered`);
  return entry.dir;
}

beforeEach(() => {
  root = new MemoryFileStore();
  clock = Date.UTC(2026, 9, 22, 12, 0, 0);
  registry = createBrowserRegistry(root, { now });
});

describe('createBrowserRegistry', () => {
  it('starts with no projects and no current one', async () => {
    expect(await registry.list()).toEqual([]);
    expect(await registry.current()).toBeNull();
  });

  it("creates a project, keeping its name and colour in the project's own .nebula/project.json", async () => {
    const record = await registry.create({ name: '  Night Sky ', color: '#7C8CFF' });

    expect(record).toEqual({
      id: expect.stringMatching(/^[a-z0-9]{10}$/),
      name: 'Night Sky',
      color: '#7c8cff',
      created: '2026-10-22T12:00:00.000Z',
      createdBy: 'nebula',
      tier: 'browser',
    });
    const dir = await dirOf(record.id);
    expect(JSON.parse(await root.readText(`projects/${dir}/.nebula/project.json`))).toEqual({
      id: record.id,
      name: 'Night Sky',
      color: '#7c8cff',
      created: '2026-10-22T12:00:00.000Z',
      createdBy: 'nebula',
    });
    expect(await registryJson()).toEqual({ version: 1, projects: [{ id: record.id, dir, tier: 'browser' }], current: null });
    expect(await registry.list()).toEqual([record]);
  });

  it('refuses an empty name or a colour that is not #rrggbb, and registers nothing', async () => {
    await expect(registry.create({ name: '   ', color: '#7c8cff' })).rejects.toMatchObject({ name: 'InvalidProjectError' });
    await expect(registry.create({ name: 'Ok', color: 'red' })).rejects.toMatchObject({ name: 'InvalidProjectError' });
    await expect(registry.create({ name: 'Ok', color: '#12345' })).rejects.toMatchObject({ name: 'InvalidProjectError' });
    expect(await registry.list()).toEqual([]);
    expect(await root.list()).toEqual([]);
  });

  it('gives each new project a short random id of its own', async () => {
    const ids = new Set<string>();
    for (let index = 0; index < 12; index += 1) ids.add((await registry.create({ name: `P${index}`, color: '#7c8cff' })).id);
    expect(ids.size).toBe(12);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9]{10}$/);
  });

  it('opens a project as a store of its own files and remembers it as the current one', async () => {
    const { id } = await registry.create({ name: 'Night Sky', color: '#7c8cff' });
    tick();
    const store = await registry.open(id);
    await store.write('Guides/Orion.md', 'Orion');

    const dir = await dirOf(id);
    expect(await root.readText(`projects/${dir}/Guides/Orion.md`)).toBe('Orion');
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Guides', 'Guides/Orion.md']);
    expect(await registryJson()).toMatchObject({ current: id, projects: [{ id, lastOpened: '2026-10-22T12:01:00.000Z' }] });
    expect(await registry.current()).toBe(id);
    expect((await registry.list())[0].lastOpened).toBe('2026-10-22T12:01:00.000Z');
  });

  it('lists the most recently opened first, then the never-opened in the order they were made', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const b = await registry.create({ name: 'B', color: '#7c8cff' });
    const c = await registry.create({ name: 'C', color: '#7c8cff' });
    const d = await registry.create({ name: 'D', color: '#7c8cff' });
    tick();
    await registry.open(b.id);
    tick();
    await registry.open(d.id);

    expect((await registry.list()).map((project) => project.name)).toEqual(['D', 'B', 'A', 'C']);
    expect(await registry.current()).toBe(d.id);
    void a;
    void c;
  });

  it('takes name and colour from project.json, which is the source of truth', async () => {
    const { id } = await registry.create({ name: 'Night Sky', color: '#7c8cff' });
    const dir = await dirOf(id);
    const meta = JSON.parse(await root.readText(`projects/${dir}/.nebula/project.json`));
    await root.write(`projects/${dir}/.nebula/project.json`, JSON.stringify({ ...meta, name: 'Edited elsewhere', color: '#2dd4bf' }));

    expect(await registry.list()).toMatchObject([{ id, name: 'Edited elsewhere', color: '#2dd4bf' }]);
  });

  it('updates name and colour in project.json, refusing an empty name or a bad colour', async () => {
    const { id, created } = await registry.create({ name: 'Night Sky', color: '#7c8cff' });
    const updated = await registry.update(id, { name: ' Deep Sky ', color: '#FB7A5A' });

    expect(updated).toEqual({ id, name: 'Deep Sky', color: '#fb7a5a', created, createdBy: 'nebula', tier: 'browser' });
    const dir = await dirOf(id);
    expect(JSON.parse(await root.readText(`projects/${dir}/.nebula/project.json`))).toMatchObject({ name: 'Deep Sky', color: '#fb7a5a' });
    expect(await registry.update(id, { color: '#a78bfa' })).toMatchObject({ name: 'Deep Sky', color: '#a78bfa' });
    await expect(registry.update(id, { name: '' })).rejects.toMatchObject({ name: 'InvalidProjectError' });
    await expect(registry.update(id, { color: 'blue' })).rejects.toMatchObject({ name: 'InvalidProjectError' });
  });

  it('removes a project with all its files; current() then falls back to the most recent left', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const b = await registry.create({ name: 'B', color: '#7c8cff' });
    tick();
    await registry.open(a.id);
    tick();
    const store = await registry.open(b.id);
    await store.write('note.md', 'bye');
    const dir = await dirOf(b.id);

    await registry.remove(b.id);

    expect(await root.stat(`projects/${dir}`)).toBeNull();
    expect((await registry.list()).map((project) => project.id)).toEqual([a.id]);
    expect(await registry.current()).toBe(a.id);
    await registry.remove(a.id);
    expect(await registry.current()).toBeNull();
  });

  it('rejects opening, updating or removing a project it does not know', async () => {
    await expect(registry.open('nope')).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(registry.update('nope', { name: 'x' })).rejects.toMatchObject({ name: 'NotFoundError' });
    await expect(registry.remove('nope')).rejects.toMatchObject({ name: 'NotFoundError' });
  });

  it('can keep a given id, but never a taken or unsafe one', async () => {
    const record = await registry.create({ name: 'My First Project', color: '#7c8cff', id: 'ss-nebula' });
    expect(record.id).toBe('ss-nebula');
    expect(await dirOf('ss-nebula')).toMatch(/^[a-z0-9]{10}$/);
    await expect(registry.create({ name: 'Again', color: '#7c8cff', id: 'ss-nebula' })).rejects.toMatchObject({ name: 'FileExistsError' });
    for (const id of ['', '.', '..', 'a/b', 'has space', 'x'.repeat(65)]) {
      await expect(registry.create({ name: 'Bad', color: '#7c8cff', id }), id).rejects.toMatchObject({ name: 'InvalidProjectError' });
    }
    expect((await registry.list()).map((project) => project.id)).toEqual(['ss-nebula']);
  });

  it('shows a project whose project.json is unreadable, with its id for a name', async () => {
    const { id } = await registry.create({ name: 'Night Sky', color: '#a78bfa' });
    await root.write(`projects/${await dirOf(id)}/.nebula/project.json`, '{ not json');
    expect(await registry.list()).toMatchObject([{ id, name: id, color: '#7c8cff', tier: 'browser' }]);
  });

  it('skips a registered project whose folder has gone', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const b = await registry.create({ name: 'B', color: '#7c8cff' });
    await root.remove(`projects/${await dirOf(a.id)}`);
    expect((await registry.list()).map((project) => project.id)).toEqual([b.id]);
  });

  it('rebuilds a corrupt registry.json from the project folders, keeping the corrupt copy', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const b = await registry.create({ name: 'B', color: '#a78bfa' });
    await root.write('registry.json', '{"version": 1, "projects": [');

    expect((await registry.list()).map((project) => project.name).sort()).toEqual(['A', 'B']);
    expect((await registryJson()).projects.map((project) => project.id).sort()).toEqual([a.id, b.id].sort());
    const kept = (await root.list()).filter((entry) => entry.path.startsWith('registry.corrupt'));
    expect(kept).toHaveLength(1);
    expect(await root.readText(kept[0].path)).toBe('{"version": 1, "projects": [');
  });

  it('keeps every project when several are created at once', async () => {
    await Promise.all(['A', 'B', 'C', 'D', 'E'].map((name) => registry.create({ name, color: '#7c8cff' })));
    expect((await registry.list()).map((project) => project.name).sort()).toEqual(['A', 'B', 'C', 'D', 'E']);
  });

  it('lets two stores of the same project hear each other', async () => {
    const { id } = await registry.create({ name: 'Night Sky', color: '#7c8cff' });
    const first = await registry.open(id);
    const second = await registry.open(id);
    const heard: FileChange[] = [];
    second.watch((change) => heard.push(change));
    await first.write('a.md', 'A');
    expect(heard).toEqual([{ type: 'write', path: 'a.md' }]);
  });

  it("gives a project's files without marking it opened, for downloads", async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const b = await registry.create({ name: 'B', color: '#7c8cff' });
    await (await registry.files(b.id)).write('note.md', 'B');

    expect(await (await registry.open(b.id)).readText('note.md')).toBe('B');
    expect((await registryJson()).projects.find((project) => project.id === a.id)?.lastOpened).toBeUndefined();
    await (await registry.files(a.id)).readText('.nebula/project.json');
    expect((await registryJson()).current).toBe(b.id);
    await expect(registry.files('nope')).rejects.toMatchObject({ name: 'NotFoundError' });
  });
});

/** Web Locks for one page, saying whether a caller holds the lock right now. */
class CountingLocks implements LockManagerLike {
  held = 0;
  requests = 0;
  private tail: Promise<unknown> = Promise.resolve();

  request<T>(_name: string, callback: () => Promise<T>): Promise<T> {
    this.requests += 1;
    const run = async () => {
      this.held += 1;
      try {
        return await callback();
      } finally {
        this.held -= 1;
      }
    };
    const result = this.tail.then(run, run);
    this.tail = result.catch(() => {});
    return result;
  }
}

/** `store`, noting each path written and whether the lock was held then. */
function noting(store: FileStore, locks: CountingLocks, writes: Array<{ path: string; held: boolean }>): FileStore {
  return {
    list: () => store.list(),
    stat: (path) => store.stat(path),
    readText: (path) => store.readText(path),
    readBlob: (path) => store.readBlob(path),
    write: (path, data) => {
      writes.push({ path, held: locks.held > 0 });
      return store.write(path, data);
    },
    mkdir: (path) => store.mkdir(path),
    rename: (from, to) => store.rename(from, to),
    remove: (path) => store.remove(path),
    watch: (listener) => store.watch(listener),
  };
}

async function corruptCopies(): Promise<string[]> {
  return (await root.list()).map((entry) => entry.path).filter((path) => path.startsWith('registry.corrupt'));
}

describe('the registry when registry.json is lost, empty or damaged', () => {
  it('adopts a project folder that registry.json lost, as when two tabs wrote it at once', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const before = await root.readText('registry.json');
    tick();
    const b = await registry.create({ name: 'B', color: '#a78bfa' });
    // Another tab writes what it read before B was made.
    await root.write('registry.json', before);

    expect((await registry.list()).map((project) => [project.id, project.name])).toEqual([
      [a.id, 'A'],
      [b.id, 'B'],
    ]);
    expect((await registryJson()).projects.map((project) => project.id)).toEqual([a.id, b.id]);
    expect(await (await registry.open(b.id)).readText('.nebula/project.json')).toContain('"name": "B"');
    expect(await corruptCopies()).toEqual([]);
  });

  it('adopts a lost folder only once, however many lists run at once', async () => {
    await registry.create({ name: 'A', color: '#7c8cff' });
    const before = await root.readText('registry.json');
    await registry.create({ name: 'B', color: '#a78bfa' });
    await root.write('registry.json', before);

    await Promise.all([registry.list(), registry.list(), registry.list()]);
    expect((await registryJson()).projects).toHaveLength(2);
  });

  it('leaves alone a folder with no project.json, and one a registered project already has', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    await root.write('projects/strayfolder/notes.md', 'not a project');

    expect((await registry.list()).map((project) => project.id)).toEqual([a.id]);
    expect((await registryJson()).projects.map((project) => project.id)).toEqual([a.id]);
    expect(await root.readText('projects/strayfolder/notes.md')).toBe('not a project');
  });

  it('counts an empty registry.json as not yet written: no rebuild, no corrupt copy, and the projects are still found', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    await root.write('registry.json', '');

    expect((await registry.list()).map((project) => project.id)).toEqual([a.id]);
    expect(await corruptCopies()).toEqual([]);
    expect((await registryJson()).projects.map((project) => project.id)).toEqual([a.id]);
  });

  it('rebuilds a corrupt registry.json once, holding the lock, however many readers find it', async () => {
    const locks = new CountingLocks();
    const writes: Array<{ path: string; held: boolean }> = [];
    let time = clock;
    const locked = createBrowserRegistry(noting(root, locks, writes), { now: () => new Date((time += 1000)), locks });
    const a = await locked.create({ name: 'A', color: '#7c8cff' });
    await locked.create({ name: 'B', color: '#a78bfa' });
    await root.write('registry.json', '{"version": 1, "projects": [');
    writes.length = 0;

    const [listed, , store] = await Promise.all([locked.list(), locked.current(), locked.files(a.id)]);
    expect(listed.map((project) => project.name).sort()).toEqual(['A', 'B']);
    expect(await store.readText('.nebula/project.json')).toContain('"name": "A"');
    expect(await corruptCopies()).toHaveLength(1);
    expect(writes.filter((write) => write.path.startsWith('registry'))).not.toEqual([]);
    expect(writes.filter((write) => !write.held)).toEqual([]);
  });

  it('keeps both projects when a folder claims an id that is already registered, giving the newcomer its folder name', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const before = await root.readText('registry.json');
    tick();
    const b = await registry.create({ name: 'B', color: '#a78bfa' });
    const dirB = await dirOf(b.id);
    const metaB = JSON.parse(await root.readText(`projects/${dirB}/.nebula/project.json`));
    await root.write(`projects/${dirB}/.nebula/project.json`, JSON.stringify({ ...metaB, id: a.id }));
    await root.write('registry.json', before);

    expect((await registry.list()).map((project) => [project.id, project.name])).toEqual([
      [a.id, 'A'],
      [dirB, 'B'],
    ]);
    // project.json is left as it was: the registry decides the id.
    expect(JSON.parse(await root.readText(`projects/${dirB}/.nebula/project.json`)).id).toBe(a.id);
  });

  it('keeps both projects when a rebuild finds two project.json with the same id, the older keeping it', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    tick();
    const b = await registry.create({ name: 'B', color: '#a78bfa' });
    const dirA = await dirOf(a.id);
    const dirB = await dirOf(b.id);
    const metaB = JSON.parse(await root.readText(`projects/${dirB}/.nebula/project.json`));
    await root.write(`projects/${dirB}/.nebula/project.json`, JSON.stringify({ ...metaB, id: a.id }));
    await root.write('registry.json', 'not json');

    const listed = await registry.list();
    expect(listed.map((project) => [project.id, project.name]).sort()).toEqual([
      [a.id, 'A'],
      [dirB, 'B'],
    ].sort());
    expect((await registryJson()).projects.find((entry) => entry.id === a.id)?.dir).toBe(dirA);
  });
});

describe('a registry.json this build does not fully understand', () => {
  it('opens one written by a newer Nebula read-only, says so, and never writes it', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const dir = await dirOf(a.id);
    const text = `${JSON.stringify({ version: 2, projects: [{ id: a.id, dir, tier: 'browser', pinned: true }, { id: 'f1', tier: 'folder', handle: 'idb:1' }], current: 'f1', groups: [{ name: 'Work' }] }, null, 2)}\n`;
    await root.write('registry.json', text);
    const newer = createBrowserRegistry(root, { now });

    expect((await newer.list()).map((project) => [project.id, project.name])).toEqual([[a.id, 'A']]);
    expect(newer.readOnly).toBe(true);
    await expect(newer.create({ name: 'B', color: '#7c8cff' })).rejects.toMatchObject({ name: 'ReadOnlyRegistryError', message: expect.stringMatching(/newer/) });
    await expect(newer.update(a.id, { name: 'X' })).rejects.toMatchObject({ name: 'ReadOnlyRegistryError' });
    await expect(newer.remove(a.id)).rejects.toMatchObject({ name: 'ReadOnlyRegistryError' });
    expect(await (await newer.open(a.id)).readText('.nebula/project.json')).toContain('"name": "A"');
    expect(await newer.current()).toBe(a.id);

    expect(await root.readText('registry.json')).toBe(text);
    expect(await corruptCopies()).toEqual([]);
    expect(JSON.parse(await root.readText(`projects/${dir}/.nebula/project.json`)).name).toBe('A');
  });

  it('is not read-only for a registry it wrote, or before one exists', async () => {
    expect(registry.readOnly).toBe(false);
    await registry.create({ name: 'A', color: '#7c8cff' });
    await registry.list();
    expect(registry.readOnly).toBe(false);
  });

  it('carries entries and fields it does not know through every write, verbatim', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const dir = await dirOf(a.id);
    const folder = { id: 'f1', tier: 'folder', handle: 'idb:1', name: 'Vault' };
    await root.write('registry.json', JSON.stringify({ version: 1, projects: [{ id: a.id, dir, tier: 'browser', pinned: true }, folder], current: 'f1', theme: 'nebula' }));

    const b = await registry.create({ name: 'B', color: '#a78bfa' });
    expect(await registryJson()).toMatchObject({ projects: [{ id: a.id, pinned: true }, folder, { id: b.id }], current: 'f1', theme: 'nebula' });
    // The browser tier can't open a folder project, so startup falls back to one of its own.
    expect(await registry.current()).toBe(a.id);
    tick();
    await registry.open(a.id);
    await registry.update(a.id, { name: 'A2' });
    await registry.remove(b.id);

    expect(await registryJson()).toEqual({
      version: 1,
      projects: [{ id: a.id, dir, tier: 'browser', pinned: true, lastOpened: '2026-10-22T12:01:00.000Z' }, folder],
      current: a.id,
      theme: 'nebula',
    });
    expect((await registry.list()).map((project) => project.name)).toEqual(['A2']);
  });

  it('never adopts a folder that an entry of another tier names', async () => {
    const a = await registry.create({ name: 'A', color: '#7c8cff' });
    const dir = await dirOf(a.id);
    await root.write('projects/syncedfolder/.nebula/project.json', JSON.stringify({ id: 'synced', name: 'Synced' }));
    await root.write('registry.json', JSON.stringify({ version: 1, projects: [{ id: a.id, dir, tier: 'browser' }, { id: 'synced', dir: 'syncedfolder', tier: 'sync' }], current: null }));

    expect((await registry.list()).map((project) => project.id)).toEqual([a.id]);
    expect((await registryJson()).projects).toHaveLength(2);
  });
});
