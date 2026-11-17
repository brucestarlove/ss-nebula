import { describe, expect, it } from 'vitest';
import hexagonText from '../../../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import { createTextSession } from './textSession';

/**
 * Round 4, F6: another tab renames the file while this tab's write is in
 * flight. The rename waits for the write (re-review R4) and carries its bytes
 * to the new path, so what's there is this tab's own save, never a change
 * made elsewhere.
 */

const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
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
const bump = (scene: ExcalidrawScene, x: number): ExcalidrawScene => ({
  ...scene,
  elements: scene.elements.map((element, index) => (index === 0 ? { ...element, x, version: Number(element.version ?? 1) + 1 } : element)),
});
const conflictCopies = async (store: FileStore) => (await store.list()).filter((entry) => entry.name.includes('(conflict '));

describe('F6: a rename in another tab that waited for this write', () => {
  it('canvas: its own write, carried to the new path, isn’t taken for a change made elsewhere, and closing writes no copy', async () => {
    const disk = new MemoryFileStore();
    await disk.write('c.excalidraw.md', toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
    const tab = disk.twin({ delay: (change) => (change.type === 'write' ? wait(30) : undefined) });
    const canvas = createFileSceneStore({ store: tab, path: 'c.excalidraw.md', intervalMs: 1 });
    const loaded = (await canvas.load({ boardId: 'p', canvasId: 'c' }))!;
    await canvas.save(doc(loaded.scene));
    await canvas.save(doc(bump(loaded.scene, 777)));
    await wait(10);
    await disk.rename('c.excalidraw.md', 'r.excalidraw.md');
    await canvas.flush();
    expect(canvas.getState().conflict).toBe(false);
    expect(readObsidianExcalidrawMarkdown(await disk.readText('r.excalidraw.md')).elements[0].x).toBe(777);
    await canvas.dispose();
    expect(await conflictCopies(disk)).toEqual([]);
  });

  it('note: an edit made while the write is aimed again isn’t taken for a conflict', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'v1');
    // This tab's write is held inside the store until let go.
    let landWrite!: () => void;
    const writeHeld = new Promise<void>((resolve) => (landWrite = resolve));
    let writing = false;
    const writes = disk.twin({
      delay: (change) => {
        if (change.type !== 'write') return;
        writing = true;
        return writeHeld;
      },
    });
    // Looking at the file at its new path waits too, so the user types meanwhile.
    let lookAt!: () => void;
    const looked = new Promise<void>((resolve) => (lookAt = resolve));
    let looking = false;
    // And the echo of the write, read at the old path, is read only once the
    // rename is done: it finds nothing there, as when the rename is heard first.
    let renameDone!: () => void;
    const renameLanded = new Promise<void>((resolve) => (renameDone = resolve));
    const lateAtOldPath = async () => {
      if (writing) await renameLanded;
    };
    const tab: FileStore = Object.assign(Object.create(writes) as FileStore, {
      stat: async (path: string) => {
        if (path === 'r.md') {
          looking = true;
          await looked;
        }
        return writes.stat(path);
      },
      readText: async (path: string) => {
        if (path === 'n.md') await lateAtOldPath();
        return writes.readText(path);
      },
      readBlob: async (path: string) => {
        if (path === 'n.md') await lateAtOldPath();
        return writes.readBlob(path);
      },
    });
    const session = createTextSession(tab, 'n.md', { saveDelayMs: 1000 });
    await session.ready;
    session.edit('mine');
    const flushed = session.flush();
    for (let tries = 0; !writing && tries < 200; tries += 1) await wait(5);
    const renamed = disk.rename('n.md', 'r.md');
    await wait(5);
    landWrite();
    await renamed;
    renameDone();
    for (let tries = 0; !looking && tries < 200; tries += 1) await wait(5);
    expect(looking).toBe(true);
    session.edit('mine, and more');
    lookAt();
    await flushed;
    await session.flush();
    expect(session.getState().conflict).toBe(false);
    expect(await disk.readText('r.md')).toBe('mine, and more');
    await session.dispose();
    expect(await conflictCopies(disk)).toEqual([]);
  });
});
