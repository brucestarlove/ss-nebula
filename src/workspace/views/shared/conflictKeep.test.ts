import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import hexagonText from '../../../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../files/memoryStore';
import { scopedStore } from '../../../files/scopedStore';
import type { FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import { conflictCopyName, writeConflictCopy } from './conflictCopy';
import { hasUnsavedChanges, holdWrites, subscribeKeptCopies, type KeptCopy } from './fileSessions';
import { createTextSession } from './textSession';

/**
 * Round 4 (the third review's F1, F2 and F5): a change held in a conflict is
 * never lost when its view goes, even when two copies are written at once,
 * the name is long, the store refuses the copy, or another tab deleted the
 * file. Two tabs are played by MemoryFileStore twins.
 */

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/** Waits until `ready()` holds (another tab's change is heard through a read,
 * which can take a while in a busy run), for two seconds at most. */
async function until(ready: () => boolean): Promise<void> {
  for (let waited = 0; !ready() && waited < 2000; waited += 5) await wait(5);
  expect(ready()).toBe(true);
}
const doc = (scene: ExcalidrawScene) => ({
  type: 'starscape.nebula.excalidraw' as const,
  version: 1 as const,
  boardId: 'p',
  canvasId: 'c',
  name: 'c',
  updatedAt: '',
  scene,
  nebula: createEmptyNebulaMetadata(),
});
const moved = (scene: ExcalidrawScene, index: number, x: number): ExcalidrawScene => ({
  ...scene,
  elements: scene.elements.map((element, at) => (at === index ? { ...element, x, version: Number(element.version ?? 1) + 1 } : element)),
});

async function copies(store: FileStore): Promise<string[]> {
  return (await store.list()).filter((entry) => entry.type === 'file' && entry.name.includes('(conflict ')).map((entry) => entry.path);
}

async function texts(store: FileStore, paths: string[]): Promise<string[]> {
  return (await Promise.all(paths.map((path) => store.readText(path)))).sort();
}

let kept: KeptCopy[] = [];
let stop: () => void = () => {};
beforeEach(() => {
  kept = [];
  stop = subscribeKeptCopies((copy) => kept.push(copy));
});
afterEach(() => {
  stop();
  // A failed copy left unreleased would keep the page "unsaved" for the next test.
  for (const copy of kept) if (copy.copy === null) copy.release();
});

/** A note open in this tab with an edit, while another tab saves it. */
async function noteInConflict(store: FileStore, path: string, mine: string) {
  const session = createTextSession(store, path, { saveDelayMs: 1000, scope: store });
  await session.ready;
  session.edit(mine);
  return session;
}

/** A canvas open in this tab with a change of element `index`, not saved yet. */
async function canvasWithChange(store: FileStore, path: string, index: number, x: number) {
  const canvas = createFileSceneStore({ store, path, intervalMs: 1000, scope: store });
  const loaded = (await canvas.load({ boardId: 'p', canvasId: path }))!;
  await canvas.save(doc(loaded.scene));
  await canvas.save(doc(moved(loaded.scene, index, x)));
  return canvas;
}

describe('F1: two copies of one file written at once', () => {
  it('notes in two tabs, each holding a conflict, disposed at once: both copies, each with its own change', async () => {
    const disk = new MemoryFileStore();
    await disk.write('Notes/n.md', 'v1');
    const tab = disk.twin();
    const one = await noteInConflict(disk, 'Notes/n.md', 'mine one');
    const two = await noteInConflict(tab, 'Notes/n.md', 'mine two');
    await disk.twin().write('Notes/n.md', 'theirs');
    await until(() => one.getState().conflict && two.getState().conflict);
    await Promise.all([one.dispose(), two.dispose()]);
    const list = await copies(disk);
    expect(list).toHaveLength(2);
    expect(await texts(disk, list)).toEqual(['mine one', 'mine two']);
    expect(await disk.readText('Notes/n.md')).toBe('theirs');
    expect(kept.map((copy) => copy.copy).sort()).toEqual([...list].sort());
  });

  it('two notes of one file in one tab, disposed at once: both copies', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'v1');
    const one = await noteInConflict(disk, 'n.md', 'mine one');
    const two = await noteInConflict(disk, 'n.md', 'mine two');
    await disk.twin().write('n.md', 'theirs');
    await until(() => one.getState().conflict && two.getState().conflict);
    await Promise.all([one.dispose(), two.dispose()]);
    expect(await texts(disk, await copies(disk))).toEqual(['mine one', 'mine two']);
  });

  it('canvases in two tabs, each holding a conflict, disposed at once: both copies, each with its own change', async () => {
    const disk = new MemoryFileStore();
    await disk.write('D/c.excalidraw', JSON.stringify(hexagon));
    const tab = disk.twin();
    const one = await canvasWithChange(disk, 'D/c.excalidraw', 1, 222);
    const two = await canvasWithChange(tab, 'D/c.excalidraw', 2, 333);
    await disk.twin().write('D/c.excalidraw', JSON.stringify(moved(hexagon, 0, 111)));
    await until(() => one.getState().conflict && two.getState().conflict);
    await Promise.all([one.dispose(), two.dispose()]);
    const list = await copies(disk);
    expect(list).toHaveLength(2);
    const scenes = await Promise.all(list.map(async (path) => JSON.parse(await disk.readText(path)) as ExcalidrawScene));
    expect(scenes.map((scene) => [scene.elements[1].x, scene.elements[2].x]).sort()).toEqual([
      [222, hexagon.elements[2].x],
      [hexagon.elements[1].x, 333],
    ].sort());
  });
});

describe('writeConflictCopy', () => {
  it('never writes over a copy it couldn’t see: it takes the next free name', async () => {
    const disk = new MemoryFileStore();
    const now = new Date(2026, 9, 22, 11, 40);
    await disk.write('n (conflict 2026-10-22 11.40).md', 'the first copy');
    // A listing taken before the first copy landed.
    const stale: FileStore = Object.assign(Object.create(disk) as FileStore, { list: async () => [] });
    const copy = await writeConflictCopy(stale, 'n.md', 'the second copy', now);
    expect(copy).toBe('n (conflict 2026-10-22 11.40) 2.md');
    expect(await disk.readText('n (conflict 2026-10-22 11.40).md')).toBe('the first copy');
    expect(await disk.readText(copy)).toBe('the second copy');
  });

  it('gives up after a bound, with the store’s error, when every name is taken', async () => {
    const disk = new MemoryFileStore();
    let tries = 0;
    const full: FileStore = Object.assign(Object.create(disk) as FileStore, {
      list: async () => [],
      write: async () => {
        tries += 1;
        throw Object.assign(new Error('taken'), { name: 'FileExistsError' });
      },
    });
    await expect(writeConflictCopy(full, 'n.md', 'mine')).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(tries).toBeGreaterThan(1);
    expect(tries).toBeLessThanOrEqual(20);
  });
});

const bytes = (name: string) => new TextEncoder().encode(name).length;
const NOW = new Date(2026, 9, 22, 11, 40);

/** The store, except that it refuses every conflict copy, as a full one would. */
function refusingCopies(disk: MemoryFileStore): FileStore {
  return Object.assign(Object.create(disk) as FileStore, {
    write: (path: string, data: string | Blob, options?: { exclusive?: boolean }) =>
      path.includes('(conflict ')
        ? Promise.reject(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' }))
        : disk.write(path, data, options),
  });
}

describe('F2: a copy with a long name', () => {
  it('fits the name to 255 bytes, keeping the stamp and the extension whole', () => {
    const name = conflictCopyName(`Guides/${'x'.repeat(240)}.md`, [], NOW);
    expect(bytes(name)).toBeLessThanOrEqual(255);
    expect(name).toMatch(/^x+ \(conflict 2026-10-22 11\.40\)\.md$/);
    const cjk = conflictCopyName(`${'漢'.repeat(80)}.excalidraw.md`, [], NOW);
    expect(bytes(cjk)).toBeLessThanOrEqual(255);
    expect(cjk).toMatch(/^漢+ \(conflict 2026-10-22 11\.40\)\.excalidraw\.md$/);
  });

  it('keeps the stamp whole when the name is taken, too', () => {
    const first = conflictCopyName(`${'x'.repeat(240)}.md`, [], NOW);
    const second = conflictCopyName(`${'x'.repeat(240)}.md`, [first], NOW);
    expect(bytes(second)).toBeLessThanOrEqual(255);
    expect(second).toMatch(/^x+ \(conflict 2026-10-22 11\.40\) 2\.md$/);
    expect(conflictCopyName('README', ['README (conflict 2026-10-22 11.40)'], NOW)).toBe('README (conflict 2026-10-22 11.40) 2');
  });

  it('a note with a long name, in a conflict, disposed: the copy is written under the fitted name', async () => {
    const path = `${'n'.repeat(240)}.md`;
    const disk = new MemoryFileStore();
    await disk.write(path, 'v1');
    const session = await noteInConflict(disk, path, 'mine');
    await disk.twin().write(path, 'theirs');
    await until(() => session.getState().conflict);
    await session.dispose();
    const [copy, ...more] = await copies(disk);
    expect(more).toEqual([]);
    expect(bytes(copy)).toBeLessThanOrEqual(255);
    expect(await disk.readText(copy)).toBe('mine');
    expect(hasUnsavedChanges()).toBe(false);
  });
});

describe('F2: a copy the store refuses', () => {
  it('note: says why, hands over the user’s version under the copy’s name, and stays unsaved until released', async () => {
    const disk = new MemoryFileStore();
    await disk.write('Notes/n.md', 'v1');
    const session = await noteInConflict(refusingCopies(disk), 'Notes/n.md', 'mine');
    await disk.twin().write('Notes/n.md', 'theirs');
    await until(() => session.getState().conflict);
    await session.dispose();
    expect(await copies(disk)).toEqual([]);
    const failed = kept.at(-1)!;
    expect(failed).toMatchObject({ path: 'Notes/n.md', copy: null, error: { name: 'QuotaExceededError' } });
    if (failed.copy !== null) throw new Error('expected a failure');
    expect(failed.download.text).toBe('mine');
    expect(failed.download.filename).toMatch(/^n \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/);
    expect(hasUnsavedChanges()).toBe(true);
    failed.release();
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('canvas: hands over the drawing in the file’s own format', async () => {
    const disk = new MemoryFileStore();
    await disk.write('D/c.excalidraw', JSON.stringify(hexagon));
    const canvas = await canvasWithChange(refusingCopies(disk), 'D/c.excalidraw', 1, 222);
    await disk.twin().write('D/c.excalidraw', JSON.stringify(moved(hexagon, 0, 111)));
    await until(() => canvas.getState().conflict);
    await canvas.dispose();
    const failed = kept.at(-1)!;
    if (failed.copy !== null) throw new Error('expected a failure');
    expect(failed.download.filename).toMatch(/^c \(conflict .*\)\.excalidraw$/);
    const mine = JSON.parse(failed.download.text) as ExcalidrawScene;
    expect(mine.type).toBe('excalidraw');
    expect(mine.elements[1].x).toBe(222);
    expect(hasUnsavedChanges()).toBe(true);
    failed.release();
    expect(hasUnsavedChanges()).toBe(false);
  });
});

describe('F5: another tab deletes the file while a conflict holds a change', () => {
  it('note: the change is written where the file was, and the line says why', async () => {
    const disk = new MemoryFileStore();
    await disk.write('Notes/n.md', 'v1');
    const session = await noteInConflict(disk, 'Notes/n.md', 'mine');
    const other = disk.twin();
    await other.write('Notes/n.md', 'theirs');
    await until(() => session.getState().conflict);
    await other.remove('Notes/n.md');
    await until(() => session.getState().removed);
    expect(hasUnsavedChanges()).toBe(true);
    await session.dispose();
    const [copy, ...more] = await copies(disk);
    expect(more).toEqual([]);
    expect(copy).toMatch(/^Notes\/n \(conflict .*\)\.md$/);
    expect(await disk.readText(copy)).toBe('mine');
    expect(await disk.stat('Notes/n.md')).toBeNull();
    expect(kept).toEqual([{ scope: disk, path: 'Notes/n.md', copy, deleted: true }]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('note: a folder deleted with it is made again for the copy', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/n.md', 'v1');
    const session = await noteInConflict(disk, 'F/n.md', 'mine');
    const other = disk.twin();
    await other.write('F/n.md', 'theirs');
    await until(() => session.getState().conflict);
    await other.remove('F');
    await until(() => session.getState().removed);
    await session.dispose();
    const [copy] = await copies(disk);
    expect(copy).toMatch(/^F\/n \(conflict .*\)\.md$/);
    expect(await disk.readText(copy)).toBe('mine');
  });

  it('canvas: the change is written where the file was, in its own format', async () => {
    const disk = new MemoryFileStore();
    await disk.write('D/c.excalidraw', JSON.stringify(hexagon));
    const canvas = await canvasWithChange(disk, 'D/c.excalidraw', 1, 222);
    const other = disk.twin();
    await other.write('D/c.excalidraw', JSON.stringify(moved(hexagon, 0, 111)));
    await until(() => canvas.getState().conflict);
    await other.remove('D/c.excalidraw');
    await until(() => canvas.getState().removed);
    expect(hasUnsavedChanges()).toBe(true);
    await canvas.dispose();
    const [copy, ...more] = await copies(disk);
    expect(more).toEqual([]);
    expect(copy).toMatch(/^D\/c \(conflict .*\)\.excalidraw$/);
    expect((JSON.parse(await disk.readText(copy)) as ExcalidrawScene).elements[1].x).toBe(222);
    expect(kept).toEqual([{ scope: disk, path: 'D/c.excalidraw', copy, deleted: true }]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a delete made in this tab (it holds the session’s writes) keeps no copy, as before', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'v1');
    await disk.write('D/c.excalidraw', JSON.stringify(hexagon));
    const note = createTextSession(disk, 'n.md', { saveDelayMs: 1000, scope: 'night-sky' });
    await note.ready;
    note.edit('mine');
    const canvas = createFileSceneStore({ store: disk, path: 'D/c.excalidraw', intervalMs: 1000, scope: 'night-sky' });
    const loaded = (await canvas.load({ boardId: 'p', canvasId: 'c' }))!;
    await canvas.save(doc(loaded.scene));
    await canvas.save(doc(moved(loaded.scene, 1, 222)));
    for (const path of ['n.md', 'D']) {
      const release = await holdWrites('night-sky', path, { flush: false });
      await disk.remove(path);
      release();
    }
    await Promise.all([note.dispose(), canvas.dispose()]);
    expect(await disk.list()).toEqual([]);
    expect(kept).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a project removed under the session keeps no copy in its folder', async () => {
    const root = new MemoryFileStore();
    await root.write('projects/a/n.md', 'v1');
    const store = scopedStore(root, 'projects/a');
    const session = await noteInConflict(store, 'n.md', 'mine');
    await root.twin().write('projects/a/n.md', 'theirs');
    await until(() => session.getState().conflict);
    await root.twin().remove('projects/a');
    await until(() => session.getState().removed);
    await session.dispose();
    expect(await root.list()).toEqual([{ path: 'projects', name: 'projects', type: 'dir' }]);
    expect(kept).toEqual([]);
  });
});
