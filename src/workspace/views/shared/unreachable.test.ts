/**
 * A folder Nebula can't reach keeps every session's work. `unreachable` (a folder moved, a drive unplugged, permission taken
 * back, or a false alarm) is not the project removed: edits stay unsaved
 * and marked so, saves wait, and on `reachable` they're saved through the
 * normal ifUnchanged path. A session closed meanwhile keeps its edit the
 * way a failed save does: a download, and the page still warns.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChangeListeners } from '../../../files/listeners';
import { MemoryFileStore } from '../../../files/memoryStore';
import type { FileChange, FileStore } from '../../../files/types';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from './fileSessions';
import { createTextSession } from './textSession';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';

/** `disk` behind a store whose watchers the test talks to, as the folder
 * store's do. */
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

/** Real time from here: a memory store's blob reads don't run on fake timers. */
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
  vi.useFakeTimers();
  kept = [];
  unsubscribe = subscribeKeptCopies((copy) => kept.push(copy));
});
afterEach(() => {
  unsubscribe();
  for (const copy of kept) if (copy.copy === null) copy.release();
  vi.useRealTimers();
});

describe('S2: a text session while its folder is out of reach', () => {
  it('keeps the edit unsaved, saves nothing, says so, and saves it once the folder is back', async () => {
    const disk = new MemoryFileStore();
    await disk.write('note.md', 'saved');
    const store = folderLike(disk);
    const session = createTextSession(store, 'note.md', { scope: 's2-back' });
    await session.ready;
    session.edit('saved plus the paragraph I just typed');
    store.emit({ type: 'unreachable', folder: 'Notes' });
    session.edit('saved plus the paragraph I just typed, and more');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await disk.readText('note.md')).toBe('saved');
    expect(session.getState()).toMatchObject({ removed: false, dirty: true, unreachable: 'Notes' });
    expect(hasUnsavedChanges()).toBe(true);

    store.emit({ type: 'reachable' });
    await until(async () => (await disk.readText('note.md')) !== 'saved');
    expect(await disk.readText('note.md')).toBe('saved plus the paragraph I just typed, and more');
    expect(session.getState()).toMatchObject({ dirty: false, unreachable: null, conflict: false });
    await session.dispose();
    expect(kept).toEqual([]);
  });

  it('a file changed on disk meanwhile comes back as a conflict, never written over', async () => {
    const disk = new MemoryFileStore();
    await disk.write('note.md', 'saved');
    const store = folderLike(disk);
    const session = createTextSession(store, 'note.md', { scope: 's2-conflict' });
    await session.ready;
    store.emit({ type: 'unreachable', folder: 'Notes' });
    session.edit('mine');
    await vi.advanceTimersByTimeAsync(1000);
    await disk.write('note.md', 'changed on the other laptop');
    store.emit({ type: 'reachable' });
    await until(() => session.getState().conflict);
    expect(await disk.readText('note.md')).toBe('changed on the other laptop');
    expect(session.getState()).toMatchObject({ conflict: true, dirty: true });
    await session.dispose();
  });

  it('closed while the folder is out of reach, the edit is kept as a download and the page still warns', async () => {
    const disk = new MemoryFileStore();
    await disk.write('note.md', 'saved');
    const store = folderLike(disk);
    const session = createTextSession(store, 'note.md', { scope: 's2-closed' });
    await session.ready;
    session.edit('the paragraph I just typed');
    store.emit({ type: 'unreachable', folder: 'Notes' });
    await session.dispose();
    expect(await disk.readText('note.md')).toBe('saved');
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: 'note.md', copy: null, failedSave: true, download: { filename: 'note.md', text: 'the paragraph I just typed' } });
    expect(String((kept[0] as { error: unknown }).error)).toContain('Nebula can’t reach the folder ‘Notes’');
    expect(hasUnsavedChanges()).toBe(true);
    if (kept[0].copy === null) kept[0].release();
    expect(hasUnsavedChanges()).toBe(false);
    kept = [];
  });
});

describe('S2: a canvas while its folder is out of reach', () => {
  const PATH = 'Sketch.excalidraw';
  const REF = { boardId: 'p', canvasId: PATH };
  const drawing = (ids: string[]) => ({
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: ids.map((id) => ({ id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1, isDeleted: false })),
    appState: { viewBackgroundColor: 'transparent' },
    files: {},
  });
  const ids = async (disk: MemoryFileStore) => (JSON.parse(await disk.readText(PATH)) as { elements: Array<{ id: string }> }).elements.map((item) => item.id);

  async function opened(scope: string) {
    const disk = new MemoryFileStore();
    await disk.write(PATH, JSON.stringify(drawing(['a'])));
    const store = folderLike(disk);
    const canvas = createFileSceneStore({ store, path: PATH, scope, intervalMs: 10 });
    const loaded = (await canvas.load(REF))!;
    await canvas.save(loaded);
    const draw = (next: string[]) => canvas.save({ ...loaded, scene: drawing(next) } as unknown as NebulaExcalidrawDocument);
    return { disk, store, canvas, draw };
  }

  it('keeps the drawing pending, writes nothing, and writes it once the folder is back', async () => {
    const { disk, store, canvas, draw } = await opened('s2-canvas-back');
    store.emit({ type: 'unreachable', folder: 'Notes' });
    await draw(['a', 'b']);
    await vi.advanceTimersByTimeAsync(2000);
    await canvas.flush();
    expect(await ids(disk)).toEqual(['a']);
    expect(canvas.getState()).toMatchObject({ pending: true, removed: false, unreachable: 'Notes' });
    store.emit({ type: 'reachable' });
    await until(async () => (await ids(disk)).length === 2);
    expect(await ids(disk)).toEqual(['a', 'b']);
    expect(canvas.getState()).toMatchObject({ pending: false, unreachable: null });
    await canvas.dispose();
    expect(kept).toEqual([]);
  });

  it('closed while the folder is out of reach, the drawing is kept as a download', async () => {
    const { disk, store, canvas, draw } = await opened('s2-canvas-closed');
    store.emit({ type: 'unreachable', folder: 'Notes' });
    await draw(['a', 'c']);
    await canvas.dispose();
    expect(await ids(disk)).toEqual(['a']);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: PATH, copy: null, failedSave: true, download: { filename: PATH } });
    expect(hasUnsavedChanges()).toBe(true);
  });
});

describe('S3: a text session while another tab moves its project to a folder', () => {
  it('pauses on moving, and saves as ever on move-failed', async () => {
    const disk = new MemoryFileStore();
    await disk.write('note.md', 'saved');
    const store = folderLike(disk);
    const session = createTextSession(store, 'note.md', { scope: 's3-failed' });
    await session.ready;
    store.emit({ type: 'moving' });
    session.edit('typed while it moved');
    await vi.advanceTimersByTimeAsync(5000);
    expect(await disk.readText('note.md')).toBe('saved');
    expect(session.getState()).toMatchObject({ dirty: true, moving: true });
    store.emit({ type: 'move-failed' });
    await until(async () => (await disk.readText('note.md')) !== 'saved');
    expect(await disk.readText('note.md')).toBe('typed while it moved');
    expect(session.getState()).toMatchObject({ dirty: false, moving: false });
    await session.dispose();
  });

  it('on moved, the edit goes with the project: the session opened on the folder saves it through ifUnchanged', async () => {
    const browser = new MemoryFileStore();
    await browser.write('note.md', 'saved');
    const store = folderLike(browser);
    const session = createTextSession(store, 'note.md', { scope: 's3-moved' });
    await session.ready;
    store.emit({ type: 'moving' });
    session.edit('typed while it moved');
    store.emit({ type: 'moved' });
    // The workspace reopens the project from the folder: this view goes...
    await session.dispose();
    expect(kept).toEqual([]);
    expect(hasUnsavedChanges()).toBe(true);
    // ...and the folder's view of the file opens, over the same bytes.
    const folder = new MemoryFileStore();
    await folder.write('note.md', 'saved');
    vi.useRealTimers();
    const reopened = createTextSession(folder, 'note.md', { scope: 's3-moved' });
    await reopened.ready;
    expect(reopened.getState()).toMatchObject({ text: 'typed while it moved', dirty: true });
    await until(async () => (await folder.readText('note.md')) !== 'saved');
    expect(await folder.readText('note.md')).toBe('typed while it moved');
    await until(() => !hasUnsavedChanges());
    await reopened.dispose();
    expect(kept).toEqual([]);
  });

  it('an edit carried by a move that no view takes is offered as a download, never dropped', async () => {
    const browser = new MemoryFileStore();
    await browser.write('note.md', 'saved');
    const store = folderLike(browser);
    const session = createTextSession(store, 'note.md', { scope: 's3-unclaimed' });
    await session.ready;
    store.emit({ type: 'moving' });
    session.edit('typed while it moved');
    store.emit({ type: 'moved' });
    await session.dispose();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ path: 'note.md', copy: null, failedSave: true, download: { filename: 'note.md', text: 'typed while it moved' } });
  });
});
