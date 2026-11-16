/**
 * A canvas's unsaved change follows its project into the folder. Like a text session's edit, it is carried over
 * a move to the session that opens the file from the folder, saved through
 * ifUnchanged over the bytes it was made on, else asked about; and if no
 * session takes it within CARRY_MS it is offered as a download, never lost.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeListeners } from '../../../files/listeners';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileChange, FileStore } from '../../../files/types';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { CARRY_MS, hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { createFileSceneStore } from './fileSceneStore';

const PATH = 'Sketch.excalidraw';
const REF = { boardId: 'p', canvasId: PATH };

function folderLike(disk: MemoryFileStore): FileStore & { emit(change: FileChange): void } {
  const listeners = new ChangeListeners();
  return {
    list: () => disk.list(),
    stat: (p) => disk.stat(p),
    readText: (p) => disk.readText(p),
    readBlob: (p) => disk.readBlob(p),
    write: (...args) => disk.write(...args),
    mkdir: (p) => disk.mkdir(p),
    rename: (a, b) => disk.rename(a, b),
    remove: (p) => disk.remove(p),
    watch: (l) => listeners.add(l),
    emit: (change) => listeners.emit(change),
  };
}

const drawing = (ids: string[]) => ({
  type: 'excalidraw',
  version: 2,
  source: 'test',
  elements: ids.map((id) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1, isDeleted: false })),
  appState: { viewBackgroundColor: 'transparent' },
  files: {},
});
const idsOf = (text: string) => (JSON.parse(text) as { elements: Array<{ id: string }> }).elements.map((item) => item.id);

/** Real time: a memory store's blob reads don't run on fake timers. */
async function until(check: () => Promise<boolean> | boolean, ms = 2000): Promise<void> {
  vi.useRealTimers();
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let kept: KeptCopy[] = [];
let unsubscribe = () => {};
beforeEach(() => {
  kept = [];
  unsubscribe = subscribeKeptCopies((copy) => kept.push(copy));
});
afterEach(() => {
  unsubscribe();
  for (const copy of kept) if (copy.copy === null) copy.release();
  vi.useRealTimers();
});

/** A canvas on the browser copy, drawn on while the project moves, and
 * closed by the workspace once it has moved. */
async function drawnDuringAMove(scope: string, edited = ['a', 'b']) {
  const browser = new MemoryFileStore();
  const original = JSON.stringify(drawing(['a']));
  await browser.write(PATH, original);
  const store = folderLike(browser);
  const canvas = createFileSceneStore({ store, path: PATH, scope, intervalMs: 10 });
  const loaded = (await canvas.load(REF))!;
  await canvas.save(loaded);
  store.emit({ type: 'moving' });
  await canvas.save({ ...loaded, scene: drawing(edited) } as unknown as NebulaExcalidrawDocument);
  store.emit({ type: 'moved' });
  return { browser, store, canvas, original };
}

describe('a canvas across Move to a folder…', () => {
  it('carries its change into the folder: the session that opens the file there shows it and saves it over the same bytes', async () => {
    const { canvas, original } = await drawnDuringAMove('r3-carry');
    await canvas.dispose();
    // Nothing offered as a download, and the page still warns.
    expect(kept).toEqual([]);
    expect(hasUnsavedChanges()).toBe(true);

    const folder = new MemoryFileStore();
    await folder.write(PATH, original);
    const reopened = createFileSceneStore({ store: folder, path: PATH, scope: 'r3-carry', intervalMs: 10 });
    const shown = (await reopened.load(REF))!;
    // The canvas is given the drawing as the user left it.
    expect(shown.scene.elements.map((element) => element.id)).toEqual(['a', 'b']);
    await reopened.save(shown);
    await until(async () => idsOf(await folder.readText(PATH)).length === 2);
    expect(idsOf(await folder.readText(PATH))).toEqual(['a', 'b']);
    await until(() => !hasUnsavedChanges());
    expect(reopened.getState()).toMatchObject({ pending: false, conflict: false });
    await reopened.dispose();
    expect(kept).toEqual([]);
  });

  it('saves it even when the canvas never echoes the scene back', async () => {
    const { canvas, original } = await drawnDuringAMove('r3-no-echo');
    await canvas.dispose();
    const folder = new MemoryFileStore();
    await folder.write(PATH, original);
    const reopened = createFileSceneStore({ store: folder, path: PATH, scope: 'r3-no-echo', intervalMs: 10 });
    await reopened.load(REF);
    await until(async () => idsOf(await folder.readText(PATH)).length === 2);
    await reopened.dispose();
    expect(kept).toEqual([]);
  });

  it('asks instead of overwriting when the file in the folder is not the bytes the change was made on', async () => {
    const { canvas } = await drawnDuringAMove('r3-conflict');
    await canvas.dispose();
    const folder = new MemoryFileStore();
    const theirs = JSON.stringify(drawing(['a', 'z']));
    await folder.write(PATH, theirs);
    const reopened = createFileSceneStore({ store: folder, path: PATH, scope: 'r3-conflict', intervalMs: 10 });
    const shown = (await reopened.load(REF))!;
    expect(shown.scene.elements.map((element) => element.id)).toEqual(['a', 'b']);
    await reopened.save(shown);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(reopened.getState()).toMatchObject({ conflict: true, pending: true });
    expect(await folder.readText(PATH)).toBe(theirs);
    // Keep mine writes it; the change is not lost either way.
    await reopened.keepMine();
    expect(idsOf(await folder.readText(PATH))).toEqual(['a', 'b']);
    await until(() => !hasUnsavedChanges());
    await reopened.dispose();
  });

  it('is offered as a download, with the drawing as the file would hold it, when no session opens the file in time', async () => {
    vi.useFakeTimers();
    const { canvas } = await drawnDuringAMove('r3-unclaimed');
    await canvas.dispose();
    expect(kept).toEqual([]);
    await vi.advanceTimersByTimeAsync(CARRY_MS + 1000);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: PATH, copy: null, failedSave: true, download: { filename: PATH } });
    expect(idsOf((kept[0] as { download: { text: string } }).download.text)).toEqual(['a', 'b']);
    expect(hasUnsavedChanges()).toBe(true);
  });

  it('carries nothing when nothing is unsaved', async () => {
    const browser = new MemoryFileStore();
    await browser.write(PATH, JSON.stringify(drawing(['a'])));
    const store = folderLike(browser);
    const canvas = createFileSceneStore({ store, path: PATH, scope: 'r3-clean', intervalMs: 10 });
    const loaded = (await canvas.load(REF))!;
    await canvas.save(loaded);
    store.emit({ type: 'moving' });
    store.emit({ type: 'moved' });
    await canvas.dispose();
    expect(kept).toEqual([]);
    expect(hasUnsavedChanges()).toBe(false);
  });

  it('a move that fails leaves the change saved where it was', async () => {
    const browser = new MemoryFileStore();
    await browser.write(PATH, JSON.stringify(drawing(['a'])));
    const store = folderLike(browser);
    const canvas = createFileSceneStore({ store, path: PATH, scope: 'r3-failed', intervalMs: 10 });
    const loaded = (await canvas.load(REF))!;
    await canvas.save(loaded);
    store.emit({ type: 'moving' });
    await canvas.save({ ...loaded, scene: drawing(['a', 'b']) } as unknown as NebulaExcalidrawDocument);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(idsOf(await browser.readText(PATH))).toEqual(['a']);
    store.emit({ type: 'move-failed' });
    await until(async () => idsOf(await browser.readText(PATH)).length === 2);
    await canvas.dispose();
    expect(kept).toEqual([]);
  });
});
