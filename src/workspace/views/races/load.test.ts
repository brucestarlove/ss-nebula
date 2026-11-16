import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileStore } from '../../../files/types';
import { createFileSceneStore, serialize } from '../canvas/fileSceneStore';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { doc, drawing, parse, REF, until } from './testkit';

/**
 * The sixth review's N3: a remount's load that failed stayed failed for
 * good. `loading` kept the rejected promise and `loaded` stayed false, so
 * every later load rejected again, every change heard was ignored, and an
 * edit made on the shell's fallback canvas was dropped with nothing pending
 * and no warning. (The reviewer's load.test.ts, split by what it proves.)
 */

/** A tab whose next read of the file fails (the file moving under it). */
function failingReads(inner: FileStore) {
  let fails = 0;
  const store: FileStore = Object.assign(Object.create(inner) as FileStore, {
    readText: async (path: string) => {
      if (fails > 0) {
        fails -= 1;
        throw new DOMException('A requested file or directory could not be found.', 'NotFoundError');
      }
      return inner.readText(path);
    },
  });
  return { store, failNext: () => void (fails += 1) };
}

/** A canvas open on `c.excalidraw` that took another tab's change, and whose
 * remount's load then failed: the other tab saved the file half-typed. */
async function failedRemount(scope: string) {
  const disk = new MemoryFileStore();
  const path = 'c.excalidraw';
  await disk.write(path, serialize(null, drawing(100, 1), 'json'));
  const other = disk.twin();
  const canvas = createFileSceneStore({ store: disk.twin(), path, intervalMs: 2 ** 30, scope });
  const first = await canvas.load(REF);
  await canvas.save(doc(first!.scene));
  await other.write(path, serialize(null, drawing(200, 2), 'json'));
  expect(await until(() => canvas.getState().revision === 1)).toBe(true);
  await other.write(path, '{"type":"excalidraw","elements":[');
  expect(await canvas.load(REF).then(() => 'loaded', () => 'rejected')).toBe('rejected');
  return { disk, other, canvas, path };
}

describe('N3: a remount’s load that fails', () => {
  it('is tried again: the next load reads the file afresh', async () => {
    const disk = new MemoryFileStore();
    const path = 'c.excalidraw';
    await disk.write(path, serialize(null, drawing(100, 1), 'json'));
    const reads = failingReads(disk.twin());
    const canvas = createFileSceneStore({ store: reads.store, path, intervalMs: 2 ** 30, scope: 'n3-retry' });
    reads.failNext();
    expect(await canvas.load(REF).then(() => 'loaded', () => 'rejected')).toBe('rejected');
    const again = await canvas.load(REF).then((loaded) => loaded!.scene.elements[0].x, () => 'rejected');
    await canvas.dispose();
    expect(again).toBe(100);
  });

  it('takes the next change heard: the canvas remounts and loads it', async () => {
    const { other, canvas, path } = await failedRemount('n3-heard');
    // The other tab finishes typing: a drawing again.
    await other.write(path, serialize(null, drawing(400, 4), 'json'));
    const remounted = await until(() => canvas.getState().revision === 2);
    const loaded = await canvas.load(REF).then((document) => document!.scene.elements[0].x, () => 'rejected');
    await canvas.dispose();
    expect(remounted, 'the change heard after the failed load was ignored').toBe(true);
    expect(loaded).toBe(400);
  });

  it('takes the empty canvas’s echo (a host’s fallback, as it mounts) for nothing to keep', async () => {
    const { canvas } = await failedRemount('n3-echo');
    await canvas.save(doc({ ...drawing(0), elements: [] }));
    const state = canvas.getState();
    await canvas.dispose();
    expect({ pending: state.pending, conflict: state.conflict }).toEqual({ pending: false, conflict: false });
  });

  it('never drops an edit made after it silently: it is held, the page warns, and closing keeps it as a copy', async () => {
    const kept: KeptCopy[] = [];
    const stop = subscribeKeptCopies((copy) => kept.push(copy));
    const { disk, canvas, path } = await failedRemount('n3-edit');
    // A host that shows a fallback canvas lets the user draw on it.
    await canvas.save(doc(drawing(300, 3)));
    const state = canvas.getState();
    const warns = hasUnsavedChanges();
    await canvas.dispose();
    stop();
    expect({ pending: state.pending, warns }, 'an edit after the failed load was dropped with no warning').toEqual({ pending: true, warns: true });
    // It was never written over a file this canvas didn't show.
    expect(await disk.readText(path)).toBe('{"type":"excalidraw","elements":[');
    const copy = kept.find((entry) => entry.scope === 'n3-edit' && entry.copy !== null);
    expect(copy, 'no copy was kept').toBeDefined();
    expect(parse(await disk.readText(copy!.copy!)).elements[0].x).toBe(300);
  });
});
