// Canvas: two writes queued; the older finds a conflict or a delete from another tab.
// What is kept (copy, Keep mine) must be the newest drawing, the one on screen.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import hexagonText from '../../../../e2e/assets/images/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../../src/files/memoryStore';
import type { FileStore } from '../../../../src/files/types';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../../src/nebula/excalidraw/scene';
import { createEmptyNebulaMetadata } from '../../../../src/nebula/excalidraw/metadata';
import { createFileSceneStore } from '../../../../src/workspace/views/canvas/fileSceneStore';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from '../../../../src/workspace/views/shared/fileSessions';

/** Kept from the reviewer's probes; prints nothing. */
const log = (...args: unknown[]): void => void args;
const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doc = (s: ExcalidrawScene) => ({ type: 'starscape.nebula.excalidraw' as const, version: 1 as const, boardId: 'p', canvasId: 'x', name: 'x', updatedAt: '', scene: s, nebula: createEmptyNebulaMetadata() });
const bump = (s: ExcalidrawScene, x: number, dv: number): ExcalidrawScene => ({ ...s, elements: s.elements.map((e, i) => (i === 0 ? { ...e, x, version: Number(e.version ?? 1) + dv } : e)) });
const X = (t: string) => readObsidianExcalidrawMarkdown(t).elements[0].x;
const copies = async (store: FileStore) => (await store.list()).filter((e) => e.type === 'file' && e.path.includes('(conflict ')).map((e) => e.path);

let kept: KeptCopy[] = [];
let stop: () => void = () => {};
beforeEach(() => {
  kept = [];
  stop = subscribeKeptCopies((c) => kept.push(c));
});
afterEach(() => stop());

/** stat() of `path` waits for open(), once armed: the first queued write's check is slow. */
function slowCheck(inner: FileStore, path: string) {
  let armed = false;
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop === 'stat') return async (...args: unknown[]) => {
        if (armed && args[0] === path) { armed = false; await gate; }
        return (v as (...a: unknown[]) => unknown).apply(target, args);
      };
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as FileStore;
  return { store, arm: () => (armed = true), open: () => open() };
}

async function setup(scope: string) {
  const disk = new MemoryFileStore();
  const path = 'c.excalidraw.md';
  await disk.write(path, toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
  const slow = slowCheck(disk.twin(), path);
  const s = createFileSceneStore({ store: slow.store, path, intervalMs: 1, scope });
  const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
  await s.save(doc(loaded.scene));
  slow.arm();
  await s.save(doc(bump(loaded.scene, 777, 1))); // its write's check is held
  await wait(10);
  await s.save(doc(bump(loaded.scene, 888, 2))); // the drawing on screen; its write queues behind
  await wait(10);
  return { disk, path, s, slow };
}

describe('two queued canvas writes, the older one finds a change elsewhere', () => {
  it('conflict, then the view closes: the copy holds the newest drawing', async () => {
    const { disk, path, s, slow } = await setup('stale-1');
    await disk.twin().write(path, toObsidianExcalidrawMarkdown(bump(hexagon, 4242, 5), { compressed: true }));
    slow.open();
    await wait(30);
    expect(s.getState().conflict).toBe(true);
    await s.dispose();
    const list = await copies(disk);
    const x = list.length ? X(await disk.readText(list[0])) : null;
    log('stale conflict copy x', x, 'file x', X(await disk.readText(path)));
    expect(X(await disk.readText(path))).toBe(4242);
    expect(x).toBe(888); // round 5 (G2): at 41a30fd the copy held 777, and 888, on screen, was lost
  });

  it('conflict, then Keep mine: the file gets the newest drawing', async () => {
    const { disk, path, s, slow } = await setup('stale-2');
    await disk.twin().write(path, toObsidianExcalidrawMarkdown(bump(hexagon, 4242, 5), { compressed: true }));
    slow.open();
    await wait(30);
    expect(s.getState().conflict).toBe(true);
    await s.keepMine();
    await wait(20);
    const x = X(await disk.readText(path));
    log('stale keepMine file x', x, s.getState());
    await s.dispose();
    expect(x).toBe(888); // round 5 (G2): at 41a30fd the file got 777, and nothing was unsaved
  });

  it('deleted by another tab (F5): the copy holds the newest drawing', async () => {
    const { disk, path, s, slow } = await setup('stale-3');
    await disk.twin().remove(path);
    slow.open();
    await wait(30);
    expect(hasUnsavedChanges()).toBe(true);
    await s.dispose();
    const list = await copies(disk);
    const x = list.length ? X(await disk.readText(list[0])) : null;
    log('stale deleted copy x', x, kept.at(-1));
    expect(list).toHaveLength(1);
    expect(x).toBe(888); // round 5 (G2): at 41a30fd the copy held 777
  });
});
