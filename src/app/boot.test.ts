import { beforeEach, describe, expect, it, vi } from 'vitest';

import hexagonText from '../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { createEmptyNebulaMetadata } from '../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../nebula/excalidraw/scene';
import type { NebulaExcalidrawDocument } from '../nebula/storage/types';
import { MemoryFileStore } from '../files/memoryStore';
import { MIGRATION_MARKER, migrateLegacyCanvases, type MigrationReport } from '../files/migration';
import { createBrowserRegistry, type BrowserRegistry } from '../files/registry';
import { seedSampleProject } from '../files/sample';
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import {
  LEGACY_ROUTES_KEY,
  MIGRATION_MARKER_KEY,
  SETUP_KEY,
  bootNebula,
  hasLegacyCanvases,
  readLegacyRoutes,
  type BootDeps,
} from './boot';

// A localStorage of our own per test, so tests can't see each other.
class MemoryStorage implements Storage {
  private items = new Map<string, string>();
  get length() {
    return this.items.size;
  }
  clear() {
    this.items.clear();
  }
  getItem(key: string) {
    return this.items.get(key) ?? null;
  }
  key(index: number) {
    return [...this.items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.items.delete(key);
  }
  setItem(key: string, value: string) {
    this.items.set(key, String(value));
  }
}

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;

function legacyDocument(boardId: string, canvasId: string, name: string): NebulaExcalidrawDocument {
  return {
    type: 'starscape.nebula.excalidraw',
    version: 1,
    boardId,
    canvasId,
    name,
    updatedAt: '2026-05-29T12:00:00.000Z',
    scene: hexagon,
    nebula: createEmptyNebulaMetadata(),
  };
}

function seedLegacy(storage: Storage, boardId: string, canvasId: string, name: string): string {
  const key = `nebula:excalidraw:${encodeURIComponent(boardId)}:${encodeURIComponent(canvasId)}`;
  storage.setItem(key, JSON.stringify(legacyDocument(boardId, canvasId, name)));
  return key;
}

// The sample's binaries come from public/sample/ in the app; here, a stand-in.
const fetchStub = (async () => new Response(new Blob(['bytes']))) as typeof fetch;

let storage: MemoryStorage;
let root: MemoryFileStore;
let registry: BrowserRegistry;

function deps(overrides: Partial<BootDeps> = {}, persistent = true): BootDeps & { migrate: ReturnType<typeof vi.fn>; seed: ReturnType<typeof vi.fn> } {
  const handle: BrowserRegistryHandle = persistent ? { registry, persistent } : { registry, persistent, reason: 'No OPFS here' };
  return {
    storage,
    openRegistry: async () => handle,
    migrate: vi.fn((input: Parameters<BootDeps['migrate']>[0]) => migrateLegacyCanvases(input)),
    seed: vi.fn((target: BrowserRegistry) => seedSampleProject(target, { fetch: fetchStub })),
    ...overrides,
  } as BootDeps & { migrate: ReturnType<typeof vi.fn>; seed: ReturnType<typeof vi.fn> };
}

beforeEach(() => {
  storage = new MemoryStorage();
  root = new MemoryFileStore();
  registry = createBrowserRegistry(root);
});

describe('bootNebula', () => {
  it('gives a brand-new visitor the sample project and the welcome', async () => {
    const boot = await bootNebula(deps());
    expect(boot.intro).toBe('welcome');
    expect(boot.persistent).toBe(true);
    expect((await registry.list()).map((project) => project.name)).toEqual(['Night Sky']);
    expect(storage.getItem(SETUP_KEY)).not.toBeNull();
  });

  it('never loads the migration for a visitor without old canvases', async () => {
    const boot = deps();
    await bootNebula(boot);
    expect(boot.migrate).not.toHaveBeenCalled();
  });

  it('opens a returning visitor’s projects as they are, with no welcome', async () => {
    await bootNebula(deps());
    const again = deps();
    const boot = await bootNebula(again);
    expect(boot.intro).toBeNull();
    expect(again.seed).not.toHaveBeenCalled();
    expect(await registry.list()).toHaveLength(1);
  });

  it('shows the empty state, not a new sample, after every project was removed', async () => {
    await bootNebula(deps());
    for (const project of await registry.list()) await registry.remove(project.id);
    const again = deps();
    const boot = await bootNebula(again);
    expect(boot.intro).toBeNull();
    expect(again.seed).not.toHaveBeenCalled();
    expect(await registry.list()).toEqual([]);
  });

  it('marks a browser that already has projects as set up, without a sample', async () => {
    await registry.create({ name: 'Field notes', color: '#7c8cff' });
    const boot = deps();
    const result = await bootNebula(boot);
    expect(result.intro).toBeNull();
    expect(boot.seed).not.toHaveBeenCalled();
    expect(storage.getItem(SETUP_KEY)).not.toBeNull();
  });

  it('moves old canvases into projects, with the one-time note instead of the sample', async () => {
    const key = seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    const before = storage.getItem(key);
    const boot = await bootNebula(deps());
    expect(boot.intro).toBe('migrated');
    expect(boot.migration?.status).toBe('migrated');
    expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project']);
    expect(storage.getItem(key)).toBe(before);
    expect(storage.getItem(SETUP_KEY)).not.toBeNull();
  });

  it('shows the note about moved canvases only on the visit that moved them', async () => {
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    await bootNebula(deps());
    const again = deps();
    const boot = await bootNebula(again);
    expect(boot.intro).toBeNull();
    expect(again.migrate).not.toHaveBeenCalled();
  });

  it('remembers where each old canvas went, for old links', async () => {
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    seedLegacy(storage, 'Launch', 'map', 'Launch: map');
    await bootNebula(deps());
    const routes = readLegacyRoutes(storage);
    expect(routes['ss-nebula']).toEqual({ project: 'ss-nebula', canvases: { main: 'Winter hexagon.excalidraw.md' } });
    expect(routes.Launch).toEqual({ project: 'Launch', canvases: { map: 'Launch- map.excalidraw.md' } });
  });

  it('leaves old canvases alone when nothing will be kept, and seeds the sample in memory', async () => {
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    const boot = deps({}, false);
    const result = await bootNebula(boot);
    expect(boot.migrate).not.toHaveBeenCalled();
    expect(result.persistent).toBe(false);
    expect(result.intro).toBe('welcome');
    expect((await registry.list()).map((project) => project.name)).toEqual(['Night Sky']);
    expect(storage.getItem(MIGRATION_MARKER_KEY)).toBeNull();
    expect(storage.getItem(SETUP_KEY)).toBeNull();
  });

  it('passes on the canvases a move left behind, and its warnings, for the note (re-review R3)', async () => {
    const key = seedLegacy(storage, 'ss-nebula', 'plan', 'Plan');
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    const report: MigrationReport = {
      status: 'migrated',
      projects: [{ boardId: 'ss-nebula', projectId: 'ss-nebula', name: 'ss-nebula', files: [{ key: 'k', canvasId: 'main', path: 'Winter hexagon.excalidraw.md' }] }],
      keys: [],
      skipped: [],
      failed: [{ key, boardId: 'ss-nebula', canvasId: 'plan', name: 'Plan', error: 'elements changed' }],
      warnings: [
        '“Plan” (board ss-nebula) didn’t read back the same once written, so it stays where Nebula 1.x kept it: elements changed',
        'The Excalidraw library of board ss-nebula didn’t fit in this browser’s storage, so “ss-nebula” starts without it. It’s still saved under the old board.',
      ],
    };
    const result = await bootNebula(deps({ migrate: vi.fn(async () => report) }));
    expect(result.intro).toBe('migrated');
    expect(result.leftBehind).toEqual({
      canvases: [{ key, name: 'Plan' }],
      // The canvas is named once, with its download, not again as a warning.
      warnings: ['The Excalidraw library of board ss-nebula didn’t fit in this browser’s storage, so “ss-nebula” starts without it. It’s still saved under the old board.'],
    });
  });

  it('has nothing left behind when everything moved', async () => {
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    const result = await bootNebula(deps());
    expect(result.intro).toBe('migrated');
    expect(result.leftBehind).toBeNull();
  });

  it('says so when old canvases couldn’t be moved, and seeds nothing over them', async () => {
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    const failed: MigrationReport = { status: 'failed', projects: [], keys: [], skipped: [], error: 'QuotaExceededError: full' };
    const boot = deps({ migrate: vi.fn(async () => failed) });
    const result = await bootNebula(boot);
    expect(result.intro).toBeNull();
    expect(result.notice).toMatch(/couldn’t move your canvases/i);
    expect(result.notice).toContain('QuotaExceededError: full');
    expect(boot.seed).not.toHaveBeenCalled();
    expect(storage.getItem(SETUP_KEY)).toBeNull();
  });

  it('opens with no projects rather than failing when the sample can’t be made', async () => {
    const boot = deps({ seed: vi.fn(async () => Promise.reject(new Error('disk full'))) });
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    const result = await bootNebula(boot);
    errors.mockRestore();
    expect(result.intro).toBeNull();
    expect(await registry.list()).toEqual([]);
  });

  it('makes one sample when two tabs open at once', async () => {
    const other = createBrowserRegistry(root);
    await Promise.all([bootNebula(deps()), bootNebula({ ...deps(), openRegistry: async () => ({ registry: other, persistent: true }) })]);
    // Count the project folders: registry.json alone could hide a second
    // sample when two writes race.
    const folders = (await root.list()).filter((entry) => entry.type === 'dir' && /^projects\/[^/]+$/.test(entry.path));
    expect(folders).toHaveLength(1);
    expect(await registry.list()).toHaveLength(1);
  });
});

describe('hasLegacyCanvases', () => {
  it('finds Nebula 1.x canvases by their key', () => {
    expect(hasLegacyCanvases(storage)).toBe(false);
    storage.setItem('nebula:excalidraw-libraries:ss-nebula', '{}');
    storage.setItem('nebula:theme', 'dark');
    expect(hasLegacyCanvases(storage)).toBe(false);
    seedLegacy(storage, 'ss-nebula', 'main', 'Winter hexagon');
    expect(hasLegacyCanvases(storage)).toBe(true);
  });

  it('uses the migration’s own marker', () => {
    expect(MIGRATION_MARKER_KEY).toBe(MIGRATION_MARKER);
  });

  it('keeps the routes key apart from the old canvases', () => {
    expect(LEGACY_ROUTES_KEY.startsWith('nebula:excalidraw:')).toBe(false);
  });
});
