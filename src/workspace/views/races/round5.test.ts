import { describe, expect, it, vi } from 'vitest';
import hexagonText from '../../../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileChange, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import { createTextSession } from '../shared/textSession';

/**
 * Round 5: behaviours the randomized interleaving test (interleaving.test.ts)
 * found beyond the review's findings, each pinned on its own. Another tab's
 * messages are held back here, as a BroadcastChannel's can arrive late.
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
const bump = (scene: ExcalidrawScene, x: number, version: number): ExcalidrawScene => ({
  ...scene,
  elements: scene.elements.map((element, index) => (index === 0 ? { ...element, x, version } : element)),
});
const drawing = (x: number, version: number) => toObsidianExcalidrawMarkdown(bump(hexagon, x, version), { compressed: true });
const X = (text: string) => readObsidianExcalidrawMarkdown(text).elements[0].x;
const copies = async (store: FileStore) => (await store.list()).filter((entry) => entry.path.includes('(conflict ')).map((entry) => entry.path);

/** Waits until `check` (sync or async) holds; the check's promise is awaited. */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(2);
  }
}

/** A store whose watchers hear other changes only once released, in order. */
function lateMessages(inner: FileStore) {
  let holding = false;
  const held: Array<() => void> = [];
  const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
    watch: (listener: (change: FileChange) => void) =>
      inner.watch((change) => {
        if (holding) held.push(() => listener(change));
        else listener(change);
      }),
  });
  return {
    store,
    hold: () => {
      holding = true;
    },
    release: () => {
      holding = false;
      for (const deliver of held.splice(0)) deliver();
    },
  };
}

describe('Keep mine goes over the change the bar showed, and only that', () => {
  it('note: a change landing after the bar, not heard yet, is asked about again', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'v1');
    const late = lateMessages(disk.twin());
    const other = disk.twin();
    const s = createTextSession(late.store, 'n.md', { saveDelayMs: 10_000, scope: 'r5-keep-note' });
    await s.ready;
    s.edit('mine');
    await other.write('n.md', 'theirs 1');
    await until(() => s.getState().conflict);
    late.hold();
    await other.write('n.md', 'theirs 2');
    await s.keepMine();
    expect(await disk.readText('n.md')).toBe('theirs 2');
    expect(s.getState()).toMatchObject({ conflict: true, dirty: true });
    late.release();
    await s.dispose();
    const [copy] = await copies(disk);
    expect(await disk.readText(copy)).toBe('mine');
  });

  it('canvas: a change landing after the bar, not heard yet, is asked about again', async () => {
    const disk = new MemoryFileStore();
    await disk.write('c.excalidraw.md', drawing(1, 1));
    const late = lateMessages(disk.twin());
    const other = disk.twin();
    const s = createFileSceneStore({ store: late.store, path: 'c.excalidraw.md', intervalMs: 10_000, scope: 'r5-keep-canvas' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 888, 50)));
    await other.write('c.excalidraw.md', drawing(4242, 60));
    await until(() => s.getState().conflict);
    late.hold();
    await other.write('c.excalidraw.md', drawing(5353, 70));
    await s.keepMine();
    expect(X(await disk.readText('c.excalidraw.md'))).toBe(5353);
    expect(s.getState()).toMatchObject({ conflict: true, pending: true });
    late.release();
    await s.dispose();
    const [copy] = await copies(disk);
    expect(X(await disk.readText(copy))).toBe(888);
  });
});

describe('a file moved elsewhere before this tab hears of it', () => {
  it('note: the save waits for the rename and lands at the new path, with no conflict', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.md', 'v1');
    const late = lateMessages(disk.twin());
    const s = createTextSession(late.store, 'A.md', { saveDelayMs: 10_000, scope: 'r5-moved-note' });
    await s.ready;
    late.hold();
    await disk.twin().rename('A.md', 'B.md');
    s.edit('mine');
    await s.flush();
    expect(s.getState()).toMatchObject({ conflict: false, dirty: true });
    late.release();
    await until(() => !s.getState().dirty);
    expect(await disk.readText('B.md')).toBe('mine');
    expect(s.getState().conflict).toBe(false);
    expect((await disk.list()).map((entry) => entry.path)).toEqual(['B.md']);
    await s.dispose();
  });

  it('canvas: the save waits for the rename and lands at the new path, with no conflict', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.excalidraw.md', drawing(1, 1));
    const late = lateMessages(disk.twin());
    const s = createFileSceneStore({ store: late.store, path: 'A.excalidraw.md', intervalMs: 10_000, scope: 'r5-moved-canvas' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    late.hold();
    await disk.twin().rename('A.excalidraw.md', 'B.excalidraw.md');
    await s.save(doc(bump(loaded.scene, 888, 50)));
    await s.flush();
    expect(s.getState()).toMatchObject({ conflict: false, pending: true });
    late.release();
    await until(() => !s.getState().pending);
    expect(X(await disk.readText('B.excalidraw.md'))).toBe(888);
    expect(s.getState().conflict).toBe(false);
    await s.dispose();
  });

  it('note: closed before it hears, the edit is kept as a copy', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/A.md', 'v1');
    const late = lateMessages(disk.twin());
    const s = createTextSession(late.store, 'F/A.md', { saveDelayMs: 10_000, scope: 'r5-moved-closed' });
    await s.ready;
    late.hold();
    await disk.twin().rename('F/A.md', 'F/B.md');
    s.edit('mine');
    await s.dispose();
    const [copy] = await copies(disk);
    expect(await disk.readText(copy)).toBe('mine');
    expect(await disk.readText('F/B.md')).toBe('v1');
  });
});

describe('Reload drops a save queued while it waits', () => {
  it('canvas: the write in flight lands and is shown; a flush during Reload writes nothing more', async () => {
    const disk = new MemoryFileStore();
    await disk.write('c.excalidraw.md', drawing(1, 1));
    let release = () => {};
    let holding = true;
    const tab = disk.twin({ delay: (change) => (change.type === 'write' && holding ? new Promise<void>((resolve) => (release = resolve)) : undefined) });
    const s = createFileSceneStore({ store: tab, path: 'c.excalidraw.md', intervalMs: 10_000, scope: 'r5-reload' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 777, 50)));
    void s.flush(); // 777: in flight, held in the store
    await wait(5);
    await s.save(doc(bump(loaded.scene, 888, 60)));
    const reloading = s.reload();
    void s.flush(); // a tab switch, say, while Reload waits
    holding = false;
    release();
    await reloading;
    await s.flush();
    await wait(10);
    expect(X(await disk.readText('c.excalidraw.md'))).toBe(777);
    expect(s.getState().pending).toBe(false);
    const shown = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    expect(shown.scene.elements[0].x).toBe(777);
    await s.dispose();
  });
});

describe('Reload drops an edit queued while it waits (note)', () => {
  it('the write in flight lands and is shown; a flush while Reload reads writes nothing more', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'v1');
    let release = () => {};
    let holding = true;
    const tab = disk.twin({ delay: (change) => (change.type === 'write' && holding ? new Promise<void>((resolve) => (release = resolve)) : undefined) });
    // Reads wait for `open()` once armed (Reload's, and the echo's), so a
    // write queued meanwhile has its turn first.
    let slowRead = false;
    let open = () => {};
    const gate = new Promise<void>((resolve) => (open = resolve));
    const store: FileStore = Object.assign(Object.create(tab) as FileStore, {
      readText: async (path: string) => {
        if (slowRead) await gate;
        return tab.readText(path);
      },
    });
    const s = createTextSession(store, 'n.md', { saveDelayMs: 10_000, scope: 'r5-reload-note' });
    await s.ready;
    s.edit('one');
    void s.flush(); // 'one': in flight, held in the store
    await wait(5);
    s.edit('two');
    slowRead = true;
    const reloading = s.reload();
    holding = false;
    release();
    await wait(5); // 'one' has landed; Reload is reading
    const flushing = s.flush(); // a tab switch, say, while Reload reads
    await wait(5);
    open();
    await reloading;
    await flushing;
    await wait(10);
    expect(await disk.readText('n.md')).toBe('one');
    expect(s.getState()).toMatchObject({ text: 'one', dirty: false });
    await s.dispose();
  });
});

describe('two writes of one size in one millisecond (G3, without a rename)', () => {
  it("note: another tab's same-size save, which the stat can't see, is refused and asked about", async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const disk = new MemoryFileStore();
      await disk.write('n.md', 'v1');
      const late = lateMessages(disk.twin());
      const s = createTextSession(late.store, 'n.md', { saveDelayMs: 10_000, scope: 'r5-same-ms' });
      await s.ready;
      s.edit('mine');
      await s.flush();
      late.hold();
      await disk.twin().write('n.md', 'them'); // the same size as 'mine', in the same millisecond
      s.edit('mine 2');
      await s.flush();
      expect(await disk.readText('n.md')).toBe('them');
      expect(s.getState().conflict).toBe(true);
      late.release();
      await s.dispose();
      const [copy] = await copies(disk);
      expect(await disk.readText(copy)).toBe('mine 2');
    } finally {
      now.mockRestore();
    }
  });
});
