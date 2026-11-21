import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileStore } from '../../../files/types';
import { embeddedFiles } from '../../../nebula/excalidraw/embeddedFiles';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { blobBytes, pastedImageName } from '../../attachments';
import { moveImagesOut } from '../../moveImagesOut';
import { subscribeKeptCopies, type KeptCopy } from '../shared/fileSessions';
import { canvasHolding, dataURLOf, sceneWith } from '../testing/canvasFixtures';
import { fileIdFor } from './canvasImages';
import { createFileSceneStore, serialize, type FileSceneStore } from './fileSceneStore';

// A canvas's images as files beside it (2.0.4), through the store that reads and writes the canvas:
// what is written before what, what stays inside the drawing, and what an open canvas does when the
// files it names change. Behaviour only: files, bytes, the order of writes, the state the store reports.

const PATH = 'Sketches/Map.excalidraw.md';
const REF = { boardId: 'p', canvasId: PATH };
const SKY = [1, 2, 3, 4];
const MOON = [5, 6, 7];
const blob = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);

const rect = (patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike => ({ id: 'rect', type: 'rectangle', x: 5, y: 5, width: 50, height: 50, angle: 0, version: 1, versionNonce: 1, isDeleted: false, ...patch });
const picture = (id: string, patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike => ({ id: `el-${id}`, type: 'image', fileId: id, x: 0, y: 0, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1, isDeleted: false, ...patch }) as ExcalidrawElementLike;
const fileOf = (id: string, bytes: number[], mimeType = 'image/png') => ({ id, mimeType, dataURL: dataURLOf(bytes, mimeType), created: 1 });
const drawing = (elements: ExcalidrawElementLike[], files: Record<string, unknown> = {}): ExcalidrawScene => ({ type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: 'transparent' }, files });
const documentWith = (loaded: NebulaExcalidrawDocument, next: ExcalidrawScene): NebulaExcalidrawDocument => ({ ...loaded, updatedAt: new Date().toISOString(), scene: next });

/** A canvas that names its images by reference: lines for these, and an element for each. */
function referencing(lines: Record<string, string>): string {
  const ids = Object.keys(lines);
  const scene = { ...sceneWith(ids.map((id) => ({ id, bytes: [0] }))), files: {} };
  return toObsidianExcalidrawMarkdown(scene, { embedded: { add: Object.entries(lines) } });
}

const attachments = async (store: FileStore) => (await store.list()).filter((entry) => entry.type === 'file' && entry.path.startsWith('Attachments/')).map((entry) => entry.path).sort();
const bytesAt = async (store: FileStore, path: string) => Array.from(await blobBytes(await store.readBlob(path)));
const linesOf = (text: string | undefined) => embeddedFiles(text ?? '').map((line) => [line.id, line.link]);
const filesIn = (text: string | undefined) => Object.keys(readObsidianExcalidrawMarkdown(text ?? '').files ?? {}).sort();

describe('canvas images as files', () => {
  const open: FileSceneStore[] = [];
  let memory: MemoryFileStore;
  /** Every write the canvas's store made, with its options, in order. */
  let log: Array<{ path: string; options: unknown }>;

  function start(initial: Record<string, string | Blob>, { path = PATH, failing }: { path?: string; failing?: (path: string) => boolean } = {}) {
    memory = createMemoryFileStore(initial);
    log = [];
    const store: FileStore = {
      ...memory,
      write: async (target, data, options) => {
        if (failing?.(target)) throw new Error('The disk is full.');
        log.push({ path: target, options });
        return memory.write(target, data, options);
      },
    };
    const sceneStore = createFileSceneStore({ store, path });
    open.push(sceneStore);
    return { store, sceneStore };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 21, 1, 30, 5));
  });

  afterEach(async () => {
    for (const sceneStore of open.splice(0)) await sceneStore.dispose();
    vi.useRealTimers();
  });

  /** Opens the canvas, takes its echo, and saves `next`. */
  async function drawn(sceneStore: FileSceneStore, make: (scene: ExcalidrawScene) => ExcalidrawScene) {
    const loaded = (await sceneStore.load(REF))!;
    await sceneStore.save(loaded);
    await sceneStore.save(documentWith(loaded, make(loaded.scene)));
    await sceneStore.flush();
    return loaded;
  }

  describe('an image added to a canvas', () => {
    it('is written as Attachments/Pasted image <time>.png, create-only, before the canvas that names it', async () => {
      const { sceneStore } = start({ [PATH]: '' });
      await drawn(sceneStore, () => drawing([rect(), picture('new1')], { new1: fileOf('new1', SKY) }));
      const name = pastedImageName(new Date(2026, 10, 21, 1, 30, 5), 'png');
      expect(name).toBe('Pasted image 20261121013005.png');
      expect(await bytesAt(memory, `Attachments/${name}`)).toEqual(SKY);
      // The image, then the canvas: the canvas never names a file that isn't there.
      expect(log.map((entry) => entry.path)).toEqual([`Attachments/${name}`, PATH]);
      expect(log[0].options).toEqual({ exclusive: true });
      const text = memory.peek(PATH)!;
      expect(linesOf(text)).toEqual([['new1', name]]);
      expect(filesIn(text)).toEqual([]);
      expect(readObsidianExcalidrawMarkdown(text).elements.map((element) => element.id)).toEqual(['rect', 'el-new1']);
    });

    it('is not written again by a later save of the same canvas', async () => {
      const { sceneStore } = start({ [PATH]: '' });
      const loaded = await drawn(sceneStore, () => drawing([rect(), picture('new1')], { new1: fileOf('new1', SKY) }));
      const before = (await attachments(memory)).length;
      await sceneStore.save(documentWith(loaded, drawing([rect({ x: 99, version: 2 }), picture('new1')], { new1: fileOf('new1', SKY) })));
      await sceneStore.flush();
      expect(await attachments(memory)).toHaveLength(before);
      expect(log.filter((entry) => entry.path.startsWith('Attachments/'))).toHaveLength(1);
      expect(readObsidianExcalidrawMarkdown(memory.peek(PATH)!).elements[0].x).toBe(99);
      expect(linesOf(memory.peek(PATH))).toHaveLength(1);
    });

    it('keeps a dropped file’s own name, made safe, and a free name when it is taken, never writing over the file there', async () => {
      const { sceneStore } = start({ [PATH]: '', 'Attachments/Sky 1.png': blob(MOON) });
      const id = await fileIdFor(new File([new Uint8Array(SKY)], 'Sky #1.png', { type: 'image/png' }));
      await drawn(sceneStore, () => drawing([rect(), picture(id)], { [id]: fileOf(id, SKY) }));
      // `#` would break the `[[ ]]`: it becomes `_`. `Sky _1.png` is free, so it is the name.
      expect(await attachments(memory)).toEqual(['Attachments/Sky 1.png', 'Attachments/Sky _1.png']);
      expect(await bytesAt(memory, 'Attachments/Sky 1.png')).toEqual(MOON);
      expect(linesOf(memory.peek(PATH))).toEqual([[id, 'Sky _1.png']]);

      // Another canvas drops a different picture of the same name: the next free name, and the first file stays.
      const second = start({ [PATH]: '', 'Attachments/Sky.png': blob(MOON) });
      const id2 = await fileIdFor(new File([new Uint8Array(SKY)], 'Sky.png', { type: 'image/png' }));
      await drawn(second.sceneStore, () => drawing([rect(), picture(id2)], { [id2]: fileOf(id2, SKY) }));
      expect(await bytesAt(memory, 'Attachments/Sky.png')).toEqual(MOON);
      expect(await bytesAt(memory, 'Attachments/Sky 2.png')).toEqual(SKY);
      expect(linesOf(memory.peek(PATH))).toEqual([[id2, 'Sky 2.png']]);
    });

    it('writes no file for a picture whose element was deleted before the save', async () => {
      const { sceneStore } = start({ [PATH]: '' });
      await drawn(sceneStore, () => drawing([rect(), picture('new1', { isDeleted: true })], { new1: fileOf('new1', SKY) }));
      expect(await attachments(memory)).toEqual([]);
      expect(linesOf(memory.peek(PATH))).toEqual([]);
    });

    it('is named by its real type: a jpeg is a .jpg whatever it was called', async () => {
      const { sceneStore } = start({ [PATH]: '' });
      const id = await fileIdFor(new File([new Uint8Array(SKY)], 'Photo.png', { type: 'image/jpeg' }));
      await drawn(sceneStore, () => drawing([rect(), picture(id)], { [id]: fileOf(id, SKY, 'image/jpeg') }));
      expect(await attachments(memory)).toEqual(['Attachments/Photo.jpg']);
    });

    it('stays inside the drawing when its file can’t be written, and the next save writes the file and swaps it for a line', async () => {
      let broken = true;
      const { sceneStore } = start({ [PATH]: '' }, { failing: (path) => broken && path.startsWith('Attachments/') });
      const loaded = await drawn(sceneStore, () => drawing([rect(), picture('new1')], { new1: fileOf('new1', SKY) }));
      // Nothing lost: the picture is in the file, inside it.
      expect(filesIn(memory.peek(PATH))).toEqual(['new1']);
      expect(readObsidianExcalidrawMarkdown(memory.peek(PATH)!).files?.new1).toMatchObject({ dataURL: dataURLOf(SKY) });
      expect(linesOf(memory.peek(PATH))).toEqual([]);
      expect(await attachments(memory)).toEqual([]);

      broken = false;
      await sceneStore.save(documentWith(loaded, drawing([rect({ x: 50, version: 2 }), picture('new1')], { new1: fileOf('new1', SKY) })));
      await sceneStore.flush();
      expect(await attachments(memory)).toHaveLength(1);
      expect(filesIn(memory.peek(PATH))).toEqual([]);
      expect(linesOf(memory.peek(PATH)).map(([id]) => id)).toEqual(['new1']);
    });

    it('goes inside a plain .excalidraw canvas, which has no such section, and writes no file', async () => {
      const path = 'Sketches/Old.excalidraw';
      const { sceneStore } = start({ [path]: '' }, { path });
      const loaded = (await sceneStore.load({ ...REF, canvasId: path }))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, drawing([rect(), picture('new1')], { new1: fileOf('new1', SKY) })));
      await sceneStore.flush();
      expect(await attachments(memory)).toEqual([]);
      const json = JSON.parse(memory.peek(path)!);
      expect(json.files.new1.dataURL).toBe(dataURLOf(SKY));
    });

    it('stays inside when the drawing held it inside as it opened, through every save', async () => {
      const { sceneStore } = start({ [PATH]: canvasHolding([{ id: 'old', bytes: SKY, created: 1 }]) });
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 77, version: 2 } : element)) }));
      await sceneStore.flush();
      expect(readObsidianExcalidrawMarkdown(memory.peek(PATH)!).elements.find((element) => element.id === 'rect')?.x).toBe(77);
      expect(filesIn(memory.peek(PATH))).toEqual(['old']);
      expect(linesOf(memory.peek(PATH))).toEqual([]);
      expect(await attachments(memory)).toEqual([]);
    });
  });

  describe('a canvas that names its images as files', () => {
    const TEXT = () => referencing({ s: 'Sky.png' });
    const initial = () => ({ [PATH]: TEXT(), 'Attachments/Sky.png': blob(SKY) });

    it('opens with each image read from its file, for Excalidraw to draw', async () => {
      const { sceneStore } = start(initial());
      const loaded = (await sceneStore.load(REF))!;
      expect(loaded.scene.files?.s).toMatchObject({ id: 's', mimeType: 'image/png', dataURL: dataURLOf(SKY) });
      // Opening writes nothing.
      await sceneStore.save(loaded);
      await sceneStore.flush();
      expect(log).toEqual([]);
    });

    it('keeps the line of an image whose file is missing, or isn’t an image, through a save', async () => {
      const lines = { gone: 'Missing.png', note: 'Orion', s: 'Sky.png' };
      const { sceneStore } = start({ [PATH]: referencing(lines), 'Attachments/Sky.png': blob(SKY), 'Notes/Orion.md': 'a note' });
      const loaded = await drawn(sceneStore, (scene) => ({ ...scene, elements: scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 40, version: 2 } : element)) }));
      expect(Object.keys(loaded.scene.files ?? {})).toEqual(['s']);
      expect(linesOf(memory.peek(PATH))).toEqual([['gone', 'Missing.png'], ['note', 'Orion'], ['s', 'Sky.png']]);
      expect(readObsidianExcalidrawMarkdown(memory.peek(PATH)!).elements.map((element) => element.id)).toEqual(['rect', 'el-gone', 'el-note', 'el-s']);
      expect(filesIn(memory.peek(PATH))).toEqual([]);
    });

    it('doesn’t take the same drawing in other bytes for a change made elsewhere, nor its own save', async () => {
      const { sceneStore } = start(initial());
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      const before = sceneStore.getState().revision;
      // The same drawing, written as plain JSON by another app.
      const same = readObsidianExcalidrawMarkdown(TEXT());
      await memory.write(PATH, toObsidianExcalidrawMarkdown(same, { compressed: false, embedded: { add: [['s', 'Sky.png']] } }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: before });
      // And its own save, after a change.
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 41, version: 2 } : element)) }));
      await sceneStore.flush();
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: before });
    });

    it('drops the line of an image whose element was deleted, brings it back on undo, and leaves the file', async () => {
      const { sceneStore } = start(initial());
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      const withElement = (deleted: boolean, version: number) => ({ ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'el-s' ? { ...element, isDeleted: deleted, version } : element)) });
      await sceneStore.save(documentWith(loaded, withElement(true, 2)));
      await sceneStore.flush();
      expect(linesOf(memory.peek(PATH))).toEqual([]);
      expect(await bytesAt(memory, 'Attachments/Sky.png')).toEqual(SKY);
      // Undo: the element is back, and Excalidraw still holds the image's data in memory.
      await sceneStore.save(documentWith(loaded, withElement(false, 3)));
      await sceneStore.flush();
      expect(linesOf(memory.peek(PATH))).toEqual([['s', 'Sky.png']]);
      expect(filesIn(memory.peek(PATH))).toEqual([]);
    });

    it('takes the rewrite of its lines after a rename as its own drawing, with no conflict and no remount, and keeps the new line', async () => {
      const { sceneStore } = start(initial());
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      const before = sceneStore.getState().revision;
      // The workspace renames the image, then rewrites the canvas's line.
      await memory.rename('Attachments/Sky.png', 'Attachments/Clouds.png');
      await memory.write(PATH, TEXT().replace('[[Sky.png]]', '[[Clouds.png]]'), { ifUnchanged: { text: TEXT() } });
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: before, pending: false });
      // The next change is saved with the rewritten line, not the old one.
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 41, version: 2 } : element)) }));
      await sceneStore.flush();
      expect(linesOf(memory.peek(PATH))).toEqual([['s', 'Clouds.png']]);
      expect(sceneStore.getState().conflict).toBe(false);
    });

    it('reads each image once per open: Reload reads none twice, and a write to the image file reads it again', async () => {
      const { sceneStore, store } = start(initial());
      const reads: string[] = [];
      const read = store.readBlob.bind(store);
      store.readBlob = async (path) => (reads.push(path), read(path));
      await sceneStore.load(REF);
      await sceneStore.reload();
      await sceneStore.load(REF);
      expect(reads).toEqual(['Attachments/Sky.png']);
      await memory.write('Attachments/Sky.png', blob(MOON));
      await sceneStore.reload();
      const shown = (await sceneStore.load(REF))!;
      expect(reads).toEqual(['Attachments/Sky.png', 'Attachments/Sky.png']);
      expect(shown.scene.files?.s).toMatchObject({ dataURL: dataURLOf(MOON) });
    });

    it('takes the text Move images to files writes, and shows the same images, now read from the files', async () => {
      const { sceneStore, store } = start({ [PATH]: canvasHolding([{ id: 'old', bytes: SKY, created: 1_800_000_000_000 }]) });
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      const before = sceneStore.getState().revision;
      const run = await moveImagesOut(store, [PATH], { unsaved: () => sceneStore.getState().pending });
      expect(run).toMatchObject({ images: 1, canvases: 1, skipped: [] });
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState()).toMatchObject({ conflict: false, revision: before + 1 });
      const reloaded = (await sceneStore.load(REF))!;
      expect(reloaded.scene.elements.map((element) => element.id)).toEqual(loaded.scene.elements.map((element) => element.id));
      expect(reloaded.scene.files?.old).toMatchObject({ dataURL: dataURLOf(SKY) });
      // Saving the shown canvas again keeps the picture a file: no data inside, its line kept.
      await sceneStore.save(reloaded);
      await sceneStore.save(documentWith(reloaded, { ...reloaded.scene, elements: reloaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 9, version: 2 } : element)) }));
      await sceneStore.flush();
      expect(filesIn(memory.peek(PATH))).toEqual([]);
      expect(linesOf(memory.peek(PATH))).toHaveLength(1);
    });

    it('names the images by reference in the copy it keeps of a change in conflict, and carries them inside in the download when the copy can’t be written', async () => {
      const kept: KeptCopy[] = [];
      const unsubscribe = subscribeKeptCopies((copy) => kept.push(copy));
      try {
        for (const copyWorks of [true, false]) {
          kept.length = 0;
          const { sceneStore } = start(initial(), { failing: (path) => !copyWorks && path !== PATH && /conflict/i.test(path) });
          const loaded = (await sceneStore.load(REF))!;
          await sceneStore.save(loaded);
          // Drawing with an unsaved change, then another writer changes the file: a conflict.
          await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 123, version: 2 } : element)) }));
          await memory.write(PATH, referencing({ s: 'Sky.png', t: 'Sky.png' }));
          await vi.advanceTimersByTimeAsync(0);
          expect(sceneStore.getState().conflict).toBe(true);
          await sceneStore.dispose();
          expect(kept).toHaveLength(1);
          const entry = kept[0];
          if (copyWorks) {
            expect(entry.copy).not.toBeNull();
            const copyText = memory.peek(entry.copy!)!;
            expect(readObsidianExcalidrawMarkdown(copyText).elements.find((element) => element.id === 'rect')?.x).toBe(123);
            expect(filesIn(copyText)).toEqual([]);
            expect(linesOf(copyText).map(([id]) => id)).toContain('s');
          } else {
            expect(entry.copy).toBeNull();
            if (entry.copy === null) {
              expect(filesIn(entry.download.text)).toContain('s');
              expect(readObsidianExcalidrawMarkdown(entry.download.text).files?.s).toMatchObject({ dataURL: dataURLOf(SKY) });
              entry.release();
            }
          }
        }
      } finally {
        unsubscribe();
      }
    });

    it('Keep mine writes the canvas over the other change with its images still named by reference', async () => {
      const { sceneStore } = start(initial());
      const loaded = (await sceneStore.load(REF))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 88, version: 2 } : element)) }));
      // Another writer saves the canvas with an extra image line: a conflict.
      await memory.write(PATH, referencing({ s: 'Sky.png', t: 'Sky.png' }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState().conflict).toBe(true);
      await sceneStore.keepMine();
      const text = memory.peek(PATH)!;
      expect(readObsidianExcalidrawMarkdown(text).elements.find((element) => element.id === 'rect')?.x).toBe(88);
      expect(filesIn(text)).toEqual([]);
      expect(linesOf(text).map(([id]) => id)).toContain('s');
      expect(await attachments(memory)).toEqual(['Attachments/Sky.png']);
    });

    it('offers a failed save as a download that carries every image inside', async () => {
      const kept: KeptCopy[] = [];
      const unsubscribe = subscribeKeptCopies((copy) => kept.push(copy));
      try {
        const { sceneStore } = start(initial(), { failing: (path) => path === PATH });
        const loaded = (await sceneStore.load(REF))!;
        await sceneStore.save(loaded);
        await sceneStore.save(documentWith(loaded, { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'rect' ? { ...element, x: 55, version: 2 } : element)) }));
        await sceneStore.dispose();
        expect(kept).toHaveLength(1);
        const entry = kept[0];
        expect(entry.copy).toBeNull();
        if (entry.copy !== null) return;
        const standalone = readObsidianExcalidrawMarkdown(entry.download.text);
        expect(standalone.elements.find((element) => element.id === 'rect')?.x).toBe(55);
        expect(standalone.files?.s).toMatchObject({ dataURL: dataURLOf(SKY) });
        entry.release();
      } finally {
        unsubscribe();
      }
    });
  });
});

describe('serialize: images held by reference', () => {
  const big = (id: string) => ({ id, mimeType: 'image/jpeg', dataURL: `data:image/jpeg;base64,${'Q'.repeat(300 * 1024)}`, created: 1 });
  const bigScene = () => drawing([picture('img-1')], { 'img-1': big('img-1') });

  it('writes a canvas whose images are all references compressed, whatever their size', () => {
    const text = serialize(null, bigScene(), 'markdown', new Map([['img-1', 'Big.jpg']]));
    expect(text).toContain('```compressed-json');
    expect(text.length).toBeLessThan(20_000);
    expect(linesOf(text)).toEqual([['img-1', 'Big.jpg']]);
  });

  it('still writes plain JSON for a big image that is inside the drawing', () => {
    expect(serialize(null, bigScene(), 'markdown')).not.toContain('```compressed-json');
    // One big image held inside decides it, even when another is a reference.
    const mixed = drawing([picture('img-1'), picture('img-2')], { 'img-1': big('img-1'), 'img-2': big('img-2') });
    expect(serialize(null, mixed, 'markdown', new Map([['img-1', 'Big.jpg']]))).not.toContain('```compressed-json');
  });

  it('adds a line for each referenced image an element uses, keeps a line already there as written, and drops one nothing uses', () => {
    const first = serialize(null, drawing([picture('a'), picture('b')], { a: fileOf('a', SKY), b: fileOf('b', MOON) }), 'markdown', new Map([['a', 'A.png'], ['b', 'B.png']]));
    expect(linesOf(first)).toEqual([['a', 'A.png'], ['b', 'B.png']]);
    expect(filesIn(first)).toEqual([]);
    const renamed = first.replace('[[A.png]]', '[[Renamed A.png]]');
    const next = serialize(renamed, drawing([picture('a')], { a: fileOf('a', SKY), b: fileOf('b', MOON) }), 'markdown', new Map([['a', 'A.png'], ['b', 'B.png']]));
    expect(linesOf(next)).toEqual([['a', 'Renamed A.png']]);
  });

  it('keeps every image inside a plain .excalidraw JSON file, references or not', () => {
    const json = JSON.parse(serialize(null, drawing([picture('a')], { a: fileOf('a', SKY) }), 'json', new Map([['a', 'A.png']])));
    expect(json.files.a.dataURL).toBe(dataURLOf(SKY));
  });
});
