import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileStore } from '../../../files/types';
import { createFileSceneStore, serialize } from '../canvas/fileSceneStore';
import { createTextSession } from '../shared/textSession';
import { doc, drawing, gate, lateMessages, parse, REF, until } from './testkit';

/**
 * The sixth review's N2 and N7, pinned one ordering each.
 *
 * N2: a change heard whose read failed because the file had just moved was
 * dropped, and so was one heard while a canvas remount loaded; the session
 * then showed an older version with nothing unsaved. A note's checks weren't
 * serialised, so an older read could apply after a newer one.
 * N7: an edit made while Reload read, after a Reload that failed, waited with
 * no timer until the next edit or flush.
 */

/** A tab's store whose reads can be watched, held, or made to fail. */
function instrumented(inner: FileStore) {
  const failed: string[] = [];
  let finished = 0;
  let holdNext: ReturnType<typeof gate> | null = null;
  let failNext: ReturnType<typeof gate> | null = null;
  const held = gate();
  const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
    readText: async (path: string) => {
      const failing = failNext;
      if (failing) {
        failNext = null;
        await failing.opened;
        finished += 1;
        throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
      }
      try {
        const text = await inner.readText(path);
        const holding = holdNext;
        if (holding) {
          holdNext = null;
          held.open();
          await holding.opened;
        }
        return text;
      } catch (error) {
        failed.push(path);
        throw error;
      } finally {
        finished += 1;
      }
    },
  });
  return {
    store,
    failed,
    finished: () => finished,
    /** The next read takes the file as it is, then waits for the gate. */
    holdNextRead: () => (holdNext = gate()),
    held: held.opened,
    /** The next read waits for the gate, then fails. */
    failNextRead: () => (failNext = gate()),
  };
}

describe('N2: a change heard as the file moves is checked again', () => {
  it('note: a change whose read failed because the file just moved is shown once the rename is heard', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.md', 'seed');
    const reads = instrumented(disk.twin());
    const late = lateMessages(reads.store);
    const note = createTextSession(late.store, 'a.md', { saveDelayMs: 2 ** 30, scope: 'n2-note' });
    await note.ready;
    const other = disk.twin();
    late.hold();
    await other.write('a.md', 'theirs');
    await other.rename('a.md', 'b.md');
    // The change reaches this tab first: its read finds nothing at a.md.
    late.releaseOne();
    expect(await until(() => reads.failed.includes('a.md'))).toBe(true);
    // Then the rename.
    late.release();
    const shown = await until(() => note.getState().text === 'theirs');
    await note.dispose();
    expect(shown, 'the note shows "seed", with nothing unsaved, while b.md holds "theirs"').toBe(true);
  });

  it('canvas: a change whose read failed because the file just moved is taken once the rename is heard', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.excalidraw', serialize(null, drawing(100, 1), 'json'));
    const reads = instrumented(disk.twin());
    const late = lateMessages(reads.store);
    const canvas = createFileSceneStore({ store: late.store, path: 'a.excalidraw', intervalMs: 2 ** 30, scope: 'n2-canvas' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    const other = disk.twin();
    late.hold();
    await other.write('a.excalidraw', serialize(null, drawing(200, 2), 'json'));
    await other.rename('a.excalidraw', 'b.excalidraw');
    late.releaseOne();
    expect(await until(() => reads.failed.includes('a.excalidraw'))).toBe(true);
    late.release();
    const taken = await until(() => canvas.getState().revision === 1);
    const remounted = taken ? (await canvas.load(REF))!.scene.elements[0].x : null;
    await canvas.dispose();
    expect(taken, 'the canvas shows x=100, with nothing unsaved, while b.excalidraw holds x=200').toBe(true);
    expect(remounted).toBe(200);
  });

  it('canvas: a change heard while a remount loads is checked once the load applies', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, drawing(100, 1), 'json'));
    const reads = instrumented(disk.twin());
    const canvas = createFileSceneStore({ store: reads.store, path, intervalMs: 2 ** 30, scope: 'n2-remount' });
    const first = await canvas.load(REF);
    await canvas.save(doc(first!.scene));
    const other = disk.twin();
    await other.write(path, serialize(null, drawing(200, 2), 'json'));
    expect(await until(() => canvas.getState().revision === 1)).toBe(true);
    // The remount's load reads x=200 and is held before it applies; another
    // change lands meanwhile.
    const loadGate = reads.holdNextRead();
    const remount = canvas.load(REF);
    await reads.held;
    await other.write(path, serialize(null, drawing(300, 3), 'json'));
    loadGate.open();
    expect((await remount)!.scene.elements[0].x).toBe(200);
    const taken = await until(() => canvas.getState().revision === 2);
    const next = taken ? (await canvas.load(REF))!.scene.elements[0].x : null;
    await canvas.dispose();
    expect(taken, 'the canvas shows x=200, with nothing unsaved, while the file holds x=300').toBe(true);
    expect(next).toBe(300);
  });

  it('note: an older read never applies after a newer one', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'seed');
    const reads = instrumented(disk.twin());
    const note = createTextSession(reads.store, 'n.md', { saveDelayMs: 2 ** 30, scope: 'n2-order' });
    await note.ready;
    const other = disk.twin();
    const readsBefore = reads.finished();
    // The first change's read takes "v1" and is held.
    const first = reads.holdNextRead();
    await other.write('n.md', 'v1');
    await reads.held;
    // A second change lands; unserialised, its read takes "v2" and applies.
    await other.write('n.md', 'v2');
    await until(() => note.getState().text === 'v2', 200);
    first.open();
    // Both reads are done.
    expect(await until(() => reads.finished() >= readsBefore + 2)).toBe(true);
    await until(() => note.getState().text === 'v2');
    const state = note.getState();
    await note.dispose();
    expect({ text: state.text, dirty: state.dirty }, 'the older read applied last').toEqual({ text: 'v2', dirty: false });
  });
});

describe('N7: after a Reload that fails, an edit made while it read is written', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('canvas', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, drawing(100, 1), 'json'));
    const reads = instrumented(disk.twin());
    const canvas = createFileSceneStore({ store: reads.store, path, intervalMs: 50, scope: 'n7-canvas' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failing = reads.failNextRead();
    const reloading = canvas.reload();
    // Drawn while Reload reads; its save timer comes round while Reload
    // still holds writes.
    await canvas.save(doc(drawing(300, 2)));
    await vi.advanceTimersByTimeAsync(60);
    failing.open();
    await reloading;
    expect(canvas.getState().pending).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    const written = await until(async () => parse(await disk.readText(path)).elements[0].x === 300);
    await canvas.dispose();
    expect(written, 'the edit waited with no timer').toBe(true);
  });

  it('note', async () => {
    const disk = new MemoryFileStore();
    await disk.write('n.md', 'seed');
    const reads = instrumented(disk.twin());
    const note = createTextSession(reads.store, 'n.md', { saveDelayMs: 50, scope: 'n7-note' });
    await note.ready;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const failing = reads.failNextRead();
    const reloading = note.reload();
    note.edit('mine');
    await vi.advanceTimersByTimeAsync(60);
    failing.open();
    await reloading;
    expect(note.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(60);
    vi.useRealTimers();
    const written = await until(async () => (await disk.readText('n.md')) === 'mine');
    await note.dispose();
    expect(written, 'the edit waited with no timer').toBe(true);
  });
});

describe('Keep mine’s write that fails is still Keep mine’s when tried again (long run, canvas seed 14946)', () => {
  it('writes the drawing over the other change on the next try, even when it matches what this canvas last saved', async () => {
    const disk = new MemoryFileStore();
    await disk.write('a.excalidraw', serialize(null, drawing(100, 1), 'json'));
    const other = disk.twin();
    const inner = disk.twin();
    let failNextWrite = false;
    const store = Object.assign(Object.create(inner) as FileStore, {
      write: async (...args: Parameters<FileStore['write']>) => {
        if (failNextWrite) {
          failNextWrite = false;
          throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        }
        return inner.write(...args);
      },
    });
    const canvas = createFileSceneStore({ store, path: 'a.excalidraw', intervalMs: 2 ** 30, scope: 'r7-force' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    // A setting changed and changed back: unsaved, and the same as on disk.
    await canvas.save(doc({ ...loaded!.scene, appState: { ...loaded!.scene.appState, viewBackgroundColor: '#ffc9c9' } }));
    await canvas.save(doc(loaded!.scene));
    // Another tab's change: the bar. The user keeps theirs; the write fails.
    await other.write('a.excalidraw', serialize(null, drawing(900, 2), 'json'));
    expect(await until(() => canvas.getState().conflict)).toBe(true);
    failNextWrite = true;
    await canvas.keepMine();
    expect(canvas.getState().pending).toBe(true);
    // Try again.
    await canvas.flush();
    const state = canvas.getState();
    const final = parse(await disk.readText('a.excalidraw')).elements[0].x;
    await canvas.dispose();
    expect({ final, pending: state.pending, conflict: state.conflict }, 'Keep mine was dropped once its write failed').toEqual({ final: 100, pending: false, conflict: false });
  });
});
