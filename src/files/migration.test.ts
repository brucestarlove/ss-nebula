import { beforeEach, describe, expect, it } from 'vitest';

import hexagonText from '../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { createEmptyNebulaMetadata, type NebulaExcalidrawMetadata } from '../nebula/excalidraw/metadata';
import { isObsidianExcalidrawMarkdown, readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { createEmptyExcalidrawScene, type ExcalidrawScene } from '../nebula/excalidraw/scene';
import type { NebulaExcalidrawDocument } from '../nebula/storage/types';
import { MemoryFileStore } from './memoryStore';
import { MIGRATION_MARKER, findMigratedCanvas, migrateLegacyCanvases, migratedCanvases, newerLegacyCanvases } from './migration';
import { createBrowserRegistry, type BrowserRegistry } from './registry';
import type { FileStore } from './types';

// Fixtures in the shape LocalStorageSceneStore saves (see its test file).
function document(overrides: Partial<NebulaExcalidrawDocument> = {}): NebulaExcalidrawDocument {
  return {
    type: 'starscape.nebula.excalidraw',
    version: 1,
    boardId: 'board-a',
    canvasId: 'canvas-a',
    name: 'Canvas A',
    updatedAt: '2026-05-29T12:00:00.000Z',
    scene: createEmptyExcalidrawScene(),
    nebula: createEmptyNebulaMetadata(),
    ...overrides,
  };
}

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const withImage: ExcalidrawScene = {
  type: 'excalidraw',
  version: 2,
  source: 'https://nebula.starscape.app',
  elements: [
    {
      id: 'img-1',
      type: 'image',
      x: 40,
      y: 60,
      width: 120,
      height: 120,
      angle: 0,
      fileId: 'f-pleiades',
      status: 'saved',
      scale: [1, 1],
      crop: null,
      groupIds: [],
      frameId: null,
      boundElements: null,
      link: null,
      locked: false,
      seed: 1,
      version: 3,
      versionNonce: 7,
      isDeleted: false,
      updated: 1761100000000,
    },
  ],
  appState: { viewBackgroundColor: 'transparent', theme: 'dark', zoom: { value: 1.5 } },
  files: {
    'f-pleiades': { mimeType: 'image/png', id: 'f-pleiades', dataURL: PNG, created: 1761100000000, lastRetrieved: 1761100000500 },
  },
};

const orbitMetadata: NebulaExcalidrawMetadata = {
  ticketLinks: [{ ticketId: 'ORB-12', elementIds: ['img-1'], label: 'Launch' }],
  missionFrames: [],
  artifactRefs: [],
  semanticIndex: { summary: 'The launch plan' },
};

function key(boardId: string, canvasId: string): string {
  return `nebula:excalidraw:${encodeURIComponent(boardId)}:${encodeURIComponent(canvasId)}`;
}

function seed(doc: NebulaExcalidrawDocument): string {
  const storageKey = key(doc.boardId, doc.canvasId);
  window.localStorage.setItem(storageKey, JSON.stringify(doc));
  return storageKey;
}

function snapshot(): Record<string, string> {
  const all: Record<string, string> = {};
  for (let index = 0; index < window.localStorage.length; index += 1) {
    const name = window.localStorage.key(index) as string;
    all[name] = window.localStorage.getItem(name) as string;
  }
  return all;
}

/** The one change the Obsidian format makes to real Excalidraw elements: null collections become []. */
function asWritten(elements: ExcalidrawScene['elements']): ExcalidrawScene['elements'] {
  return elements.map((element) => ({ ...element, boundElements: element.boundElements ?? [], groupIds: element.groupIds ?? [] }));
}

async function sceneAt(store: FileStore, path: string): Promise<ExcalidrawScene> {
  const text = await store.readText(path);
  expect(isObsidianExcalidrawMarkdown(text)).toBe(true);
  expect(text).toContain('```compressed-json');
  return readObsidianExcalidrawMarkdown(text);
}

let root: MemoryFileStore;
let registry: BrowserRegistry;

beforeEach(() => {
  window.localStorage.clear();
  root = new MemoryFileStore();
  registry = createBrowserRegistry(root);
});

/** A store that passes everything through, except what `overrides` replaces. */
function wrapStore(store: FileStore, overrides: Partial<FileStore> = {}): FileStore {
  return {
    list: () => store.list(),
    stat: (path) => store.stat(path),
    readText: (path) => store.readText(path),
    readBlob: (path) => store.readBlob(path),
    write: (path, data) => store.write(path, data),
    mkdir: (path) => store.mkdir(path),
    rename: (from, to) => store.rename(from, to),
    remove: (path) => store.remove(path),
    watch: (listener) => store.watch(listener),
    ...overrides,
  };
}

/** Web Locks for one origin: requests for a name run one at a time, in order.
 * A tab's locks go when the tab does, so a closed tab is a FakeLocks nobody
 * else shares. */
class FakeLocks {
  readonly requested: string[] = [];
  private readonly tails = new Map<string, Promise<unknown>>();

  request<T>(name: string, callback: () => Promise<T>): Promise<T> {
    this.requested.push(name);
    const run = (this.tails.get(name) ?? Promise.resolve()).then(() => callback());
    this.tails.set(name, run.catch(() => {}));
    return run;
  }
}

/** localStorage once it's full: reads work, every setItem throws. */
function fullStorage(storage: Storage): Storage {
  return {
    get length() {
      return storage.length;
    },
    key: (index) => storage.key(index),
    getItem: (name) => storage.getItem(name),
    removeItem: (name) => storage.removeItem(name),
    clear: () => storage.clear(),
    setItem: () => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    },
  };
}

async function until(condition: () => boolean): Promise<void> {
  for (let tries = 0; !condition(); tries += 1) {
    if (tries > 200) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** The project folders on disk, whatever registry.json says. */
async function projectFolders(): Promise<string[]> {
  return (await root.list()).filter((entry) => entry.type === 'dir' && /^projects\/[^/]+$/.test(entry.path)).map((entry) => entry.path);
}

/** Two boards as Nebula 1.x left them: the default one with two canvases, and one with an awkward id. */
function seedTwoBoards() {
  const keys = {
    main: seed(document({ boardId: 'ss-nebula', canvasId: 'main', name: 'Winter hexagon', scene: hexagon })),
    ideas: seed(document({ boardId: 'ss-nebula', canvasId: 'ideas', name: 'Launch plan', scene: withImage, nebula: orbitMetadata })),
    awkward: seed(document({ boardId: 'board/a', canvasId: 'canvas b', name: 'Plan: phase 1/2', scene: withImage })),
  };
  window.localStorage.setItem('nebula:excalidraw-libraries:ss-nebula', '{"collections":[],"activeId":"personal"}');
  window.localStorage.setItem('nebula:excalidraw-libraries:board/a', '{"collections":[{"id":"personal","name":"Personal Library","items":[{"id":"x"}],"createdAt":1}],"activeId":"personal"}');
  window.localStorage.setItem('nebula:excalidraw-library:board/a', '[{"id":"legacy-item"}]');
  window.localStorage.setItem('unrelated:key', 'left alone');
  return keys;
}

describe('migrateLegacyCanvases', () => {
  it('moves each board into a project and each canvas into a compressed .excalidraw.md at its root', async () => {
    const keys = seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect(report.status).toBe('migrated');
    const projects = await registry.list();
    expect(projects.map(({ id, name, color }) => ({ id, name, color }))).toEqual([
      { id: 'ss-nebula', name: 'My First Project', color: '#7c8cff' },
      { id: expect.stringMatching(/^[a-z0-9]{10}$/), name: 'board/a', color: '#a78bfa' },
    ]);

    const mine = await registry.files('ss-nebula');
    expect((await mine.list()).map((entry) => entry.path)).toEqual(['Launch plan.excalidraw.md', 'Winter hexagon.excalidraw.md']);
    const winter = await sceneAt(mine, 'Winter hexagon.excalidraw.md');
    expect(winter.elements).toEqual(asWritten(hexagon.elements));
    expect(winter.files).toEqual({});
    const launch = await sceneAt(mine, 'Launch plan.excalidraw.md');
    expect(launch.elements).toEqual(asWritten(withImage.elements));
    expect(launch.files).toEqual(withImage.files);

    const theirs = await registry.files(projects[1].id);
    expect((await theirs.list()).map((entry) => entry.path)).toEqual(['Plan- phase 1-2.excalidraw.md']);
    expect((await sceneAt(theirs, 'Plan- phase 1-2.excalidraw.md')).files).toEqual(withImage.files);

    expect(report.keys.sort()).toEqual([keys.main, keys.ideas, keys.awkward].sort());
    expect(report.projects).toEqual([
      {
        boardId: 'ss-nebula',
        projectId: 'ss-nebula',
        name: 'My First Project',
        files: [
          { key: keys.main, canvasId: 'main', path: 'Winter hexagon.excalidraw.md' },
          { key: keys.ideas, canvasId: 'ideas', path: 'Launch plan.excalidraw.md' },
        ],
      },
      { boardId: 'board/a', projectId: projects[1].id, name: 'board/a', files: [{ key: keys.awkward, canvasId: 'canvas b', path: 'Plan- phase 1-2.excalidraw.md' }] },
    ]);
  });

  it('keeps the board id, so its libraries carry on, and copies the libraries of a board that needs a new id', async () => {
    seedTwoBoards();
    const before = snapshot();
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    const newId = (await registry.list())[1].id;

    expect(window.localStorage.getItem(`nebula:excalidraw-libraries:${newId}`)).toBe(before['nebula:excalidraw-libraries:board/a']);
    expect(window.localStorage.getItem(`nebula:excalidraw-library:${newId}`)).toBe(before['nebula:excalidraw-library:board/a']);
    expect(Object.keys(snapshot()).filter((name) => name.includes('ss-nebula'))).toEqual(Object.keys(before).filter((name) => name.includes('ss-nebula')));
  });

  it('never deletes or changes a legacy key, and only adds the marker and library copies', async () => {
    seedTwoBoards();
    const before = snapshot();
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    const after = snapshot();
    const newId = (await registry.list())[1].id;

    for (const [name, value] of Object.entries(before)) expect(after[name], name).toBe(value);
    expect(Object.keys(after).filter((name) => !(name in before)).sort()).toEqual(
      [MIGRATION_MARKER, `nebula:excalidraw-libraries:${newId}`, `nebula:excalidraw-library:${newId}`].sort(),
    );
  });

  it('writes non-empty Orbit metadata to .nebula/legacy-metadata.json, keyed by canvas file', async () => {
    const keys = seedTwoBoards();
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    const mine = await registry.files('ss-nebula');
    expect(JSON.parse(await mine.readText('.nebula/legacy-metadata.json'))).toEqual({
      'Launch plan.excalidraw.md': { key: keys.ideas, boardId: 'ss-nebula', canvasId: 'ideas', nebula: orbitMetadata },
    });
    const theirs = await registry.files((await registry.list())[1].id);
    expect(await theirs.stat('.nebula/legacy-metadata.json')).toBeNull();
  });

  it('sets the marker, and a second run changes nothing', async () => {
    seedTwoBoards();
    const first = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    const marker = JSON.parse(window.localStorage.getItem(MIGRATION_MARKER) as string);
    expect(marker).toEqual({ at: expect.any(String), projects: first.projects.map((project) => project.projectId), keys: first.keys });
    expect(new Date(marker.at).toString()).not.toBe('Invalid Date');

    const storageBefore = snapshot();
    const projectsBefore = await registry.list();
    const second = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect(second).toEqual({ status: 'already-done', projects: [], keys: [], skipped: [] });
    expect(snapshot()).toEqual(storageBefore);
    expect(await registry.list()).toEqual(projectsBefore);
  });

  it('numbers canvases whose names clash, names unnamed ones after their canvas id, and makes names safe', async () => {
    seed(document({ boardId: 'ss-nebula', canvasId: 'main', name: 'Sketch' }));
    seed(document({ boardId: 'ss-nebula', canvasId: 'second', name: 'sketch' }));
    seed(document({ boardId: 'ss-nebula', canvasId: 'untitled-1', name: '' }));
    seed(document({ boardId: 'ss-nebula', canvasId: 'dots', name: '..hidden?*' }));
    seed(document({ boardId: 'ss-nebula', canvasId: 'blank', name: '   ' }));
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect((await (await registry.files('ss-nebula')).list()).map((entry) => entry.path)).toEqual([
      'Sketch.excalidraw.md',
      'blank.excalidraw.md',
      'hidden--.excalidraw.md',
      'sketch 2.excalidraw.md',
      'untitled-1.excalidraw.md',
    ]);
  });

  it('keeps a valid board id such as Team.Board_1-x, and gives unusual ones a new id', async () => {
    seed(document({ boardId: 'Team.Board_1-x', canvasId: 'main' }));
    seed(document({ boardId: '..', canvasId: 'main' }));
    seed(document({ boardId: 'Ünïcode board', canvasId: 'main' }));
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    const projects = await registry.list();
    expect(projects.map((project) => project.name)).toEqual(['..', 'Team.Board_1-x', 'Ünïcode board']);
    expect(projects.find((project) => project.name === 'Team.Board_1-x')?.id).toBe('Team.Board_1-x');
    for (const name of ['..', 'Ünïcode board']) expect(projects.find((project) => project.name === name)?.id).toMatch(/^[a-z0-9]{10}$/);
  });

  it('gives each project the first planet colour not already taken', async () => {
    await registry.create({ name: 'Already here', color: '#7c8cff' });
    seed(document({ boardId: 'ss-nebula', canvasId: 'main' }));
    seed(document({ boardId: 'second', canvasId: 'main' }));
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect((await registry.list()).map((project) => [project.name, project.color])).toEqual([
      ['Already here', '#7c8cff'],
      ['My First Project', '#a78bfa'],
      ['second', '#e879f9'],
    ]);
  });

  it('skips keys that hold no valid document, and reports them', async () => {
    seed(document({ boardId: 'ss-nebula', canvasId: 'main' }));
    window.localStorage.setItem('nebula:excalidraw:ss-nebula:bad-json', '{not-json');
    window.localStorage.setItem('nebula:excalidraw:ss-nebula:wrong-type', JSON.stringify({ ...document(), type: 'excalidraw' }));
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect(report.status).toBe('migrated');
    expect(report.skipped.sort()).toEqual(['nebula:excalidraw:ss-nebula:bad-json', 'nebula:excalidraw:ss-nebula:wrong-type']);
    expect((await (await registry.files('ss-nebula')).list()).map((entry) => entry.path)).toEqual(['Canvas A.excalidraw.md']);
  });

  it('with nothing to migrate, creates nothing and sets the marker', async () => {
    window.localStorage.setItem('nebula:excalidraw-libraries:ss-nebula', '{}');
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect(report).toEqual({ status: 'nothing-to-migrate', projects: [], keys: [], skipped: [] });
    expect(await registry.list()).toEqual([]);
    expect(JSON.parse(window.localStorage.getItem(MIGRATION_MARKER) as string)).toMatchObject({ projects: [], keys: [] });
  });

  it('does nothing when the browser keeps nothing, so the canvases wait in localStorage', async () => {
    seedTwoBoards();
    const before = snapshot();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: false });

    expect(report).toEqual({ status: 'not-persistent', projects: [], keys: [], skipped: [], reason: expect.stringMatching(/localStorage/) });
    expect(snapshot()).toEqual(before);
    expect(await registry.list()).toEqual([]);
  });
});

describe('migrateLegacyCanvases when something goes wrong', () => {
  /** The registry, with every project's store wrapped. */
  function faulty(wrap: (store: FileStore) => FileStore): BrowserRegistry {
    return { ...registry, files: async (id) => wrap(await registry.files(id)), open: async (id) => wrap(await registry.open(id)) };
  }

  it('removes every project it made, sets no marker and reports the error when a write fails', async () => {
    seedTwoBoards();
    const before = snapshot();
    let writes = 0;
    const broken = faulty((store) => ({
      ...store,
      list: () => store.list(),
      stat: (path) => store.stat(path),
      readText: (path) => store.readText(path),
      readBlob: (path) => store.readBlob(path),
      mkdir: (path) => store.mkdir(path),
      rename: (from, to) => store.rename(from, to),
      remove: (path) => store.remove(path),
      watch: (listener) => store.watch(listener),
      async write(path, data) {
        writes += 1;
        if (writes === 4) throw new Error('QuotaExceededError: the disk is full');
        return store.write(path, data);
      },
    }));
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: broken, persistent: true });

    expect(report).toMatchObject({ status: 'failed', error: expect.stringContaining('the disk is full') });
    expect(await registry.list()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('fails, and rolls back, when a written canvas does not read back the same', async () => {
    seed(document({ boardId: 'ss-nebula', canvasId: 'main', name: 'Launch plan', scene: withImage }));
    const before = snapshot();
    const tampering = faulty((store) => ({
      list: () => store.list(),
      stat: (path) => store.stat(path),
      readText: async (path) => (await store.readText(path)).replace(/```compressed-json\n[\s\S]*?```/, '```json\n{"type":"excalidraw","elements":[]}\n```'),
      readBlob: (path) => store.readBlob(path),
      write: (path, data) => store.write(path, data),
      mkdir: (path) => store.mkdir(path),
      rename: (from, to) => store.rename(from, to),
      remove: (path) => store.remove(path),
      watch: (listener) => store.watch(listener),
    }));
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: tampering, persistent: true });

    expect(report).toMatchObject({ status: 'failed', error: expect.stringContaining('Launch plan.excalidraw.md') });
    // Its only canvas was left out, so nothing moved: the run fails and the next start tries again.
    expect(report.failed).toEqual([expect.objectContaining({ canvasId: 'main', name: 'Launch plan', error: expect.stringContaining('did not read back the same') })]);
    expect(await registry.list()).toEqual([]);
    expect(await projectFolders()).toEqual([]);
    expect(snapshot()).toEqual(before);
  });

  it('fails when only an embedded image comes back different', async () => {
    seed(document({ boardId: 'ss-nebula', canvasId: 'main', name: 'Launch plan', scene: withImage }));
    const tampering = faulty((store) => ({
      list: () => store.list(),
      stat: (path) => store.stat(path),
      async readText(path) {
        const scene = readObsidianExcalidrawMarkdown(await store.readText(path));
        const files = { 'f-pleiades': { ...(scene.files?.['f-pleiades'] as object), dataURL: `${PNG.slice(0, -4)}AAA=` } };
        return toObsidianExcalidrawMarkdown({ ...scene, files });
      },
      readBlob: (path) => store.readBlob(path),
      write: (path, data) => store.write(path, data),
      mkdir: (path) => store.mkdir(path),
      rename: (from, to) => store.rename(from, to),
      remove: (path) => store.remove(path),
      watch: (listener) => store.watch(listener),
    }));
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: tampering, persistent: true });

    expect(report).toMatchObject({ status: 'failed', error: expect.stringContaining('embedded files changed') });
    expect(window.localStorage.getItem(MIGRATION_MARKER)).toBeNull();
  });
});

describe('migrateLegacyCanvases across tabs and interruptions', () => {
  /** A registry over the same tree, as another tab would open it, with its projects' stores wrapped. */
  function tab(wrap: (store: FileStore) => FileStore = (store) => store): BrowserRegistry {
    const other = createBrowserRegistry(root);
    return { ...other, files: async (id) => wrap(await other.files(id)), open: async (id) => wrap(await other.open(id)) };
  }

  it('cleans up after a tab closed mid-migration, then migrates once', async () => {
    seedTwoBoards();
    let writes = 0;
    // The second canvas never finishes writing: the tab closed under it.
    const closing = tab((store) =>
      wrapStore(store, {
        write(path, data) {
          writes += 1;
          return writes === 2 ? new Promise<void>(() => {}) : store.write(path, data);
        },
      }),
    );
    void migrateLegacyCanvases({ storage: window.localStorage, registry: closing, persistent: true, locks: new FakeLocks() });
    await until(() => writes === 2);
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project']);

    // The tab's lock went with it. The next visit opens the same tree.
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: tab(), persistent: true, locks: new FakeLocks() });

    expect(report.status).toBe('migrated');
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
    expect(await projectFolders()).toHaveLength(2);
    expect((await (await registry.files('ss-nebula')).list()).map((entry) => entry.path)).toEqual(['Launch plan.excalidraw.md', 'Winter hexagon.excalidraw.md']);
  });

  it('reports what it could not take back after a failure, and cleans that up on the next run', async () => {
    seedTwoBoards();
    let writes = 0;
    const failing = tab((store) =>
      wrapStore(store, {
        async write(path, data) {
          writes += 1;
          if (writes === 4) throw new Error('the disk is full');
          return store.write(path, data);
        },
      }),
    );
    const stuck: BrowserRegistry = { ...failing, remove: async () => Promise.reject(new Error('the folder is in use')) };
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: stuck, persistent: true, locks: new FakeLocks() });

    expect(report).toMatchObject({ status: 'failed', error: expect.stringContaining('the disk is full') });
    expect(report.rollbackErrors).toEqual([expect.stringContaining('the folder is in use'), expect.stringContaining('the folder is in use')]);
    expect(report.error).toMatch(/couldn’t take back/);
    expect(window.localStorage.getItem(MIGRATION_MARKER)).toBeNull();

    const again = await migrateLegacyCanvases({ storage: window.localStorage, registry: tab(), persistent: true, locks: new FakeLocks() });
    expect(again.status).toBe('migrated');
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
    expect(await projectFolders()).toHaveLength(2);
    const libraries = Object.keys(snapshot()).filter((name) => name.startsWith('nebula:excalidraw-libraries:'));
    expect(libraries.sort()).toEqual(['nebula:excalidraw-libraries:board/a', `nebula:excalidraw-libraries:${again.projects[1].projectId}`, 'nebula:excalidraw-libraries:ss-nebula'].sort());
  });

  it('runs once when two tabs start it at the same moment, the second finding it done', async () => {
    seedTwoBoards();
    const locks = new FakeLocks();
    const reports = await Promise.all([
      migrateLegacyCanvases({ storage: window.localStorage, registry: tab(), persistent: true, locks }),
      migrateLegacyCanvases({ storage: window.localStorage, registry: tab(), persistent: true, locks }),
    ]);

    expect(reports.map((report) => report.status).sort()).toEqual(['already-done', 'migrated']);
    expect(locks.requested).toEqual(['nebula:migration', 'nebula:migration']);
    expect(await projectFolders()).toHaveLength(2);
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
  });
});

describe('migrateLegacyCanvases when localStorage is full', () => {
  it('migrates, and stays migrated, with its record kept in the tree rather than in localStorage', async () => {
    seedTwoBoards();
    const full = fullStorage(window.localStorage);
    const report = await migrateLegacyCanvases({ storage: full, registry, persistent: true });

    expect(report.status).toBe('migrated');
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project', 'board/a']);
    expect(JSON.parse(await root.readText('migration.json'))).toMatchObject({ version: 1, status: 'done', projects: report.projects.map((project) => project.projectId) });
    expect(window.localStorage.getItem(MIGRATION_MARKER)).toBeNull();

    const again = await migrateLegacyCanvases({ storage: full, registry, persistent: true });
    expect(again.status).toBe('already-done');
    expect(await projectFolders()).toHaveLength(2);
  });

  it('keeps a project whose library copy does not fit, and says so', async () => {
    seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: fullStorage(window.localStorage), registry, persistent: true });
    const newId = report.projects[1].projectId;

    expect(report.warnings).toEqual([expect.stringContaining('board/a')]);
    expect(report.warnings?.[0]).toMatch(/library/i);
    expect(window.localStorage.getItem(`nebula:excalidraw-libraries:${newId}`)).toBeNull();
    expect((await (await registry.files(newId)).list()).map((entry) => entry.path)).toEqual(['Plan- phase 1-2.excalidraw.md']);
  });

  it('copies the marker into localStorage when there is room, as before', async () => {
    seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    expect(report.warnings).toBeUndefined();
    expect(JSON.parse(window.localStorage.getItem(MIGRATION_MARKER) as string)).toEqual({
      at: expect.any(String),
      projects: report.projects.map((project) => project.projectId),
      keys: report.keys,
    });
  });
});

describe('where each old canvas went', () => {
  it('is kept in migration.json: key, board, canvas, project, path and the version that moved', async () => {
    const keys = seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    const newId = report.projects[1].projectId;

    const record = JSON.parse(await root.readText('migration.json'));
    expect(record.canvases).toEqual([
      { key: keys.main, boardId: 'ss-nebula', canvasId: 'main', projectId: 'ss-nebula', path: 'Winter hexagon.excalidraw.md', updatedAt: '2026-05-29T12:00:00.000Z' },
      { key: keys.ideas, boardId: 'ss-nebula', canvasId: 'ideas', projectId: 'ss-nebula', path: 'Launch plan.excalidraw.md', updatedAt: '2026-05-29T12:00:00.000Z' },
      { key: keys.awkward, boardId: 'board/a', canvasId: 'canvas b', projectId: newId, path: 'Plan- phase 1-2.excalidraw.md', updatedAt: '2026-05-29T12:00:00.000Z' },
    ]);
    expect(await migratedCanvases(registry)).toEqual(record.canvases);
  });

  it('answers an old link: the project and file a board’s canvas became', async () => {
    seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });

    expect(await findMigratedCanvas(registry, { boardId: 'ss-nebula', canvasId: 'ideas' })).toEqual({ projectId: 'ss-nebula', path: 'Launch plan.excalidraw.md' });
    expect(await findMigratedCanvas(registry, { boardId: 'board/a', canvasId: 'canvas b' })).toEqual({ projectId: report.projects[1].projectId, path: 'Plan- phase 1-2.excalidraw.md' });
    expect(await findMigratedCanvas(registry, { boardId: 'ss-nebula', canvasId: 'never-saved' })).toBeNull();
    expect(await findMigratedCanvas(registry, { boardId: 'board', canvasId: 'a:canvas b' })).toBeNull();
  });

  it('answers nothing before anything moved', async () => {
    seedTwoBoards();
    expect(await findMigratedCanvas(registry, { boardId: 'ss-nebula', canvasId: 'main' })).toBeNull();
    expect(await migratedCanvases(registry)).toEqual([]);
    expect(await newerLegacyCanvases({ storage: window.localStorage, registry })).toEqual([]);
  });

  it('lists old canvases saved again after they moved, and ones that never moved', async () => {
    const keys = seedTwoBoards();
    await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    // A Nebula 1.x tab left open saves one canvas again and starts another.
    seed(document({ boardId: 'ss-nebula', canvasId: 'ideas', name: 'Launch plan', scene: withImage, nebula: orbitMetadata, updatedAt: '2026-10-23T08:00:00.000Z' }));
    const late = seed(document({ boardId: 'ss-nebula', canvasId: 'late', name: 'Late idea', updatedAt: '2026-10-23T09:00:00.000Z' }));

    expect(await newerLegacyCanvases({ storage: window.localStorage, registry })).toEqual([
      {
        key: keys.ideas,
        boardId: 'ss-nebula',
        canvasId: 'ideas',
        name: 'Launch plan',
        updatedAt: '2026-10-23T08:00:00.000Z',
        migrated: { projectId: 'ss-nebula', path: 'Launch plan.excalidraw.md', updatedAt: '2026-05-29T12:00:00.000Z' },
      },
      { key: late, boardId: 'ss-nebula', canvasId: 'late', name: 'Late idea', updatedAt: '2026-10-23T09:00:00.000Z', migrated: null },
    ]);
  });
});

describe('migrateLegacyCanvases with a canvas that does not read back the same (review finding 9)', () => {
  /** The registry, with one file's read-back broken the way a bad payload would be. */
  function breaking(path: string): BrowserRegistry {
    const wrap = (store: FileStore) =>
      wrapStore(store, {
        readText: async (name) => {
          const text = await store.readText(name);
          return name === path ? text.replace(/```compressed-json\n[\s\S]*?\n```/, '```compressed-json\n!!!!\n```') : text;
        },
      });
    return { ...registry, files: async (id) => wrap(await registry.files(id)), open: async (id) => wrap(await registry.open(id)) };
  }

  it('leaves that canvas out and reports it, while the rest of its board and the other boards move', async () => {
    const keys = seedTwoBoards();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: breaking('Launch plan.excalidraw.md'), persistent: true });

    expect(report.status).toBe('migrated');
    expect(report.failed).toEqual([{ key: keys.ideas, boardId: 'ss-nebula', canvasId: 'ideas', name: 'Launch plan', error: expect.stringContaining('Could not decompress') }]);
    expect(report.warnings).toEqual([expect.stringContaining('Launch plan')]);
    expect(report.keys.sort()).toEqual([keys.main, keys.awkward].sort());
    expect(report.projects[0].files).toEqual([{ key: keys.main, canvasId: 'main', path: 'Winter hexagon.excalidraw.md' }]);
    expect((await (await registry.files('ss-nebula')).list()).map((entry) => entry.path)).toEqual(['Winter hexagon.excalidraw.md']);
    // Its Orbit metadata went nowhere: there's no file to attach it to.
    expect(await (await registry.files('ss-nebula')).stat('.nebula/legacy-metadata.json')).toBeNull();
    expect((await (await registry.files(report.projects[1].projectId)).list()).map((entry) => entry.path)).toEqual(['Plan- phase 1-2.excalidraw.md']);
    // It's still in localStorage, and the app can offer it again later.
    expect(window.localStorage.getItem(keys.ideas)).not.toBeNull();
    expect(await newerLegacyCanvases({ storage: window.localStorage, registry })).toEqual([expect.objectContaining({ key: keys.ideas, migrated: null })]);
    expect(JSON.parse(await root.readText('migration.json')).failed).toEqual([{ key: keys.ideas, error: expect.stringContaining('Could not decompress') }]);
  });

  it('makes no project for a board whose every canvas was left out, and copies none of its libraries', async () => {
    const keys = seedTwoBoards();
    const before = snapshot();
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry: breaking('Plan- phase 1-2.excalidraw.md'), persistent: true });

    expect(report.status).toBe('migrated');
    expect(report.failed?.map((canvas) => canvas.key)).toEqual([keys.awkward]);
    expect(report.projects.map((project) => project.boardId)).toEqual(['ss-nebula']);
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project']);
    expect(await projectFolders()).toHaveLength(1);
    expect(Object.keys(snapshot()).filter((name) => !(name in before))).toEqual([MIGRATION_MARKER]);
  });
});
