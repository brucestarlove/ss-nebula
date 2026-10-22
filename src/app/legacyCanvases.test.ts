import { describe, expect, it } from 'vitest';
import hexagonText from '../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { createEmptyNebulaMetadata } from '../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../nebula/excalidraw/scene';
import { MemoryFileStore } from '../files/memoryStore';
import { migrateLegacyCanvases } from '../files/migration';
import { createBrowserRegistry } from '../files/registry';
import { readObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { OLDER_TAB_HANDLED_KEY, findOlderTabCanvases, importOlderTabCopy, legacyCanvasAsExcalidraw, recordOlderTabHandled } from './legacyCanvases';

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;

function storageWith(items: Record<string, string>): Storage {
  const map = new Map(Object.entries(items));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key) => map.get(key) ?? null,
    key: (index) => [...map.keys()][index] ?? null,
    removeItem: (key) => void map.delete(key),
    setItem: (key, value) => void map.set(key, value),
  };
}

const KEY = 'nebula:excalidraw:ss-nebula:plan';
const documentText = JSON.stringify({
  type: 'starscape.nebula.excalidraw',
  version: 1,
  boardId: 'ss-nebula',
  canvasId: 'plan',
  name: 'Launch: plan',
  updatedAt: '2026-05-29T12:00:00.000Z',
  scene: hexagon,
  nebula: createEmptyNebulaMetadata(),
});

describe('legacyCanvasAsExcalidraw (re-review R3, R6)', () => {
  it('makes an .excalidraw file of a 1.x canvas, from its localStorage document', () => {
    const file = legacyCanvasAsExcalidraw(storageWith({ [KEY]: documentText }), KEY)!;
    expect(file.filename).toBe('Launch- plan.excalidraw');
    const scene = JSON.parse(file.text) as ExcalidrawScene;
    expect(scene.type).toBe('excalidraw');
    expect(scene.elements.map((element) => element.id)).toEqual(hexagon.elements.map((element) => element.id));
  });

  it('is null for a key that holds no canvas', () => {
    expect(legacyCanvasAsExcalidraw(storageWith({ [KEY]: '{"nope":1}' }), KEY)).toBeNull();
    expect(legacyCanvasAsExcalidraw(storageWith({}), KEY)).toBeNull();
    expect(legacyCanvasAsExcalidraw(null, KEY)).toBeNull();
  });
});

describe('canvases an older tab saved after the move (re-review R6)', () => {
  const MAIN = 'nebula:excalidraw:ss-nebula:main';
  const legacy = (name: string, updatedAt: string) =>
    JSON.stringify({ type: 'starscape.nebula.excalidraw', version: 1, boardId: 'ss-nebula', canvasId: 'main', name, updatedAt, scene: hexagon, nebula: createEmptyNebulaMetadata() });

  async function moved() {
    const storage = storageWith({ [MAIN]: legacy('Main', '2026-05-29T12:00:00.000Z') });
    const registry = createBrowserRegistry(new MemoryFileStore(), { locks: null });
    const report = await migrateLegacyCanvases({ storage, registry, persistent: true, locks: null });
    expect(report.status).toBe('migrated');
    return { storage, registry, projectId: report.projects[0].projectId };
  }

  it('finds none right after the move', async () => {
    const { storage, registry } = await moved();
    expect(await findOlderTabCanvases(storage, registry)).toEqual([]);
  });

  it('finds a canvas saved again by an older tab, with the project its earlier version went to', async () => {
    const { storage, registry, projectId } = await moved();
    storage.setItem(MAIN, legacy('Main', '2026-06-01T00:00:00.000Z'));
    expect(await findOlderTabCanvases(storage, registry)).toEqual([{ key: MAIN, name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId }]);
  });

  it('imports it as a copy beside the moved one, named for the older tab, and never over anything', async () => {
    const { storage, registry, projectId } = await moved();
    storage.setItem(MAIN, legacy('Main', '2026-06-01T00:00:00.000Z'));
    const path = await importOlderTabCopy({ storage, registry, key: MAIN, projectId });
    expect(path).toBe('Main (older tab).excalidraw.md');
    const store = await registry.files(projectId);
    const scene = readObsidianExcalidrawMarkdown(await store.readText(path));
    expect(scene.elements.map((element) => element.id)).toEqual(hexagon.elements.map((element) => element.id));
    expect(await store.readText('Main.excalidraw.md')).not.toBe('');
    expect(await importOlderTabCopy({ storage, registry, key: MAIN, projectId })).toBe('Main (older tab) 2.excalidraw.md');
  });
  // Round 4, F8: the offer doesn't come back for what was imported or put away.
  const bytes = (name: string) => new TextEncoder().encode(name).length;

  it('leaves out a canvas once imported, until an older tab saves it again', async () => {
    const { storage, registry, projectId } = await moved();
    storage.setItem(MAIN, legacy('Main', '2026-06-01T00:00:00.000Z'));
    await importOlderTabCopy({ storage, registry, key: MAIN, projectId });
    expect(await findOlderTabCanvases(storage, registry)).toEqual([]);
    expect(JSON.parse(storage.getItem(OLDER_TAB_HANDLED_KEY) ?? '{}')).toEqual({ [MAIN]: '2026-06-01T00:00:00.000Z' });
    storage.setItem(MAIN, legacy('Main', '2026-06-02T00:00:00.000Z'));
    expect(await findOlderTabCanvases(storage, registry)).toEqual([{ key: MAIN, name: 'Main', updatedAt: '2026-06-02T00:00:00.000Z', projectId }]);
  });

  it('leaves out a canvas once put away, until an older tab saves it again', async () => {
    const { storage, registry } = await moved();
    storage.setItem(MAIN, legacy('Main', '2026-06-01T00:00:00.000Z'));
    const found = await findOlderTabCanvases(storage, registry);
    recordOlderTabHandled(storage, found);
    expect(await findOlderTabCanvases(storage, registry)).toEqual([]);
    storage.setItem(MAIN, legacy('Main', '2026-06-03T00:00:00.000Z'));
    expect((await findOlderTabCanvases(storage, registry)).map((canvas) => canvas.updatedAt)).toEqual(['2026-06-03T00:00:00.000Z']);
  });

  it('keeps working where localStorage is full or blocked, and ignores a damaged record', async () => {
    const { storage, registry, projectId } = await moved();
    storage.setItem(MAIN, legacy('Main', '2026-06-01T00:00:00.000Z'));
    storage.setItem(OLDER_TAB_HANDLED_KEY, '{not json');
    expect(await findOlderTabCanvases(storage, registry)).toHaveLength(1);
    const full: Storage = Object.assign(Object.create(storage) as Storage, {
      setItem: () => {
        throw new DOMException('full', 'QuotaExceededError');
      },
    });
    expect(await importOlderTabCopy({ storage: full, registry, key: MAIN, projectId })).toBe('Main (older tab).excalidraw.md');
    expect(() => recordOlderTabHandled(full, [{ key: MAIN, updatedAt: '2026-06-01T00:00:00.000Z' }])).not.toThrow();
    const blocked: Storage = Object.assign(Object.create(storage) as Storage, {
      getItem: (key: string) => {
        if (key === OLDER_TAB_HANDLED_KEY) throw new DOMException('blocked', 'SecurityError');
        return storage.getItem(key);
      },
    });
    expect(await findOlderTabCanvases(blocked, registry)).toHaveLength(1);
  });

  it('imports and downloads a canvas with a very long name, under names that fit', async () => {
    const { storage, registry, projectId } = await moved();
    const LONG = 'nebula:excalidraw:ss-nebula:long';
    storage.setItem(LONG, legacy('L'.repeat(250), '2026-06-01T00:00:00.000Z').replace('"canvasId":"main"', '"canvasId":"long"'));
    const path = await importOlderTabCopy({ storage, registry, key: LONG, projectId });
    expect(bytes(path)).toBeLessThanOrEqual(255);
    expect(path).toMatch(/^L+ \(older tab\)\.excalidraw\.md$/);
    const again = await importOlderTabCopy({ storage, registry, key: LONG, projectId });
    expect(again).toMatch(/^L+ \(older tab\) 2\.excalidraw\.md$/);
    expect(bytes(again)).toBeLessThanOrEqual(255);
    const file = legacyCanvasAsExcalidraw(storage, LONG)!;
    expect(bytes(file.filename)).toBeLessThanOrEqual(255);
    expect(file.filename).toMatch(/^L+\.excalidraw$/);
  });
});
