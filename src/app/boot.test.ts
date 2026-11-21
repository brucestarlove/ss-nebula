import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryFileStore } from '../files/memoryStore';
import { createBrowserRegistry, type BrowserRegistry } from '../files/registry';
import { seedSampleProject } from '../files/sample';
import type { BrowserRegistryHandle } from '../files/opfsRegistry';
import { SETUP_KEY, bootNebula, type BootDeps } from './boot';

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

// The sample's binaries come from public/sample/ in the app; here, a stand-in.
const fetchStub = (async () => new Response(new Blob(['bytes']))) as typeof fetch;

let storage: MemoryStorage;
let root: MemoryFileStore;
let registry: BrowserRegistry;

function deps(overrides: Partial<BootDeps> = {}, persistent = true): BootDeps & { seed: ReturnType<typeof vi.fn> } {
  const handle: BrowserRegistryHandle = persistent ? { registry, persistent } : { registry, persistent, reason: 'No OPFS here' };
  return {
    storage,
    openRegistry: async () => handle,
    seed: vi.fn((target: BrowserRegistry) => seedSampleProject(target, { fetch: fetchStub })),
    ...overrides,
  } as BootDeps & { seed: ReturnType<typeof vi.fn> };
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

  it('seeds the sample in memory when nothing will be kept', async () => {
    const boot = deps({}, false);
    const result = await bootNebula(boot);
    expect(result.persistent).toBe(false);
    expect(result.intro).toBe('welcome');
    expect((await registry.list()).map((project) => project.name)).toEqual(['Night Sky']);
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

