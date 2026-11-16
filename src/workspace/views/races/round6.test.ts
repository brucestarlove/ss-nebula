import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError } from '../../../files/errors';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileChange, FileStore } from '../../../files/types';
import { createEmptyNebulaMetadata } from '../../../nebula/excalidraw/metadata';
import { readObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore, serialize } from '../canvas/fileSceneStore';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { createTextSession } from '../shared/textSession';
import { slowWrites } from '../testing/slowWrites';

/**
 * Round 6: the fifth review's reproductions (T1–T3, P1, P2), pinned on
 * their own. T1: an edit made while Keep mine's write is in flight. T2, T3:
 * Keep mine after a Reload that failed. P1: a setting changed and changed
 * back while a write is in flight (H6). P2: a save that fails as the view
 * closes (H3). Then the rest of round 6: Keep mine when the other version
 * isn't known (H2), a load overtaken by a newer one (H4), a file gone with
 * no rename (H7), Reload holding writes while it reads, and sessions of one
 * file opened one after another (all found or confirmed by the widened
 * interleaving test).
 */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
/** Waits until `check` holds. */
async function until(check: () => boolean | Promise<boolean>, ms = 2000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await wait(2);
  }
}
const element = (x: number, version: number) => ({ id: 'a', type: 'rectangle', x, y: 20, width: 100, height: 50, angle: 0, version, versionNonce: version, isDeleted: false });
const scene = (x: number, version: number, background = 'transparent'): ExcalidrawScene => ({
  type: 'excalidraw',
  version: 2,
  source: 't',
  elements: [element(x, version)],
  appState: { viewBackgroundColor: background },
  files: {},
});
const doc = (drawing: ExcalidrawScene) => ({
  type: 'starscape.nebula.excalidraw' as const,
  version: 1 as const,
  boardId: 'p',
  canvasId: 'c',
  name: 'c',
  updatedAt: '',
  scene: drawing,
  nebula: createEmptyNebulaMetadata(),
});
const xOf = (text: string) => (JSON.parse(text) as ExcalidrawScene).elements[0].x as number;

/** A store whose watchers hear changes only once released, in order. */
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

async function openCanvas(store: FileStore, path: string, scope: string) {
  const canvas = createFileSceneStore({ store, path, intervalMs: 2 ** 30, scope });
  const loaded = await canvas.load({ boardId: 'p', canvasId: 'c' });
  // Excalidraw's echo of the scene as it opened.
  await canvas.save(doc(loaded!.scene));
  return canvas;
}

describe('T1: a change made while Keep mine is being written (H1)', () => {
  it('is written after it, not taken for the echo of a load', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, scene(100, 1), 'json'));
    const mine = disk.twin();
    const canvas = await openCanvas(mine, path, 'r6-t1');
    await canvas.save(doc(scene(200, 2)));
    await disk.twin().write(path, serialize(null, scene(900, 3), 'json'));
    await until(() => canvas.getState().conflict);
    const slow = slowWrites(mine);
    const keeping = canvas.keepMine();
    await until(() => slow.waiting === 1);
    // One more change while Keep mine's write is in flight.
    await canvas.save(doc(scene(300, 4)));
    expect(canvas.getState().pending).toBe(true);
    slow.release();
    await keeping;
    await canvas.flush();
    expect(xOf(await disk.readText(path))).toBe(300);
    expect(canvas.getState().pending).toBe(false);
    await canvas.dispose();
  });
});

describe('T2: Keep mine after a Reload that failed (the file moved, not heard yet) (H2)', () => {
  it('asks again about a change that landed after the bar, and writes only when asked', async () => {
    const disk = new MemoryFileStore();
    await disk.write('F/c.excalidraw', serialize(null, scene(100, 1), 'json'));
    const late = lateMessages(disk.twin());
    const other = disk.twin();
    const canvas = await openCanvas(late.store, 'F/c.excalidraw', 'r6-t2');
    await canvas.save(doc(scene(200, 2)));
    await other.write('F/c.excalidraw', serialize(null, scene(900, 3), 'json'));
    await until(() => canvas.getState().conflict);
    late.hold();
    await other.rename('F', 'G');
    // Fails: the file isn't at F any more. The bar and the drawing stay.
    await canvas.reload();
    expect(canvas.getState()).toMatchObject({ conflict: true, pending: true });
    late.release();
    // Another change, after the bar, not heard yet when the user clicks.
    await other.write('G/c.excalidraw', serialize(null, scene(901, 4), 'json'));
    late.hold();
    await canvas.keepMine();
    late.release();
    await canvas.flush();
    expect(xOf(await disk.readText('G/c.excalidraw'))).toBe(901);
    expect(canvas.getState()).toMatchObject({ conflict: true, pending: true });
    // Asked again, the user keeps theirs once more: now it's written.
    await canvas.keepMine();
    await canvas.flush();
    expect(xOf(await disk.readText('G/c.excalidraw'))).toBe(200);
    expect(canvas.getState()).toMatchObject({ conflict: false, pending: false });
    await canvas.dispose();
  });
});

describe('T3: Reload fails because the other version is not a drawing, then Keep mine (H2)', () => {
  for (const format of ['json', 'markdown'] as const) {
    it(`${format}: the drawing stays held, and Keep mine writes it`, async () => {
      const disk = new MemoryFileStore();
      const path = format === 'json' ? 'c.excalidraw' : 'c.excalidraw.md';
      await disk.write(path, serialize(null, scene(100, 1), format));
      const canvas = await openCanvas(disk.twin(), path, `r6-t3-${format}`);
      await canvas.save(doc(scene(200, 2)));
      // Another tab (or a text view of the same file) leaves it unreadable as a drawing.
      const broken =
        format === 'json' ? '{"type":"excalidraw","elements":[' : '---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n## Drawing\n```compressed-json\n!!!\n```\n';
      await disk.twin().write(path, broken);
      await canvas.flush();
      await until(() => canvas.getState().conflict);
      await canvas.reload();
      expect(canvas.getState()).toMatchObject({ conflict: true, pending: true });
      expect(canvas.getState().error).toBeDefined();
      await canvas.keepMine();
      await canvas.flush();
      const text = await disk.readText(path);
      expect(format === 'json' ? xOf(text) : readObsidianExcalidrawMarkdown(text).elements[0].x).toBe(200);
      expect(canvas.getState()).toMatchObject({ conflict: false, pending: false });
      await canvas.dispose();
    });
  }
});

describe('P1: a setting changed and changed back while a write is in flight (H6)', () => {
  for (const variant of ['background colour and back', 'element version back'] as const) {
    it(`${variant}: the file ends as the canvas shows it`, async () => {
      const disk = new MemoryFileStore();
      const path = 'c.excalidraw';
      await disk.write(path, serialize(null, scene(10, 1), 'json'));
      const canvas = await openCanvas(disk, path, `r6-p1-${variant}`);
      const slow = slowWrites(disk);
      await canvas.save(doc(variant.startsWith('background') ? scene(10, 1, '#ff0000') : scene(10, 2)));
      const flushing = canvas.flush();
      await until(() => slow.waiting === 1);
      // Back to what the file held before.
      await canvas.save(doc(scene(10, 1)));
      slow.release();
      await flushing;
      await canvas.flush();
      const onDisk = JSON.parse(await disk.readText(path)) as ExcalidrawScene;
      expect([onDisk.elements[0].version, onDisk.appState?.viewBackgroundColor]).toEqual([1, '#ffffff']);
      expect(canvas.getState().pending).toBe(false);
      await canvas.dispose();
    });
  }
});

describe('P2: a save that fails (the store is full) as the view closes (H3)', () => {
  let stop = () => {};
  afterEach(() => stop());
  for (const kind of ['note', 'canvas'] as const) {
    it(`${kind}: the change is offered as a download, and the page warns until it's taken`, async () => {
      const kept: KeptCopy[] = [];
      stop = subscribeKeptCopies((copy) => kept.push(copy));
      const disk = new MemoryFileStore();
      const path = kind === 'note' ? 'n.md' : 'c.excalidraw';
      await disk.write(path, kind === 'note' ? 'v1' : serialize(null, scene(1, 1), 'json'));
      const write = disk.write.bind(disk);
      let full = false;
      disk.write = async (...args) => {
        if (full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        return write(...args);
      };
      let session: { dispose(): Promise<void> };
      if (kind === 'note') {
        const note = createTextSession(disk, path, { saveDelayMs: 2 ** 30, scope: 'r6-p2-note' });
        await note.ready;
        note.edit('mine, unsaved');
        session = note;
      } else {
        const canvas = await openCanvas(disk, path, 'r6-p2-canvas');
        await canvas.save(doc(scene(777, 7)));
        session = canvas;
      }
      full = true;
      await session.dispose();
      expect(await disk.readText(path)).toBe(kind === 'note' ? 'v1' : serialize(null, scene(1, 1), 'json'));
      expect(kept).toHaveLength(1);
      const [offered] = kept;
      if (offered.copy !== null) throw new Error('expected a download');
      expect((offered.error as Error).name).toBe('QuotaExceededError');
      expect(offered.download.filename).toBe(path);
      expect(offered.download.text).toContain(kind === 'note' ? 'mine, unsaved' : '"x": 777');
      expect(offered.failedSave).toBe(true);
      expect(hasUnsavedChanges()).toBe(true);
      offered.release();
      expect(hasUnsavedChanges()).toBe(false);
    });
  }
});

/** A store whose next read, once armed, reads the file and then waits
 * until released: what it returns is the file as it was then. */
function heldReads(inner: FileStore) {
  let armed = false;
  let waiting: Array<() => void> = [];
  const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
    readText: async (path: string) => {
      const text = await inner.readText(path);
      if (armed) {
        armed = false;
        await new Promise<void>((resolve) => waiting.push(resolve));
      }
      return text;
    },
  });
  return {
    store,
    arm: () => {
      armed = true;
    },
    get waiting() {
      return waiting.length;
    },
    release: () => {
      const run = waiting;
      waiting = [];
      for (const resolve of run) resolve();
    },
  };
}

/** Counts the writes that land on `store` from anywhere. */
function landings(store: FileStore) {
  const paths: string[] = [];
  store.watch((change) => {
    if (change.type === 'write') paths.push(change.path);
  });
  return paths;
}

describe('Keep mine when what the bar was raised for is unknown (H2)', () => {
  it('reads the file and asks again with it, rather than writing over it', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, scene(100, 1), 'json'));
    // Writes refused, and the read after the third refusal fails: the bar
    // goes up knowing nothing of the other version.
    const inner = disk.twin();
    let refuse = false;
    let refusals = 0;
    let unreadable = false;
    const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
      write: async (...args: Parameters<FileStore['write']>) => {
        if (!refuse) return inner.write(...args);
        refusals += 1;
        if (refusals === 3) unreadable = true;
        throw new FileChangedError(args[0]);
      },
      readText: async (target: string) => {
        if (unreadable) {
          unreadable = false;
          throw new Error('unreadable for a moment');
        }
        return inner.readText(target);
      },
    });
    const canvas = await openCanvas(store, path, 'r6-h2-unknown');
    refuse = true;
    await canvas.save(doc(scene(200, 2)));
    await canvas.flush();
    expect(canvas.getState()).toMatchObject({ conflict: true, pending: true });
    refuse = false;
    // Another change lands that this tab hasn't seen.
    await disk.twin().write(path, serialize(null, scene(901, 4), 'json'));
    await canvas.keepMine();
    await canvas.flush();
    expect(xOf(await disk.readText(path))).toBe(901);
    expect(canvas.getState()).toMatchObject({ conflict: true, pending: true });
    // Now the bar's version is known, and Keep mine writes over it.
    await canvas.keepMine();
    await canvas.flush();
    expect(xOf(await disk.readText(path))).toBe(200);
    expect(canvas.getState()).toMatchObject({ conflict: false, pending: false });
    await canvas.dispose();
  });
});

describe('a load overtaken by a newer one (H4)', () => {
  it('applies nothing of the older file, so the next echo is no change', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, scene(100, 1), 'json'));
    const held = heldReads(disk.twin());
    const other = disk.twin();
    const canvas = await openCanvas(held.store, path, 'r6-h4');
    await other.write(path, serialize(null, scene(500, 5), 'json'));
    await until(() => canvas.getState().revision === 1);
    // The canvas remounts for revision 1; its read is slow.
    held.arm();
    const stale = canvas.load({ boardId: 'p', canvasId: 'c' });
    await until(() => held.waiting === 1);
    // Meanwhile the file changes again, and Reload takes it.
    await other.write(path, serialize(null, scene(600, 6), 'json'));
    await canvas.reload();
    expect(canvas.getState().revision).toBe(2);
    held.release();
    const writes = landings(disk);
    const older = await stale;
    // The canvas remounts for revision 2.
    const fresh = await canvas.load({ boardId: 'p', canvasId: 'c' });
    // The overtaken load gives the file as it is now, not as it read it.
    expect([older!.scene.elements[0].x, fresh!.scene.elements[0].x]).toEqual([600, 600]);
    await canvas.save(doc(older!.scene));
    await canvas.save(doc(fresh!.scene));
    await canvas.flush();
    expect(canvas.getState()).toMatchObject({ conflict: false, pending: false });
    expect(writes).toEqual([]);
    await canvas.dispose();
  });
});

describe('Reload holds writes while it reads', () => {
  it('canvas: a change made while it reads is never written over the file it takes', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, scene(100, 1), 'json'));
    const held = heldReads(disk.twin());
    const canvas = await openCanvas(held.store, path, 'r6-reload-holds');
    await canvas.save(doc(scene(200, 2)));
    await disk.twin().write(path, serialize(null, scene(900, 3), 'json'));
    await until(() => canvas.getState().conflict);
    held.arm();
    const reloading = canvas.reload();
    await until(() => held.waiting === 1);
    const writes = landings(disk);
    // Drawn while Reload reads, and flushed.
    await canvas.save(doc(scene(300, 4)));
    await canvas.flush();
    expect(writes).toEqual([]);
    held.release();
    await reloading;
    await canvas.flush();
    expect(writes).toEqual([]);
    expect(xOf(await disk.readText(path))).toBe(900);
    expect(canvas.getState()).toMatchObject({ conflict: false, pending: false, revision: 1 });
    await canvas.dispose();
  });
});

describe('sessions of one file opened one after another, each with a save queued', () => {
  it('note: each waits only for the ones opened before it, so all settle', async () => {
    const disk = new MemoryFileStore();
    const path = 'n.md';
    await disk.write(path, 'v1');
    const scope = 'r6-reopen';
    const first = createTextSession(disk, path, { saveDelayMs: 2 ** 30, scope });
    await first.ready;
    first.edit('first');
    const slow = slowWrites(disk);
    const closing = first.dispose();
    await until(() => slow.waiting === 1);
    // Opened again while the first is still saving, then again.
    const second = createTextSession(disk, path, { saveDelayMs: 2 ** 30, scope });
    const secondFlushed = second.flush();
    const third = createTextSession(disk, path, { saveDelayMs: 2 ** 30, scope });
    const thirdFlushed = third.flush();
    let settled = 0;
    for (const done of [closing, second.ready, secondFlushed, third.ready, thirdFlushed]) void done.then(() => (settled += 1));
    slow.release();
    await until(() => settled === 5);
    expect([second.getState().text, third.getState().text]).toEqual(['first', 'first']);
    await second.dispose();
    await third.dispose();
  });
});

describe('a save that finds its file gone, and no rename comes (H7)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });
  const hops = async () => {
    for (let index = 0; index < 50; index += 1) await Promise.resolve();
  };

  for (const kind of ['note', 'canvas'] as const) {
    it(`${kind}: looks again after a while and, still gone, shows it deleted elsewhere; the change is kept as a copy`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const kept: KeptCopy[] = [];
      const stop = subscribeKeptCopies((copy) => kept.push(copy));
      const disk = new MemoryFileStore();
      const path = kind === 'note' ? 'F/n.md' : 'F/c.excalidraw';
      await disk.write(path, kind === 'note' ? 'v1' : serialize(null, scene(1, 1), 'json'));
      // This tab never hears the delete (another project store's channel).
      const deaf = lateMessages(disk.twin());
      const scope = `r6-h7-${kind}`;
      const session =
        kind === 'note'
          ? createTextSession(deaf.store, path, { saveDelayMs: 2 ** 30, scope, goneCheckMs: 1000 })
          : createFileSceneStore({ store: deaf.store, path, intervalMs: 2 ** 30, scope, goneCheckMs: 1000 });
      if ('ready' in session) await session.ready;
      else {
        const loaded = await session.load({ boardId: 'p', canvasId: 'c' });
        await session.save(doc(loaded!.scene));
      }
      deaf.hold();
      await disk.twin().remove(path);
      if ('ready' in session) session.edit('mine');
      else await session.save(doc(scene(42, 2)));
      await session.flush();
      // Waiting for a rename: unsaved, nothing shown yet.
      expect(session.getState().removed).toBe(false);
      await vi.advanceTimersByTimeAsync(999);
      await hops();
      expect(session.getState().removed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await hops();
      expect(session.getState().removed).toBe(true);
      expect(hasUnsavedChanges()).toBe(true);
      await session.dispose();
      stop();
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ path, deleted: true });
      const copy = kept[0].copy!;
      expect(copy.startsWith('F/')).toBe(true);
      const text = await disk.readText(copy);
      expect(kind === 'note' ? text : String(xOf(text))).toBe(kind === 'note' ? 'mine' : '42');
    });

    it(`${kind}: a rename heard within the wait is followed, and nothing shows as deleted`, async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const disk = new MemoryFileStore();
      const path = kind === 'note' ? 'F/n.md' : 'F/c.excalidraw';
      const moved = kind === 'note' ? 'G/n.md' : 'G/c.excalidraw';
      await disk.write(path, kind === 'note' ? 'v1' : serialize(null, scene(1, 1), 'json'));
      const late = lateMessages(disk.twin());
      const scope = `r6-h7-moved-${kind}`;
      const session =
        kind === 'note'
          ? createTextSession(late.store, path, { saveDelayMs: 2 ** 30, scope, goneCheckMs: 1000 })
          : createFileSceneStore({ store: late.store, path, intervalMs: 2 ** 30, scope, goneCheckMs: 1000 });
      if ('ready' in session) await session.ready;
      else {
        const loaded = await session.load({ boardId: 'p', canvasId: 'c' });
        await session.save(doc(loaded!.scene));
      }
      late.hold();
      await disk.twin().rename('F', 'G');
      if ('ready' in session) session.edit('mine');
      else await session.save(doc(scene(42, 2)));
      await session.flush();
      late.release();
      await session.flush();
      await vi.advanceTimersByTimeAsync(2000);
      await hops();
      expect(session.getState().removed).toBe(false);
      const text = await disk.readText(moved);
      expect(kind === 'note' ? text : String(xOf(text))).toBe(kind === 'note' ? 'mine' : '42');
      await session.dispose();
    });
  }
});
