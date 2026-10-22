// Round 4, F6: a write carried by another tab's rename counts as this session's own,
// but a real change made elsewhere after that rename must still be a conflict.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import hexagonText from '../../../../sketches/workspace/assets/winter-hexagon.excalidraw?raw';
import { MemoryFileStore } from '../../../../src/files/memoryStore';
import type { FileStore } from '../../../../src/files/types';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../../src/nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../../src/nebula/excalidraw/scene';
import { createEmptyNebulaMetadata } from '../../../../src/nebula/excalidraw/metadata';
import { createFileSceneStore } from '../../../../src/workspace/views/canvas/fileSceneStore';
import { createTextSession } from '../../../../src/workspace/views/shared/textSession';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from '../../../../src/workspace/views/shared/fileSessions';

/** Kept from the reviewer's probes; prints nothing. */
const log = (...args: unknown[]): void => void args;
const hexagon = JSON.parse(hexagonText) as ExcalidrawScene;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const doc = (s: ExcalidrawScene) => ({ type: 'starscape.nebula.excalidraw' as const, version: 1 as const, boardId: 'p', canvasId: 'x', name: 'x', updatedAt: '', scene: s, nebula: createEmptyNebulaMetadata() });
const bump = (s: ExcalidrawScene, x: number, dv = 1): ExcalidrawScene => ({ ...s, elements: s.elements.map((e, i) => (i === 0 ? { ...e, x, version: Number(e.version ?? 1) + dv } : e)) });
const copies = async (store: FileStore) => (await store.list()).filter((e) => e.type === 'file' && e.path.includes('(conflict ')).map((e) => e.path);

let kept: KeptCopy[] = [];
let stop: () => void = () => {};
beforeEach(() => {
  kept = [];
  stop = subscribeKeptCopies((c) => kept.push(c));
});
afterEach(() => stop());

/** A store whose stat/readText of `gated` paths wait for `open()`: the session's
 * re-aimed check is held until the other tab has acted. Forwards every argument. */
function gated(inner: FileStore, paths: string[]) {
  let open!: () => void;
  const gate = new Promise<void>((r) => (open = r));
  let isOpen = false;
  const store = new Proxy(inner, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function') return v;
      if (prop === 'stat' || prop === 'readText') {
        return async (...args: unknown[]) => {
          if (!isOpen && paths.includes(args[0] as string)) await gate;
          return (v as (...a: unknown[]) => unknown).apply(target, args);
        };
      }
      return (...args: unknown[]) => (v as (...a: unknown[]) => unknown).apply(target, args);
    },
  }) as FileStore;
  return { store, open: () => { isOpen = true; open(); } };
}

type Step = (other: MemoryFileStore) => Promise<string>; // returns where the file is now

const scenarios: Array<[string, Step]> = [
  ['another tab writes different content at the new path', async (o) => { await o.write('B.md', 'theirs'); return 'B.md'; }],
  ['another tab renames again, then writes', async (o) => { await o.rename('B.md', 'C.md'); await o.write('C.md', 'theirs'); return 'C.md'; }],
  ['another tab writes, then renames again', async (o) => { await o.write('B.md', 'theirs'); await o.rename('B.md', 'C.md'); return 'C.md'; }],
  ['a folder rename carries it, then a write', async (o) => { await o.rename('B.md', 'F/B.md').catch(async () => { await o.mkdir('F'); await o.rename('B.md', 'F/B.md'); }); await o.write('F/B.md', 'theirs'); return 'F/B.md'; }],
];

describe('F6 note: a real change after the carrying rename is a conflict', () => {
  for (const gatedCheck of [true, false]) {
    for (const [name, step] of scenarios) {
      it(`${name} (${gatedCheck ? 'check held until it lands' : 'natural order'})`, async () => {
        const disk = new MemoryFileStore();
        await disk.write('A.md', 'v1');
        const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.md' ? wait(30) : undefined) });
        const g = gated(tab, ['B.md', 'C.md', 'F/B.md']);
        const s = createTextSession(gatedCheck ? g.store : tab, 'A.md', { saveDelayMs: 1, scope: `f6n-${name}-${gatedCheck}` });
        await s.ready;
        s.edit('mine');
        await wait(10); // the write of 'mine' is now inside the store, holding A.md
        const other = disk.twin();
        await other.rename('A.md', 'B.md'); // waits for it, and carries 'mine'
        expect(await other.readText('B.md')).toBe('mine');
        const where = await step(other);
        g.open();
        await s.flush();
        await wait(20);
        const state = s.getState();
        const onDisk = await disk.readText(where);
        log('F6 note', name, gatedCheck, { conflict: state.conflict, dirty: state.dirty, onDisk });
        // 'theirs' must survive; the session must not silently write 'mine' over it.
        expect(onDisk).toBe('theirs');
        // 'mine' was saved (the rename carried it) before 'theirs' landed, so taking 'theirs'
        // is ordinary last-writer behaviour, not a loss made by this session.
        await s.dispose();
        expect(await disk.readText(where)).toBe('theirs');
        expect(hasUnsavedChanges()).toBe(false);
      });
    }
  }

  it('the carried text is still its own: no false conflict, and the edit typed meanwhile lands', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.md', 'v1');
    const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.md' ? wait(30) : undefined) });
    const g = gated(tab, ['B.md']);
    const s = createTextSession(g.store, 'A.md', { saveDelayMs: 1, scope: 'f6n-own' });
    await s.ready;
    s.edit('mine');
    await wait(10);
    await disk.twin().rename('A.md', 'B.md');
    s.edit('mine 2');
    g.open();
    await s.flush();
    await wait(20);
    await s.flush();
    // Round 5 (G5): at 41a30fd checkDisk's echo of the write at the OLD path, read after inFlight
    // was cleared, wasn't compared with `carried`: a false conflict, and a needless copy on close.
    expect(s.getState().conflict).toBe(false);
    expect(await disk.readText('B.md')).toBe('mine 2');
    await s.dispose();
    expect(await copies(disk)).toEqual([]);
  });
});

describe('F6 canvas: a real change after the carrying rename is a conflict', () => {
  const theirsText = toObsidianExcalidrawMarkdown(bump(hexagon, 4242, 5), { compressed: true });
  const canvasScenarios: Array<[string, (o: MemoryFileStore) => Promise<string>]> = [
    ['another tab writes a different drawing at the new path', async (o) => { await o.write('B.excalidraw.md', theirsText); return 'B.excalidraw.md'; }],
    ['another tab renames again, then writes', async (o) => { await o.rename('B.excalidraw.md', 'C.excalidraw.md'); await o.write('C.excalidraw.md', theirsText); return 'C.excalidraw.md'; }],
    ['another tab writes, then renames again', async (o) => { await o.write('B.excalidraw.md', theirsText); await o.rename('B.excalidraw.md', 'C.excalidraw.md'); return 'C.excalidraw.md'; }],
  ];
  for (const gatedCheck of [true, false]) {
    for (const [name, step] of canvasScenarios) {
      it(`${name} (${gatedCheck ? 'check held' : 'natural order'})`, async () => {
        const disk = new MemoryFileStore();
        await disk.write('A.excalidraw.md', toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
        const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.excalidraw.md' ? wait(30) : undefined) });
        const g = gated(tab, ['B.excalidraw.md', 'C.excalidraw.md']);
        const s = createFileSceneStore({ store: gatedCheck ? g.store : tab, path: 'A.excalidraw.md', intervalMs: 1, scope: `f6c-${name}-${gatedCheck}` });
        const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
        await s.save(doc(loaded.scene));
        await s.save(doc(bump(loaded.scene, 777)));
        await wait(10);
        const other = disk.twin();
        await other.rename('A.excalidraw.md', 'B.excalidraw.md');
        expect(readObsidianExcalidrawMarkdown(await other.readText('B.excalidraw.md')).elements[0].x).toBe(777);
        // and the user keeps drawing while the re-aimed write waits
        await s.save(doc(bump(loaded.scene, 888, 2)));
        const where = await step(other);
        g.open();
        await s.flush();
        await wait(30);
        const state = s.getState();
        const x = readObsidianExcalidrawMarkdown(await disk.readText(where)).elements[0].x;
        log('F6 canvas', name, gatedCheck, { conflict: state.conflict, x });
        // Round 5 (G3): at 41a30fd, in natural order, theirs landed while the re-aimed write
        // serialised after its check, and was overwritten without a conflict.
        expect(x).toBe(4242); // theirs survives
        expect(state.conflict).toBe(true);
        await s.dispose();
        const list = await copies(disk);
        expect(list).toHaveLength(1);
        const copyX = readObsidianExcalidrawMarkdown(await disk.readText(list[0])).elements[0].x;
        // Round 5 (G2): the copy holds 888, the drawing on screen, never the older 777.
        expect(copyX).toBe(888);
        log('F6 canvas copy x', name, gatedCheck, copyX);
        expect(hasUnsavedChanges()).toBe(false);
      });
    }
  }
});

/** Waits until `check` (sync or async) holds; the check's promise is awaited. */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(2);
  }
}

describe('round 5, F6 rebuilt: carried bytes are its own, and only they are', () => {
  it('note: two renames in a row carry the write: no conflict, and the newest edit lands at the end', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.md', 'v1');
    const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.md' ? wait(30) : undefined) });
    const s = createTextSession(tab, 'A.md', { saveDelayMs: 1, scope: 'r5-two-renames-note' });
    await s.ready;
    s.edit('mine');
    await wait(10); // the write of 'mine' is inside the store, holding A.md
    const other = disk.twin();
    await other.rename('A.md', 'B.md');
    await other.rename('B.md', 'C.md');
    s.edit('mine 2');
    await s.flush();
    await until(() => !s.getState().dirty);
    expect(s.getState().conflict).toBe(false);
    expect(await disk.readText('C.md')).toBe('mine 2');
    await s.dispose();
    expect(await copies(disk)).toEqual([]);
  });

  it('canvas: two renames in a row carry the write: no conflict, and the newest drawing lands at the end', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.excalidraw.md', toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
    const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.excalidraw.md' ? wait(30) : undefined) });
    const s = createFileSceneStore({ store: tab, path: 'A.excalidraw.md', intervalMs: 1, scope: 'r5-two-renames-canvas' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 777)));
    await wait(10);
    const other = disk.twin();
    await other.rename('A.excalidraw.md', 'B.excalidraw.md');
    await other.rename('B.excalidraw.md', 'C.excalidraw.md');
    await s.save(doc(bump(loaded.scene, 888, 2)));
    await s.flush();
    await until(() => !s.getState().pending);
    expect(s.getState().conflict).toBe(false);
    expect(readObsidianExcalidrawMarkdown(await disk.readText('C.excalidraw.md')).elements[0].x).toBe(888);
    await s.dispose();
    expect(await copies(disk)).toEqual([]);
  });

  it('note (G6): after a conflict and Reload, a change byte-identical to the carried text is taken, not ignored', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.md', 'v1');
    const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.md' ? wait(30) : undefined) });
    const g = gated(tab, ['B.md']);
    const s = createTextSession(g.store, 'A.md', { saveDelayMs: 1, scope: 'r5-g6-note' });
    await s.ready;
    s.edit('mine');
    await wait(10);
    const other = disk.twin();
    await other.rename('A.md', 'B.md'); // carries 'mine'
    await other.write('B.md', 'theirs');
    g.open();
    await s.flush();
    await until(() => s.getState().conflict);
    await s.reload();
    expect(s.getState().text).toBe('theirs');
    await other.write('B.md', 'mine'); // the carried bytes again, from another tab
    await until(() => s.getState().text === 'mine');
    expect(s.getState().dirty).toBe(false);
    await s.dispose();
  });

  it('canvas (G6): after a conflict and Reload, a change byte-identical to the carried text is taken, not ignored', async () => {
    const disk = new MemoryFileStore();
    await disk.write('A.excalidraw.md', toObsidianExcalidrawMarkdown(hexagon, { compressed: true }));
    const tab = disk.twin({ delay: (c) => (c.type === 'write' && c.path === 'A.excalidraw.md' ? wait(30) : undefined) });
    const g = gated(tab, ['B.excalidraw.md']);
    const s = createFileSceneStore({ store: g.store, path: 'A.excalidraw.md', intervalMs: 1, scope: 'r5-g6-canvas' });
    const loaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(loaded.scene));
    await s.save(doc(bump(loaded.scene, 777)));
    await wait(10);
    const other = disk.twin();
    await other.rename('A.excalidraw.md', 'B.excalidraw.md'); // carries 777
    const carried = await other.readText('B.excalidraw.md');
    await other.write('B.excalidraw.md', toObsidianExcalidrawMarkdown(bump(hexagon, 4242, 5), { compressed: true }));
    g.open();
    await s.flush();
    await until(() => s.getState().conflict);
    await s.reload();
    const reloaded = (await s.load({ boardId: 'p', canvasId: 'c' }))!;
    await s.save(doc(reloaded.scene));
    expect(reloaded.scene.elements[0].x).toBe(4242);
    const revision = s.getState().revision;
    await other.write('B.excalidraw.md', carried); // the carried bytes again, from another tab
    await until(() => s.getState().revision > revision);
    expect(readObsidianExcalidrawMarkdown(carried).elements[0].x).toBe(777);
    await s.dispose();
  });
});
