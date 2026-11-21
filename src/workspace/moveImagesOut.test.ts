import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../e2e/harness/views-store';
import type { FileStore } from '../files/types';
import { editEmbeddedFiles, embeddedFiles } from '../nebula/excalidraw/embeddedFiles';
import { readObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { blobBytes, pastedImageName } from './attachments';
import { moveImagesOut, type MoveOutRun } from './moveImagesOut';
import { canvasHolding, dataURLOf } from './views/testing/canvasFixtures';
import { nodeCrypto } from './views/testing/webcrypto';

// Move images to files: the images a drawing holds inside become files in Attachments/ and the drawing names them.
// Nothing is ever deleted or overwritten; a canvas that can't be moved safely is left as it was.

const A = [1, 2, 3, 4];
const B = [9, 8, 7, 6, 5];
const C = [42, 42];
const CREATED = Date.UTC(2026, 5, 15, 12, 0, 0);
const never = () => false;

const bytesAt = async (store: FileStore, path: string) => Array.from(await blobBytes(await store.readBlob(path)));
const attachments = async (store: FileStore) => (await store.list()).filter((entry) => entry.type === 'file' && entry.path.startsWith('Attachments/')).map((entry) => entry.path).sort();
const lineTargets = (text: string) => embeddedFiles(text).map((line) => [line.id, line.target]);

/** A store that records what was removed, so "nothing is ever deleted" can be checked. */
function watched(store: MemoryFileStore): { store: MemoryFileStore; removed: string[] } {
  const removed: string[] = [];
  const remove = store.remove.bind(store);
  store.remove = async (path) => {
    removed.push(path);
    return remove(path);
  };
  return { store, removed };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('moving the images inside a canvas out to files', () => {
  it('writes each image into Attachments/ and names it in the canvas, which no longer holds its data', async () => {
    const text = canvasHolding([
      { id: 'img-a', bytes: A, created: CREATED },
      { id: 'img-b', bytes: B, mimeType: 'image/jpeg', created: CREATED + 5000 },
    ]);
    const { store, removed } = watched(createMemoryFileStore({ 'Sketches/Map.excalidraw.md': text }));
    const run = await moveImagesOut(store, ['Sketches/Map.excalidraw.md'], { unsaved: never });
    expect(run).toEqual({ images: 2, canvases: 1, written: 2, skipped: [] });

    const nameA = pastedImageName(new Date(CREATED), 'png');
    const nameB = pastedImageName(new Date(CREATED + 5000), 'jpg');
    expect(await bytesAt(store, `Attachments/${nameA}`)).toEqual(A);
    expect(await bytesAt(store, `Attachments/${nameB}`)).toEqual(B);

    const next = store.peek('Sketches/Map.excalidraw.md')!;
    expect(lineTargets(next)).toEqual([
      ['img-a', nameA],
      ['img-b', nameB],
    ]);
    const after = readObsidianExcalidrawMarkdown(next);
    expect(after.elements.map((element) => element.id)).toEqual(['rect', 'el-img-a', 'el-img-b']);
    expect(Object.keys(after.files ?? {})).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('writes every image before the canvas that names it', async () => {
    const store = createMemoryFileStore({ 'Map.excalidraw.md': canvasHolding([{ id: 'img-a', bytes: A, created: CREATED }, { id: 'img-b', bytes: B, created: CREATED + 1000 }]) });
    await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    const order = store.writes.map((write) => write.path);
    expect(order.at(-1)).toBe('Map.excalidraw.md');
    expect(order.slice(0, -1).every((path) => path.startsWith('Attachments/'))).toBe(true);
    expect(order).toHaveLength(3);
  });

  it('names an image with no time `Image <id>`', async () => {
    const store = createMemoryFileStore({ 'Map.excalidraw.md': canvasHolding([{ id: 'abcdef0123456789', bytes: A }]) });
    await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(await attachments(store)).toEqual(['Attachments/Image abcdef012345.png']);
  });

  it('names a file in the canvas’s links by a path when its bare name would find another file', async () => {
    const store = createMemoryFileStore({
      'Map.excalidraw.md': canvasHolding([{ id: 'abcdef0123456789', bytes: A }]),
      'Photos/Image abcdef012345.png': new Blob([new Uint8Array([5])]),
    });
    await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(lineTargets(store.peek('Map.excalidraw.md')!)).toEqual([['abcdef0123456789', 'Attachments/Image abcdef012345.png']]);
  });

  it('leaves a deleted element’s image, one the drawing holds with no element, and an image already named, where they are', async () => {
    const text = canvasHolding([
      { id: 'live', bytes: A, created: CREATED },
      { id: 'gone', bytes: B, deleted: true },
      { id: 'orphan', bytes: C, unused: true },
    ]);
    const store = createMemoryFileStore({ 'Map.excalidraw.md': text });
    const run = await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 1, canvases: 1, written: 1 });
    expect(Object.keys(readObsidianExcalidrawMarkdown(store.peek('Map.excalidraw.md')!).files ?? {}).sort()).toEqual(['gone', 'orphan']);
    // A second run has only those left, and they aren't used by an element: nothing to move.
    expect(await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never })).toEqual({ images: 0, canvases: 0, written: 0, skipped: [] });
  });

  it('leaves an image that has a line of its own as it is: the drawing’s own copy wins, and no second line is made', async () => {
    const inside = canvasHolding([{ id: 'img-a', bytes: A, created: CREATED }]);
    const text = editEmbeddedFiles(inside, { add: [['img-a', 'Elsewhere.png']] });
    expect(lineTargets(text)).toEqual([['img-a', 'Elsewhere.png']]);
    const store = createMemoryFileStore({ 'Map.excalidraw.md': text });
    expect(await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never })).toEqual({ images: 0, canvases: 0, written: 0, skipped: [] });
    expect(store.writes).toEqual([]);
  });

  it('leaves byte for byte a plain .excalidraw, a canvas with nothing inside, and one whose lines name files that are missing', async () => {
    const lined = canvasHolding([{ id: 'img-a', bytes: A, created: CREATED }]);
    const store = createMemoryFileStore({
      'Old.excalidraw': JSON.stringify({ type: 'excalidraw', elements: [], files: {} }),
      'Empty.excalidraw.md': canvasHolding([]),
      'Lined.excalidraw.md': lined,
    });
    // Make the third one hold its image by reference to a file that isn't there.
    await moveImagesOut(store, ['Lined.excalidraw.md'], { unsaved: never });
    await store.remove(`Attachments/${pastedImageName(new Date(CREATED), 'png')}`);
    const before = new Map([...['Old.excalidraw', 'Empty.excalidraw.md', 'Lined.excalidraw.md']].map((path) => [path, store.peek(path)!]));
    store.writes.length = 0;
    const run = await moveImagesOut(store, [...before.keys()], { unsaved: never });
    expect(run).toEqual({ images: 0, canvases: 0, written: 0, skipped: [] });
    expect(store.writes).toEqual([]);
    for (const [path, text] of before) expect(store.peek(path)).toBe(text);
  });
});

describe('identical bytes become one file', () => {
  it('writes one file for the same bytes in one canvas, in another canvas, and under another id', async () => {
    const store = createMemoryFileStore({
      'One.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }, { id: 'x2', bytes: A, created: CREATED + 60_000 }]),
      'Two.excalidraw.md': canvasHolding([{ id: 'y1', bytes: A, created: CREATED + 120_000 }, { id: 'y2', bytes: B, created: CREATED }]),
    });
    const run = await moveImagesOut(store, ['One.excalidraw.md', 'Two.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 4, canvases: 2, written: 2 });
    expect(await attachments(store)).toHaveLength(2);
    const one = lineTargets(store.peek('One.excalidraw.md')!);
    const two = lineTargets(store.peek('Two.excalidraw.md')!);
    expect(one[0][1]).toBe(one[1][1]);
    expect(two[0][1]).toBe(one[0][1]);
    expect(two[1][1]).not.toBe(one[0][1]);
  });

  it('uses a file already in Attachments/ under the name it would take when the bytes are the same', async () => {
    const name = pastedImageName(new Date(CREATED), 'png');
    const store = createMemoryFileStore({
      'Map.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      [`Attachments/${name}`]: new Blob([new Uint8Array(A)]),
    });
    const run = await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 1, canvases: 1, written: 0 });
    expect(lineTargets(store.peek('Map.excalidraw.md')!)).toEqual([['x1', name]]);
    expect(await attachments(store)).toEqual([`Attachments/${name}`]);
  });

  it('never takes a file with other bytes under the same name: the image goes to the next free name', async () => {
    const name = pastedImageName(new Date(CREATED), 'png');
    const second = name.replace('.png', ' 2.png');
    const store = createMemoryFileStore({
      'Map.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      [`Attachments/${name}`]: new Blob([new Uint8Array(B)]),
    });
    await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(await bytesAt(store, `Attachments/${name}`)).toEqual(B);
    expect(await bytesAt(store, `Attachments/${second}`)).toEqual(A);
    expect(lineTargets(store.peek('Map.excalidraw.md')!)).toEqual([['x1', second]]);
  });

  it('compares the bytes, not only the size: a file of the same size with other bytes is not the image', async () => {
    const name = pastedImageName(new Date(CREATED), 'png');
    const sameSize = [1, 2, 3, 5];
    expect(sameSize).toHaveLength(A.length);
    const store = createMemoryFileStore({
      'Map.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      [`Attachments/${name}`]: new Blob([new Uint8Array(sameSize)]),
    });
    await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(await bytesAt(store, `Attachments/${name}`)).toEqual(sameSize);
    expect(lineTargets(store.peek('Map.excalidraw.md')!)).toEqual([['x1', name.replace('.png', ' 2.png')]]);
  });

  it('finds the same bytes under `name 2` when `name` holds other bytes', async () => {
    const name = pastedImageName(new Date(CREATED), 'png');
    const second = name.replace('.png', ' 2.png');
    const store = createMemoryFileStore({
      'Map.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      [`Attachments/${name}`]: new Blob([new Uint8Array(B)]),
      [`Attachments/${second}`]: new Blob([new Uint8Array(A)]),
    });
    const run = await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: never });
    expect(run.written).toBe(0);
    expect(lineTargets(store.peek('Map.excalidraw.md')!)).toEqual([['x1', second]]);
  });

  it('writes a file again for the same hash when the file the run wrote has been changed since', async () => {
    // Bytes are compared with the file itself, never taken on the hash alone.
    const store = createMemoryFileStore({
      'One.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      'Two.excalidraw.md': canvasHolding([{ id: 'y1', bytes: A, created: CREATED + 1000 }]),
    });
    const write = store.write.bind(store);
    let spoiled = false;
    store.write = async (path, data, options) => {
      await write(path, data, options);
      // Another writer replaces the image just written, once the first canvas is done.
      if (!spoiled && path === 'One.excalidraw.md') {
        spoiled = true;
        const target = [...(await store.list())].find((entry) => entry.path.startsWith('Attachments/'))!.path;
        await write(target, new Blob([new Uint8Array(C)]));
      }
    };
    const run = await moveImagesOut(store, ['One.excalidraw.md', 'Two.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 2, canvases: 2 });
    const twoTarget = lineTargets(store.peek('Two.excalidraw.md')!)[0][1] as string;
    expect(await bytesAt(store, `Attachments/${twoTarget}`)).toEqual(A);
  });

  it('makes one file of the same bytes with WebCrypto, as on https', async () => {
    vi.stubGlobal('crypto', (await nodeCrypto()).webcrypto);
    const store = createMemoryFileStore({
      'One.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }, { id: 'x2', bytes: A, created: CREATED + 60_000 }, { id: 'x3', bytes: B, created: CREATED + 120_000 }]),
    });
    const run = await moveImagesOut(store, ['One.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 3, canvases: 1, written: 2 });
    const targets = lineTargets(store.peek('One.excalidraw.md')!);
    expect(targets[0][1]).toBe(targets[1][1]);
    expect(targets[2][1]).not.toBe(targets[0][1]);
  });

  it('works without WebCrypto, as on a page served over plain http', async () => {
    vi.stubGlobal('crypto', undefined);
    const store = createMemoryFileStore({
      'One.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }, { id: 'x2', bytes: A, created: CREATED + 60_000 }, { id: 'x3', bytes: B, created: CREATED + 120_000 }]),
    });
    const run = await moveImagesOut(store, ['One.excalidraw.md'], { unsaved: never });
    expect(run).toMatchObject({ images: 3, canvases: 1, written: 2 });
    const targets = lineTargets(store.peek('One.excalidraw.md')!);
    expect(targets[0][1]).toBe(targets[1][1]);
    expect(targets[2][1]).not.toBe(targets[0][1]);
  });

  it('writes nothing again on a second run, and moves what the first skipped', async () => {
    const store = createMemoryFileStore({
      'One.excalidraw.md': canvasHolding([{ id: 'x1', bytes: A, created: CREATED }]),
      'Two.excalidraw.md': canvasHolding([{ id: 'y1', bytes: A, created: CREATED }, { id: 'y2', bytes: B, created: CREATED + 1000 }]),
    });
    // Two has unsaved changes the first time: skipped, left as it was.
    const first = await moveImagesOut(store, ['One.excalidraw.md', 'Two.excalidraw.md'], { unsaved: (path) => path === 'Two.excalidraw.md' });
    expect(first).toMatchObject({ images: 1, canvases: 1, written: 1, skipped: [{ path: 'Two.excalidraw.md', why: 'unsaved' }] });
    const files = await attachments(store);
    expect(files).toHaveLength(1);

    const second = await moveImagesOut(store, ['One.excalidraw.md', 'Two.excalidraw.md'], { unsaved: never });
    // y1 is the file the first run wrote; only y2 is new.
    expect(second).toMatchObject({ images: 2, canvases: 1, written: 1, skipped: [] });
    expect(await attachments(store)).toHaveLength(2);
    const third = await moveImagesOut(store, ['One.excalidraw.md', 'Two.excalidraw.md'], { unsaved: never });
    expect(third).toEqual({ images: 0, canvases: 0, written: 0, skipped: [] });
  });
});

describe('a canvas that can’t be moved safely is left, named, and the run goes on', () => {
  const first = 'First.excalidraw.md';
  const last = 'Last.excalidraw.md';
  const holding = (id: string, bytes: number[]) => canvasHolding([{ id, bytes, created: CREATED + bytes.length }]);

  async function run(store: FileStore, unsaved: (path: string) => boolean = never): Promise<MoveOutRun> {
    return moveImagesOut(store, [first, last], { unsaved });
  }

  it('leaves a canvas with unsaved changes as it is, writing no file for it', async () => {
    const store = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B) });
    const before = store.peek(first);
    const result = await run(store, (path) => path === first);
    expect(result).toMatchObject({ images: 1, canvases: 1, written: 1, skipped: [{ path: first, why: 'unsaved' }] });
    expect(store.peek(first)).toBe(before);
    expect(await attachments(store)).toHaveLength(1);
  });

  it('checks again just before writing, and leaves a canvas that got unsaved changes meanwhile (its files stay)', async () => {
    const store = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B) });
    const before = store.peek(first);
    const calls = new Map<string, number>();
    const result = await run(store, (path) => {
      calls.set(path, (calls.get(path) ?? 0) + 1);
      return path === first && calls.get(path)! >= 2;
    });
    expect(result.skipped).toEqual([{ path: first, why: 'unsaved' }]);
    expect(store.peek(first)).toBe(before);
    expect(result.written).toBe(2);
    expect(await attachments(store)).toHaveLength(2);
    expect(result.canvases).toBe(1);
  });

  it('leaves a canvas that changed while it was being moved, and never writes over the change', async () => {
    const memory = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B) });
    const edited = `${memory.peek(first)}\n\nAn edit from another tab.`;
    const store: FileStore = {
      ...memory,
      write: async (path, data, options) => {
        if (path === first && options?.ifUnchanged && typeof options.ifUnchanged !== 'string') await memory.write(path, edited);
        return memory.write(path, data, options);
      },
    };
    const result = await run(store);
    expect(result.skipped).toEqual([{ path: first, why: 'changed' }]);
    expect(memory.peek(first)).toBe(edited);
    expect(result).toMatchObject({ images: 1, canvases: 1 });
    expect(lineTargets(memory.peek(last)!)).toHaveLength(1);
  });

  it('writes the canvas only over the text it read', async () => {
    const memory = createMemoryFileStore({ [first]: holding('a', A) });
    const seen: Array<[string, unknown]> = [];
    const store: FileStore = { ...memory, write: (path, data, options) => (seen.push([path, options]), memory.write(path, data, options)) };
    const original = memory.peek(first);
    await moveImagesOut(store, [first], { unsaved: never });
    expect(seen.at(-1)).toEqual([first, { ifUnchanged: { text: original } }]);
    expect(seen.slice(0, -1).every(([, options]) => (options as { exclusive?: boolean }).exclusive === true)).toBe(true);
  });

  it('leaves a canvas whose drawing doesn’t decode, byte for byte', async () => {
    const broken = holding('a', A).replace(/```compressed-json\n[\s\S]*?\n```/, '```compressed-json\n!!!!\n```');
    const store = createMemoryFileStore({ [first]: broken, [last]: holding('b', B) });
    const result = await run(store);
    expect(result.skipped).toEqual([{ path: first, why: 'unreadable' }]);
    expect(store.peek(first)).toBe(broken);
    expect(result).toMatchObject({ images: 1, canvases: 1 });
  });

  it('leaves a canvas whose image can’t be written, and its other canvases still go', async () => {
    const memory = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B) });
    const before = memory.peek(first);
    const store: FileStore = {
      ...memory,
      write: async (path, data, options) => {
        // Only the first canvas's image (A, 4 bytes) fails.
        if (path.startsWith('Attachments/') && data instanceof Blob && data.size === A.length) throw new Error('The disk is full.');
        return memory.write(path, data, options);
      },
    };
    const result = await run(store);
    expect(result.skipped).toEqual([{ path: first, why: 'failed' }]);
    expect(memory.peek(first)).toBe(before);
    expect(result).toMatchObject({ images: 1, canvases: 1, written: 1 });
  });

  it('keeps the files written for a canvas whose second image failed, and finds them again next run', async () => {
    const two = canvasHolding([{ id: 'a', bytes: A, created: CREATED }, { id: 'b', bytes: B, created: CREATED + 1000 }]);
    const memory = createMemoryFileStore({ [first]: two });
    let fail = true;
    const store: FileStore = {
      ...memory,
      write: async (path, data, options) => {
        if (fail && path.startsWith('Attachments/') && data instanceof Blob && data.size === B.length) throw new Error('The disk is full.');
        return memory.write(path, data, options);
      },
    };
    const failed = await moveImagesOut(store, [first], { unsaved: never });
    expect(failed).toMatchObject({ images: 0, canvases: 0, written: 1, skipped: [{ path: first, why: 'failed' }] });
    expect(memory.peek(first)).toBe(two);
    expect(await attachments(memory)).toHaveLength(1);
    fail = false;
    const again = await moveImagesOut(store, [first], { unsaved: never });
    expect(again).toMatchObject({ images: 2, canvases: 1, written: 1, skipped: [] });
    expect(await attachments(memory)).toHaveLength(2);
  });

  it('never deletes a file, whatever happens', async () => {
    const memory = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B).replace(/```compressed-json\n[\s\S]*?\n```/, '```compressed-json\n!!!!\n```') });
    const { store, removed } = watched(memory);
    await run(store, (path) => path === first);
    await run(store);
    expect(removed).toEqual([]);
  });

  it('tells how far it got, canvas by canvas', async () => {
    const store = createMemoryFileStore({ [first]: holding('a', A), [last]: holding('b', B) });
    const seen: Array<[number, number]> = [];
    await moveImagesOut(store, [first, 'Old.excalidraw', last], { unsaved: never, progress: (done, total) => seen.push([done, total]) });
    // The plain .excalidraw isn't a canvas this can move: it isn't counted.
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });

  it('stands on a project it can’t list: it rejects, and writes nothing', async () => {
    const memory = createMemoryFileStore({ [first]: holding('a', A) });
    const store: FileStore = { ...memory, list: async () => { throw new Error('The folder is out of reach.'); } };
    await expect(moveImagesOut(store, [first], { unsaved: never })).rejects.toThrow();
    expect(memory.writes).toEqual([]);
  });
});

describe('dataURLOf', () => {
  it('is a data URL of exactly its bytes (the fixtures are what they say)', () => {
    expect(dataURLOf([1, 2, 3])).toBe('data:image/png;base64,AQID');
  });
});
