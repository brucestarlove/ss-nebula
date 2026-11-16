import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import {
  isObsidianExcalidrawMarkdown,
  readObsidianExcalidrawMarkdown,
  toObsidianExcalidrawMarkdown,
} from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import type { FileStore } from '../../../files/types';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { slowWrites } from '../testing/slowWrites';
import { scopedStore } from '../../../files/scopedStore';
import zipcode from '../../../files/fixtures/obsidian/Edraw - Bus timetable.md?raw';
import { createFileSceneStore, serialize, type FileSceneStore } from './fileSceneStore';

const REF = { boardId: 'night-sky', canvasId: 'Sketches/Winter hexagon.excalidraw.md' };

function element(id: string, patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike {
  return {
    id,
    type: 'rectangle',
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    angle: 0,
    version: 1,
    versionNonce: 1,
    isDeleted: false,
    ...patch,
  };
}

const IMAGE_FILE = {
  mimeType: 'image/png',
  id: 'file-1',
  dataURL: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  created: 1,
};

function scene(elements: ExcalidrawElementLike[], files: Record<string, unknown> = {}): ExcalidrawScene {
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: 'transparent' }, files };
}

function documentWith(loaded: NebulaExcalidrawDocument, next: ExcalidrawScene): NebulaExcalidrawDocument {
  return { ...loaded, updatedAt: new Date().toISOString(), scene: next };
}

describe('file scene store', () => {
  let files: MemoryFileStore;
  const open: FileSceneStore[] = [];

  function storeFor(path: string, data: string, options: { intervalMs?: number } = {}) {
    files = createMemoryFileStore({ [path]: data });
    const sceneStore = createFileSceneStore({ store: files, path, ...options });
    open.push(sceneStore);
    return sceneStore;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    for (const sceneStore of open.splice(0)) await sceneStore.dispose();
    vi.useRealTimers();
  });

  describe('reading', () => {
    it('reads a compressed .excalidraw.md drawing, with its embedded files', async () => {
      const markdown = toObsidianExcalidrawMarkdown(scene([element('a'), element('b')], { 'file-1': IMAGE_FILE }), { compressed: true });
      const sceneStore = storeFor(REF.canvasId, markdown);
      const loaded = await sceneStore.load(REF);
      expect(loaded?.scene.elements.map((item) => item.id)).toEqual(['a', 'b']);
      expect(loaded?.scene.files).toEqual({ 'file-1': IMAGE_FILE });
      expect(loaded).toMatchObject({ boardId: 'night-sky', canvasId: REF.canvasId, name: 'Winter hexagon', type: 'starscape.nebula.excalidraw' });
    });

    it('reads plain .excalidraw JSON', async () => {
      const sceneStore = storeFor('Sketches/Scope.excalidraw', JSON.stringify(scene([element('json')])));
      const loaded = await sceneStore.load({ ...REF, canvasId: 'Sketches/Scope.excalidraw' });
      expect(loaded?.scene.elements.map((item) => item.id)).toEqual(['json']);
      expect(loaded?.name).toBe('Scope');
    });

    it('reads a plain .md drawing written by Obsidian', async () => {
      const markdown = toObsidianExcalidrawMarkdown(scene([element('obsidian')]), { compressed: false });
      const sceneStore = storeFor('Edraw - Plan.md', markdown);
      const loaded = await sceneStore.load({ ...REF, canvasId: 'Edraw - Plan.md' });
      expect(loaded?.scene.elements.map((item) => item.id)).toEqual(['obsidian']);
    });

    it('opens an empty file as an empty canvas', async () => {
      const sceneStore = storeFor('Sketches/New.excalidraw.md', '  \n');
      const loaded = await sceneStore.load(REF);
      expect(loaded?.scene.elements).toEqual([]);
      expect(sceneStore.getState().elementCount).toBe(0);
    });

    it('refuses a file it cannot parse, and never writes over it', async () => {
      const sceneStore = storeFor('Sketches/Broken.excalidraw', '{ not json');
      await expect(sceneStore.load(REF)).rejects.toThrow();
      await sceneStore.save(documentWith({} as NebulaExcalidrawDocument, scene([element('x')])));
      await sceneStore.save(documentWith({} as NebulaExcalidrawDocument, scene([element('y')])));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(0);
    });
  });

  describe('saving', () => {
    async function loadedStore(path = REF.canvasId, intervalMs?: number) {
      const sceneStore = storeFor(path, toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }), { intervalMs });
      const loaded = (await sceneStore.load(REF))!;
      // Excalidraw's first onChange carries the scene as it opened.
      await sceneStore.save(loaded);
      return { sceneStore, loaded };
    }

    it('keeps where the view was when it takes a drawing from elsewhere', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, scrollX: 120, scrollY: -40, zoom: { value: 1.5 } } }));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(0);
      await files.write(REF.canvasId, toObsidianExcalidrawMarkdown(scene([element('a', { version: 9 }), element('theirs')]), { compressed: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState().revision).toBe(1);
      const reloaded = (await sceneStore.load(REF))!;
      expect(reloaded.scene.elements.map((item) => item.id)).toEqual(['a', 'theirs']);
      expect(reloaded.scene.appState).toMatchObject({ scrollX: 120, scrollY: -40, zoom: { value: 1.5 } });
    });

    it('never writes just because the canvas opened', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { scrollX: 300, zoom: { value: 2 } } }));
      await vi.advanceTimersByTimeAsync(2000);
      await sceneStore.flush();
      expect(files.writes).toHaveLength(0);
      expect(sceneStore.getState().pending).toBe(false);
    });

    it('coalesces a burst of changes into one write of the latest scene, 400 ms on', async () => {
      const { sceneStore, loaded } = await loadedStore();
      for (let version = 2; version <= 6; version += 1) {
        await sceneStore.save(documentWith(loaded, scene([element('a', { version, x: version * 10 })])));
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(files.writes).toHaveLength(0);
      expect(sceneStore.getState().pending).toBe(true);

      await vi.advanceTimersByTimeAsync(200);
      expect(files.writes).toHaveLength(1);
      const written = readObsidianExcalidrawMarkdown(String(files.writes[0].data));
      expect(written.elements[0]).toMatchObject({ id: 'a', x: 60, version: 6 });
      expect(sceneStore.getState().pending).toBe(false);
    });

    it('writes at most once per 400 ms while drawing goes on', async () => {
      const { sceneStore, loaded } = await loadedStore();
      for (let step = 1; step <= 24; step += 1) {
        await sceneStore.save(documentWith(loaded, scene([element('a', { version: step + 1, x: step })])));
        await vi.advanceTimersByTimeAsync(50);
      }
      expect(files.writes.length).toBeGreaterThanOrEqual(2);
      expect(files.writes.length).toBeLessThanOrEqual(3);
      await sceneStore.flush();
      const last = readObsidianExcalidrawMarkdown(String(files.writes.at(-1)?.data));
      expect(last.elements[0]).toMatchObject({ x: 24 });
    });

    it('flushes a pending change at once', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('b')])));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1000);
      expect(files.writes).toHaveLength(1);
    });

    it('flushes when disposed', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.dispose();
      expect(files.writes).toHaveLength(1);
    });

    it('reports pending saves and the count of elements left on the canvas', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const states: Array<{ pending: boolean; elementCount: number | null }> = [];
      sceneStore.subscribe(() => states.push({ ...sceneStore.getState() }));
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('b'), element('c', { isDeleted: true })])));
      await vi.advanceTimersByTimeAsync(400);
      expect(states.at(0)).toMatchObject({ pending: true, elementCount: 2 });
      expect(states.at(-1)).toMatchObject({ pending: false, elementCount: 2 });
    });

    it('stays quiet while Excalidraw repeats itself', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const drawn = documentWith(loaded, scene([element('a', { version: 2 })]));
      await sceneStore.save(drawn);
      const listener = vi.fn();
      sceneStore.subscribe(listener);
      // onChange fires on every pointer move, with the same elements.
      for (let move = 0; move < 10; move += 1) await sceneStore.save(drawn);
      expect(listener).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(400);
      expect(listener).toHaveBeenCalledTimes(1);
      expect(files.writes).toHaveLength(1);
    });

    it('writes a change to the grid, which the file keeps', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, gridModeEnabled: true, gridSize: 20 } }));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(1);
      expect(readObsidianExcalidrawMarkdown(String(files.writes[0].data)).appState).toMatchObject({ gridModeEnabled: true, gridSize: 20 });
    });

    it('writes a change to the grid step and the canvas colour of an .excalidraw file', async () => {
      const { sceneStore, loaded } = await (async () => {
        const created = storeFor('Sketches/Grid.excalidraw', JSON.stringify(scene([element('a')])));
        const opened = (await created.load(REF))!;
        await created.save(opened);
        return { sceneStore: created, loaded: opened };
      })();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, gridStep: 10 } }));
      await sceneStore.flush();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, gridStep: 10, viewBackgroundColor: '#fdf6e3' } }));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(2);
      expect(JSON.parse(String(files.writes[1].data)).appState).toMatchObject({ gridStep: 10, viewBackgroundColor: '#fdf6e3' });
    });

    it('takes Nebula’s see-through canvas for the white it’s written as: no write', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, viewBackgroundColor: 'transparent' } }));
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { ...loaded.scene.appState, viewBackgroundColor: '#ffffff' } }));
      await sceneStore.flush();
      expect(files.writes).toHaveLength(0);
    });

    it('reports the zoom, without writing for it', async () => {
      const { sceneStore, loaded } = await loadedStore();
      expect(sceneStore.getState().zoom).toBe(1);
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, appState: { zoom: { value: 1.5 } } }));
      expect(sceneStore.getState().zoom).toBe(1.5);
      await sceneStore.flush();
      expect(files.writes).toHaveLength(0);
    });

    it('drops deleted elements and unused files from the file', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const image = element('img', { type: 'image', fileId: 'file-1' });
      await sceneStore.save(
        documentWith(loaded, scene([element('a', { version: 2, isDeleted: true }), image], { 'file-1': IMAGE_FILE, 'file-2': { ...IMAGE_FILE, id: 'file-2' } })),
      );
      await sceneStore.flush();
      const written = readObsidianExcalidrawMarkdown(String(files.writes[0].data));
      expect(written.elements.map((item) => item.id)).toEqual(['img']);
      expect(Object.keys(written.files ?? {})).toEqual(['file-1']);
    });

    it('follows a rename and never writes a deleted canvas back', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await files.rename(REF.canvasId, 'Sketches/Renamed.excalidraw.md');
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.flush();
      expect(files.writes.at(-1)?.path).toBe('Sketches/Renamed.excalidraw.md');

      await files.remove('Sketches/Renamed.excalidraw.md');
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 3 })])));
      await sceneStore.flush();
      expect(files.peek('Sketches/Renamed.excalidraw.md')).toBeUndefined();
    });

    it('follows a rename of its folder: the pending change lands in the new folder, and the old one doesn’t come back', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2, x: 111 })])));
      await files.rename('Sketches', 'Drawings');
      await sceneStore.dispose();
      expect(files.peek(REF.canvasId)).toBeUndefined();
      expect(readObsidianExcalidrawMarkdown(files.peek('Drawings/Winter hexagon.excalidraw.md') ?? '').elements[0]).toMatchObject({ x: 111 });
    });

    it('writes the change again where the canvas is now when it was renamed during the write', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const slow = slowWrites(files);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2, x: 111 })])));
      const flushing = sceneStore.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.waiting).toBe(1);
      await files.rename(REF.canvasId, 'Sketches/Renamed.excalidraw.md');
      // The write lands where it was aimed, at the old path (this store
      // doesn't make a rename wait for writes in flight).
      slow.release();
      await flushing;
      await sceneStore.flush();
      expect(readObsidianExcalidrawMarkdown(files.peek('Sketches/Renamed.excalidraw.md') ?? '').elements[0]).toMatchObject({ x: 111 });
      expect(sceneStore.getState().pending).toBe(false);
    });

    it('a write queued when its folder is deleted is never made', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const slow = slowWrites(files);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      const first = sceneStore.flush();
      await vi.advanceTimersByTimeAsync(0);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 3 })])));
      const second = sceneStore.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(slow.waiting).toBe(1);
      await files.remove('Sketches');
      slow.release();
      await first;
      await second;
      // Neither lands. The write in flight expects the file's text,
      // and the file is gone, so even this store, which would make the folder
      // again, writes nothing.
      expect(files.writes.map((write) => write.path)).toEqual([]);
      // Another tab deleted it, so the queued change is kept:
      // still unsaved, and written as a copy where the file was on dispose.
      expect(sceneStore.getState()).toMatchObject({ removed: true, pending: true });
      await sceneStore.dispose();
      const copy = files.writes.at(-1)!.path;
      expect(copy).toMatch(/^Sketches\/Winter hexagon \(conflict .*\)\.excalidraw\.md$/);
      expect(readObsidianExcalidrawMarkdown(files.peek(copy) ?? '').elements[0]).toMatchObject({ version: 3 });
    });

    it('reopened while its last save is still being written, the canvas opens with that change', async () => {
      const { sceneStore, loaded } = await loadedStore();
      const slow = slowWrites(files);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2, x: 111 })])));
      // CanvasView's cleanup doesn't wait for dispose().
      void sceneStore.dispose();
      const reopened = createFileSceneStore({ store: files, path: REF.canvasId });
      open.push(reopened);
      const loading = reopened.load(REF);
      await vi.advanceTimersByTimeAsync(0);
      slow.release();
      expect((await loading)!.scene.elements[0]).toMatchObject({ x: 111 });

      // Drawing on keeps it.
      const again = (await reopened.load(REF))!;
      await reopened.save(again);
      await reopened.save(documentWith(again, scene([element('a', { version: 3, x: 111 }), element('b')])));
      await reopened.flush();
      expect(readObsidianExcalidrawMarkdown(files.peek(REF.canvasId) ?? '').elements.map(({ id, x }) => ({ id, x }))).toEqual([
        { id: 'a', x: 111 },
        { id: 'b', x: 10 },
      ]);
    });

    it('waits for that save from another store of the same project too, as after switching projects and back', async () => {
      files = createMemoryFileStore({ [REF.canvasId]: toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }) });
      const first = createFileSceneStore({ store: files, path: REF.canvasId, scope: 'night-sky' });
      open.push(first);
      const loaded = (await first.load(REF))!;
      await first.save(loaded);
      const slow = slowWrites(files);
      await first.save(documentWith(loaded, scene([element('a', { version: 2, x: 111 })])));
      void first.dispose();
      // registry.open() hands out a new store object each time.
      const reopened = createFileSceneStore({ store: { ...files }, path: REF.canvasId, scope: 'night-sky' });
      open.push(reopened);
      const loading = reopened.load(REF);
      await vi.advanceTimersByTimeAsync(0);
      slow.release();
      expect((await loading)!.scene.elements[0]).toMatchObject({ x: 111 });
    });
  });

  describe('changes made elsewhere', () => {
    const PATH = REF.canvasId;
    const theirs = () => toObsidianExcalidrawMarkdown(scene([element('a'), element('theirs')]), { compressed: true });

    async function loadedStore() {
      const sceneStore = storeFor(PATH, toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }));
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      return { sceneStore, loaded };
    }

    async function writeElsewhere(text: string) {
      await files.write(PATH, text);
      // The store hears the change, then reads the file back.
      await vi.advanceTimersByTimeAsync(0);
    }

    it('reloads the canvas when nothing here is unsaved', async () => {
      const { sceneStore } = await loadedStore();
      const before = sceneStore.getState().revision;
      await writeElsewhere(theirs());
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: before + 1, elementCount: 2 });
      const reloaded = (await sceneStore.load(REF))!;
      expect(reloaded.scene.elements.map((item) => item.id)).toEqual(['a', 'theirs']);
      // The shell's echo of the reloaded scene writes nothing.
      await sceneStore.save(reloaded);
      await sceneStore.flush();
      expect(files.writes).toHaveLength(1);
    });

    it('doesn’t take its own saves for changes made elsewhere', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: 0 });
    });

    it('ignores a change elsewhere that leaves the drawing as it is here', async () => {
      const { sceneStore } = await loadedStore();
      await writeElsewhere(toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: false }));
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: 0 });
    });

    it('waits for Reload or Keep mine while this canvas has unsaved changes, writing nothing', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('mine')])));
      await writeElsewhere(theirs());
      expect(sceneStore.getState()).toMatchObject({ conflict: true, pending: true, revision: 0 });
      // Drawing on doesn't write over their change either.
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 3 }), element('mine')])));
      await vi.advanceTimersByTimeAsync(2000);
      expect(files.writes).toHaveLength(1);
      expect(readObsidianExcalidrawMarkdown(files.peek(PATH) ?? '').elements.map((item) => item.id)).toEqual(['a', 'theirs']);
    });

    it('Reload takes the file as it is now', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('mine')])));
      await writeElsewhere(theirs());
      await sceneStore.reload();
      expect(sceneStore.getState()).toMatchObject({ conflict: false, pending: false, revision: 1 });
      expect((await sceneStore.load(REF))!.scene.elements.map((item) => item.id)).toEqual(['a', 'theirs']);
      await sceneStore.flush();
      expect(files.writes).toHaveLength(1);
    });

    it('Keep mine writes this canvas over the other change', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('mine')])));
      await writeElsewhere(theirs());
      await sceneStore.keepMine();
      expect(sceneStore.getState()).toMatchObject({ conflict: false, pending: false });
      expect(readObsidianExcalidrawMarkdown(files.peek(PATH) ?? '').elements.map((item) => item.id)).toEqual(['a', 'mine']);
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: 0 });
    });

    it('says when the canvas was deleted elsewhere, and writes nothing more', async () => {
      const { sceneStore, loaded } = await loadedStore();
      await files.remove(PATH);
      expect(sceneStore.getState().removed).toBe(true);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.flush();
      expect(files.peek(PATH)).toBeUndefined();
      expect(sceneStore.getState().pending).toBe(false);
    });
  });

  describe('two tabs on one canvas', () => {
    const PATH = REF.canvasId;
    const drawing = (ids: string[]) => toObsidianExcalidrawMarkdown(scene(ids.map((id) => element(id))), { compressed: true });
    const idsIn = (text: string | undefined) => readObsidianExcalidrawMarkdown(text ?? '').elements.map((item) => item.id);

    /** This tab's view of the files: what other tabs do reaches its watchers
     * only when deliver() is called, as a BroadcastChannel message would. */
    function lateEvents(target: MemoryFileStore) {
      let holding = false;
      const held: Array<() => void> = [];
      const store: FileStore = {
        ...target,
        watch: (listener) =>
          target.watch((change) => {
            if (holding) held.push(() => listener(change));
            else listener(change);
          }),
      };
      return {
        store,
        hold() {
          holding = true;
        },
        deliver() {
          holding = false;
          for (const run of held.splice(0)) run();
        },
      };
    }

    async function openTab(target: FileStore) {
      const sceneStore = createFileSceneStore({ store: target, path: PATH });
      open.push(sceneStore);
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      return { sceneStore, loaded };
    }

    it('doesn’t write over another tab’s save it hasn’t heard about yet: it asks first', async () => {
      files = createMemoryFileStore({ [PATH]: drawing(['a']) });
      const late = lateEvents(files);
      const { sceneStore, loaded } = await openTab(late.store);
      late.hold();
      // The other tab saves; its message hasn't arrived yet.
      await files.write(PATH, drawing(['a', 'theirs']));
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 }), element('mine')])));
      await sceneStore.flush();
      expect(idsIn(files.peek(PATH))).toEqual(['a', 'theirs']);
      expect(sceneStore.getState()).toMatchObject({ conflict: true, pending: true });

      late.deliver();
      await vi.advanceTimersByTimeAsync(0);
      await sceneStore.keepMine();
      expect(idsIn(files.peek(PATH))).toEqual(['a', 'mine']);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, pending: false });
    });

    it('takes the other tab’s save when nothing here is unsaved, and keeps drawing on top of it', async () => {
      files = createMemoryFileStore({ [PATH]: drawing(['a']) });
      const { sceneStore: tabA } = await openTab(files);
      const { sceneStore: tabB, loaded: inB } = await openTab({ ...files });
      await tabB.save(documentWith(inB, scene([element('a', { version: 2 }), element('b')])));
      await tabB.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(tabA.getState()).toMatchObject({ conflict: false, revision: 1, elementCount: 2 });
      const reloaded = (await tabA.load(REF))!;
      await tabA.save(reloaded);
      await tabA.save(documentWith(reloaded, { ...reloaded.scene, elements: [...reloaded.scene.elements, element('c')] }));
      await tabA.flush();
      expect(idsIn(files.peek(PATH))).toEqual(['a', 'b', 'c']);
    });

    it('a deleted file it hasn’t heard about yet isn’t written back', async () => {
      files = createMemoryFileStore({ [PATH]: drawing(['a']) });
      const late = lateEvents(files);
      const { sceneStore, loaded } = await openTab(late.store);
      late.hold();
      await files.remove(PATH);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.flush();
      expect(files.peek(PATH)).toBeUndefined();
      late.deliver();
      // The change is kept for a copy where the file was.
      expect(sceneStore.getState()).toMatchObject({ removed: true, pending: true });
      await sceneStore.dispose();
      expect(files.peek(PATH)).toBeUndefined();
      expect((await files.list()).filter((entry) => entry.name.includes('(conflict '))).toHaveLength(1);
    });
  });

  describe('the writer', () => {
    it('is handed the file as it is now: as opened, then as last written, then as changed elsewhere', async () => {
      const opened = toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true });
      files = createMemoryFileStore({ [REF.canvasId]: opened });
      const originals: Array<string | null> = [];
      const sceneStore = createFileSceneStore({
        store: files,
        path: REF.canvasId,
        serialize(original, next) {
          originals.push(original);
          return serialize(original, next);
        },
      });
      open.push(sceneStore);
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await sceneStore.flush();
      const first = files.peek(REF.canvasId);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 3 })])));
      await sceneStore.flush();
      const elsewhere = toObsidianExcalidrawMarkdown(scene([element('a', { version: 9 }), element('theirs')]), { compressed: true });
      await files.write(REF.canvasId, elsewhere);
      await vi.advanceTimersByTimeAsync(0);
      const reloaded = (await sceneStore.load(REF))!;
      await sceneStore.save(reloaded);
      await sceneStore.save(documentWith(reloaded, { ...reloaded.scene, elements: [...reloaded.scene.elements, element('mine')] }));
      await sceneStore.flush();
      expect(originals).toEqual([opened, first, elsewhere]);
    });

    it('writes markdown by default, and Excalidraw’s JSON when asked', () => {
      const drawn = scene([element('a')]);
      expect(readObsidianExcalidrawMarkdown(serialize(null, drawn)).elements.map((item) => item.id)).toEqual(['a']);
      expect(JSON.parse(serialize(null, drawn, 'json'))).toMatchObject({ type: 'excalidraw', elements: [{ id: 'a' }] });
    });
  });

  describe('round trips', () => {
    async function roundTrip(path: string, initial: string) {
      const sceneStore = storeFor(path, initial);
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      const image = element('img', { type: 'image', fileId: 'file-1', x: 200, version: 4 });
      const drawn = scene([element('rect', { version: 7, x: 42, y: 24 }), image], { 'file-1': IMAGE_FILE });
      await sceneStore.save(documentWith(loaded, drawn));
      await sceneStore.flush();

      const reopened = createFileSceneStore({ store: files, path });
      open.push(reopened);
      return { written: files.peek(path) ?? '', reloaded: (await reopened.load(REF))! };
    }

    it('round-trips elements and embedded images through .excalidraw.md, compressed', async () => {
      const { written, reloaded } = await roundTrip('Sketches/Trip.excalidraw.md', '');
      expect(isObsidianExcalidrawMarkdown(written)).toBe(true);
      expect(written).toContain('```compressed-json');
      expect(reloaded.scene.elements.map(({ id, type, x }) => ({ id, type, x }))).toEqual([
        { id: 'rect', type: 'rectangle', x: 42 },
        { id: 'img', type: 'image', x: 200 },
      ]);
      expect(reloaded.scene.files).toEqual({ 'file-1': IMAGE_FILE });
    });

    it('round-trips elements and embedded images through .excalidraw JSON', async () => {
      const { written, reloaded } = await roundTrip('Sketches/Trip.excalidraw', '');
      const json = JSON.parse(written);
      expect(json).toMatchObject({ type: 'excalidraw', version: 2 });
      expect(json.appState.viewBackgroundColor).toBe('#ffffff');
      expect(reloaded.scene.elements.map((item) => item.id)).toEqual(['rect', 'img']);
      expect(reloaded.scene.files).toEqual({ 'file-1': IMAGE_FILE });
    });

    it('writes a plain .md canvas back in the Obsidian format, in the encoding it had', async () => {
      const { written, reloaded } = await roundTrip('Edraw - Plan.md', toObsidianExcalidrawMarkdown(scene([element('old')]), { compressed: false }));
      expect(written).toContain('excalidraw-plugin: parsed');
      // The plugin's own setting chose plain JSON; a save keeps it.
      expect(written).toContain('```json');
      expect(written).not.toContain('```compressed-json');
      expect(reloaded.scene.elements.map((item) => item.id)).toEqual(['rect', 'img']);
    });

    it('keeps everything in an Obsidian drawing that isn’t the drawing', async () => {
      const extras = zipcode
        .replace('tags: [excalidraw]', 'tags: [excalidraw]\naliases: [Zip plan]\nexcalidraw-autoexport: png')
        .replace('# Excalidraw Data', 'Back of the card: call the post office first.\n\n# Excalidraw Data')
        .replace('%%\n## Drawing', '## Element Links\nrect: [[Zip codes]]\n\n## Embedded Files\nfile-9: [[map.png]]\n\n%%\n## Drawing');
      expect(extras).toContain('## Element Links');
      const { written, reloaded } = await roundTrip('Edraw - Zip plan.md', extras);
      for (const kept of ['aliases: [Zip plan]', 'excalidraw-autoexport: png', 'Back of the card: call the post office first.', '## Element Links\nrect: [[Zip codes]]', '## Embedded Files\nfile-9: [[map.png]]']) {
        expect(written).toContain(kept);
      }
      expect(reloaded.scene.elements.map((item) => item.id)).toEqual(['rect', 'img']);
    });

    it('writes nothing more once its whole project folder is removed', async () => {
      const path = 'Sketches/Trip.excalidraw.md';
      const tree = createMemoryFileStore({ [`projects/p1/${path}`]: toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }) });
      const sceneStore = createFileSceneStore({ store: scopedStore(tree, 'projects/p1'), path });
      open.push(sceneStore);
      const loaded = (await sceneStore.load({ ...REF, canvasId: path }))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2 })])));
      await tree.remove('projects/p1');
      await vi.advanceTimersByTimeAsync(0);
      await sceneStore.flush();
      expect(tree.peek(`projects/p1/${path}`)).toBeUndefined();
      expect(sceneStore.getState()).toMatchObject({ removed: true });
    });
  });
});

describe('drawings that hold images (Bruce, 2026-10-25: "too many images")', () => {
  const photo = (id: string, kb: number) => ({ mimeType: 'image/jpeg', id, dataURL: `data:image/jpeg;base64,${'Q'.repeat(kb * 1024)}`, created: 1 });
  const holding = (kb: number) => scene([element('pic', { type: 'image', fileId: 'img-1' } as Partial<ExcalidrawElementLike>)], { 'img-1': photo('img-1', kb) });

  it('are written as plain JSON once their images pass 256 KB: LZ can’t shrink image data, and took seconds each save', () => {
    const text = serialize('', holding(300));
    expect(text).toContain('```json\n');
    expect(text).not.toContain('```compressed-json');
    const back = readObsidianExcalidrawMarkdown(text);
    expect(back.elements.map((item) => item.id)).toEqual(['pic']);
    expect((back.files as Record<string, { dataURL: string }>)['img-1'].dataURL).toBe(photo('img-1', 300).dataURL);
  });

  it('switch a compressed drawing to plain JSON when a large image arrives', () => {
    const compressed = serialize('', scene([element('a')]));
    expect(compressed).toContain('```compressed-json');
    expect(serialize(compressed, holding(300))).toContain('```json\n');
  });

  it('stay compressed while their images are small', () => {
    const compressed = serialize('', scene([element('a')]));
    const text = serialize(compressed, holding(4));
    expect(text).toContain('```compressed-json');
  });
});
