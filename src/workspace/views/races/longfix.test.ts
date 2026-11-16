import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileStore } from '../../../files/types';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore, serialize } from '../canvas/fileSceneStore';
import { subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { createTextSession } from '../shared/textSession';
import { doc, drawing, gate, REF, until } from './testkit';

/**
 * Deterministic pins for round 6's two fixes that only the 10,000-seed run
 * found (the sixth review's longfix.test.ts): note seeds 3712 and 6342 (L1),
 * canvas seeds 2612 and 8321 (L2). Each fails with its fix reverted.
 */

describe('L1: a note hears a change while its own write is returning (seeds 3712, 6342)', () => {
  it('takes it once the write lands, never a conflict with nothing to keep, so Keep mine never writes over it', async () => {
    const disk = new MemoryFileStore();
    const path = 'n.md';
    await disk.write(path, 'seed');
    const other = disk.twin();
    const inner = disk.twin();
    let hold: ReturnType<typeof gate> | null = null;
    const landed = gate();
    const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
      write: async (...args: Parameters<FileStore['write']>) => {
        await inner.write(...args);
        landed.open();
        if (hold) await hold.opened;
      },
    });
    const note = createTextSession(store, path, { saveDelayMs: 2 ** 30, scope: 'l1' });
    await note.ready;
    note.edit('mine');
    hold = gate();
    const flushing = note.flush();
    await landed.opened;
    // Landed; before the call returns, another tab (which saw "mine") saves.
    // This tab hears it at once.
    await other.write(path, 'theirs', { ifUnchanged: { text: 'mine' } });
    // Judged at once (the fix reverted), it raises the bar while the write
    // is still returning; judged after the write, nothing comes here.
    await until(() => note.getState().conflict, 200);
    hold.open();
    await flushing;
    await until(() => note.getState().text === 'theirs' || note.getState().conflict);
    const state = note.getState();
    // Were the bar up, the user would pick Keep mine.
    if (state.conflict) await note.keepMine();
    const final = await disk.readText(path);
    await note.dispose();
    expect({ conflict: state.conflict, final }).toEqual({ conflict: false, final: 'theirs' });
  });
});

describe('L2: a canvas Reload fails because the file was deleted elsewhere (seeds 2612, 8321)', () => {
  it('keeps the newest drawing for its copy where the file was', async () => {
    const disk = new MemoryFileStore();
    const path = 'F/c.excalidraw';
    await disk.write(path, serialize(null, drawing(100, 1), 'json'));
    const other = disk.twin();
    const inner = disk.twin();
    let hold: ReturnType<typeof gate> | null = null;
    const writeStarted = gate();
    const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
      write: async (...args: Parameters<FileStore['write']>) => {
        writeStarted.open();
        if (hold) await hold.opened;
        return inner.write(...args);
      },
    });
    const kept: KeptCopy[] = [];
    const stop = subscribeKeptCopies((copy) => kept.push(copy));
    const canvas = createFileSceneStore({ store, path, intervalMs: 2 ** 30, scope: 'l2' });
    const loaded = await canvas.load(REF);
    await canvas.save(doc(loaded!.scene));
    // Draw X1: its write starts and is held at the store.
    hold = gate();
    await canvas.save(doc(drawing(201, 2)));
    const f1 = canvas.flush();
    await writeStarted.opened;
    // Draw X2: its write queues behind.
    await canvas.save(doc(drawing(202, 3)));
    const f2 = canvas.flush();
    // Reload drops both, and waits for the write in flight.
    const reloading = canvas.reload();
    // Another tab deletes the file; this tab hears it.
    await other.remove(path);
    expect(await until(() => canvas.getState().removed)).toBe(true);
    hold.open();
    await Promise.all([f1, f2, reloading]);
    await canvas.dispose();
    stop();
    const copies = (await disk.list()).filter((entry) => entry.type === 'file' && entry.path.includes('(conflict ')).map((entry) => entry.path);
    const xs = await Promise.all(copies.map(async (copy) => (JSON.parse(await disk.readText(copy)) as ExcalidrawScene).elements[0].x));
    expect(xs).toEqual([202]);
    expect(kept.filter((copy) => copy.scope === 'l2').map((copy) => copy.copy)).toEqual(copies);
  });
});
