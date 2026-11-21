import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileStore } from '../../../files/types';
import { blobBytes } from '../../attachments';
import { dataURLOf, sceneWith } from '../testing/canvasFixtures';
import { nodeCrypto } from '../testing/webcrypto';
import { blobToDataURL, createImageCache, dataURLBytes, fileIdFor, inlineData, ownNameOf, readReferencedImages, usedFileIds, withImages } from './canvasImages';
import { editEmbeddedFiles } from '../../../nebula/excalidraw/embeddedFiles';
import { toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';

// A canvas's images as files beside it: which an open drawing reads, from where, and how often.

const SKY = [1, 2, 3, 4];
const MOON = [5, 6, 7];
const blob = (bytes: number[]) => new Blob([new Uint8Array(bytes)]);

/** An Obsidian drawing whose elements use these ids, with these Embedded Files lines. */
function referencing(lines: Record<string, string>, unused: string[] = []): { text: string; scene: ReturnType<typeof sceneWith> } {
  const ids = Object.keys(lines);
  const scene = sceneWith(ids.map((id) => ({ id, bytes: [0], ...(unused.includes(id) ? { deleted: true } : {}) })));
  const bare = { ...scene, files: {} };
  const text = toObsidianExcalidrawMarkdown(bare, { embedded: { add: Object.entries(lines) } });
  return { text, scene: bare };
}

/** A store that counts reads of each file, and how many are in flight at once. */
function counting(initial: Record<string, Blob | string>, delay = 0) {
  const memory = createMemoryFileStore(initial);
  const reads: string[] = [];
  let inFlight = 0;
  let peak = 0;
  const store: FileStore = {
    ...memory,
    readBlob: async (path) => {
      reads.push(path);
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
        return await memory.readBlob(path);
      } finally {
        inFlight -= 1;
      }
    },
  };
  return { store, memory, reads, peak: () => peak };
}

describe('readReferencedImages', () => {
  it('reads each image an element uses, and hands Excalidraw its id, type, data and time', async () => {
    const { store } = counting({ 'Attachments/Sky.png': blob(SKY), 'Attachments/Moon.jpg': blob(MOON), 'Sketches/Map.excalidraw.md': '' });
    const { text, scene } = referencing({ s: 'Sky.png', m: 'Moon.jpg' });
    const found = await readReferencedImages(store, 'Sketches/Map.excalidraw.md', text, scene);
    expect(Object.keys(found.files).sort()).toEqual(['m', 's']);
    expect(found.files.s).toEqual({ id: 's', mimeType: 'image/png', dataURL: dataURLOf(SKY), created: expect.any(Number) });
    expect(found.files.m).toMatchObject({ mimeType: 'image/jpeg', dataURL: dataURLOf(MOON, 'image/jpeg') });
    expect(Object.fromEntries(found.links)).toEqual({ s: 'Sky.png', m: 'Moon.jpg' });
  });

  it('finds a file by the canvas’s own place when a name is ambiguous, as the link rules do', async () => {
    const { store } = counting({ 'Sketches/Sky.png': blob(SKY), 'Attachments/Sky.png': blob(MOON) });
    const { text, scene } = referencing({ s: 'Sky.png' });
    const beside = await readReferencedImages(store, 'Sketches/Map.excalidraw.md', text, scene);
    expect(beside.files.s.dataURL).toBe(dataURLOf(SKY));
    const far = await readReferencedImages(store, 'Elsewhere/Map.excalidraw.md', text, scene);
    // Neither is beside it: the shallowest, then the first by name (Attachments/ before Sketches/).
    expect(far.files.s.dataURL).toBe(dataURLOf(MOON));
    // A line written as a path names that file whatever the canvas's place.
    const path = referencing({ s: 'Sketches/Sky.png' });
    expect((await readReferencedImages(store, 'Elsewhere/Map.excalidraw.md', path.text, path.scene)).files.s.dataURL).toBe(dataURLOf(SKY));
  });

  it('gives nothing for a missing file or one that is not an image, and keeps no link for it', async () => {
    const { store } = counting({ 'Notes/Orion.md': 'an image, not', 'Papers/Star chart.pdf': blob([1]) });
    const { text, scene } = referencing({ a: 'Missing.png', b: 'Orion', c: 'Star chart.pdf', d: 'Orion.md' });
    const found = await readReferencedImages(store, 'Map.excalidraw.md', text, scene);
    expect(found.files).toEqual({});
    expect([...found.links]).toEqual([]);
  });

  it('does not take a note named like an image for the image: `Sky.png` finds no `Sky.png.md`', async () => {
    const { store, reads } = counting({ 'Sky.png.md': 'a note' });
    const { text, scene } = referencing({ s: 'Sky.png' });
    expect((await readReferencedImages(store, 'Map.excalidraw.md', text, scene)).files).toEqual({});
    expect(reads).toEqual([]);
  });

  // Was a bug (found by this test): readReferencedImages means to keep the first line of an id (`found.links.has(line.id)`),
  // but it checks that before the read, and four reads run at once, so the second line of a repeated id is read too
  // and the last to finish wins. Rare (the plugin writes one line per id); the drawing is not damaged, a different
  // image may show. Fixed at integration: one worker takes an id's lines in order.
  it('takes the first line of an id that has two', async () => {
    const { store } = counting({ 'First.png': blob(SKY), 'Second.png': blob(MOON) });
    const { text, scene } = referencing({ s: 'First.png' });
    const twice = editEmbeddedFiles(text, {}).replace('s: [[First.png]]', 's: [[First.png]]\n\ns: [[Second.png]]');
    const found = await readReferencedImages(store, 'Map.excalidraw.md', twice, scene);
    expect(found.files.s.dataURL).toBe(dataURLOf(SKY));
    expect(found.links.get('s')).toBe('First.png');
  });

  it('reads no image for an id no element uses, nor one the drawing holds inside', async () => {
    const { store, reads } = counting({ 'Sky.png': blob(SKY), 'Moon.png': blob(MOON), 'Sun.png': blob([9]) });
    const { text, scene } = referencing({ used: 'Sky.png', unused: 'Moon.png', inside: 'Sun.png' }, ['unused']);
    const found = await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { present: new Set(['inside']) });
    expect(Object.keys(found.files)).toEqual(['used']);
    expect(reads).toEqual(['Sky.png']);
  });

  it('reads nothing from outside the project: no address, no path above it', async () => {
    const fetched = vi.fn();
    vi.stubGlobal('fetch', fetched);
    try {
      const { store, reads } = counting({ 'Sky.png': blob(SKY) });
      const { text, scene } = referencing({ a: 'https://example.com/Sky.png', b: '../Sky.png', c: '/etc/Sky.png' });
      expect((await readReferencedImages(store, 'Map.excalidraw.md', text, scene)).files).toEqual({});
      expect(reads).toEqual([]);
      expect(fetched).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reads an image once per cache: a second open, and Reload, read none twice, and a change to the file reads it again', async () => {
    const { store, memory, reads } = counting({ 'Sky.png': blob(SKY) });
    const cache = createImageCache();
    const { text, scene } = referencing({ s: 'Sky.png' });
    await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { cache });
    await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { cache });
    expect(reads).toEqual(['Sky.png']);
    // The image is changed: the store's change is heard, the cache forgets it.
    await memory.write('Sky.png', blob(MOON));
    cache.forget('Sky.png');
    const again = await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { cache });
    expect(reads).toEqual(['Sky.png', 'Sky.png']);
    expect(again.files.s.dataURL).toBe(dataURLOf(MOON));
  });

  it('forgets a folder’s worth at once, and no file whose name only begins the same', async () => {
    const { store, reads } = counting({ 'Photos/Sky.png': blob(SKY), 'Photos 2/Sky.png': blob(MOON) });
    const cache = createImageCache();
    for (const [folder, id] of [['Photos', 'a'], ['Photos 2', 'b']] as const) {
      const one = referencing({ [id]: `${folder}/Sky.png` });
      await readReferencedImages(store, 'Map.excalidraw.md', one.text, one.scene, { cache });
    }
    cache.forget('Photos');
    reads.length = 0;
    for (const [folder, id] of [['Photos', 'a'], ['Photos 2', 'b']] as const) {
      const one = referencing({ [id]: `${folder}/Sky.png` });
      await readReferencedImages(store, 'Map.excalidraw.md', one.text, one.scene, { cache });
    }
    expect(reads).toEqual(['Photos/Sky.png']);
  });

  it('tries an image again on the next open after a read that failed', async () => {
    const memory = createMemoryFileStore({ 'Sky.png': blob(SKY) });
    let fail = true;
    const store: FileStore = { ...memory, readBlob: async (path) => (fail ? Promise.reject(new Error('Not now.')) : memory.readBlob(path)) };
    const cache = createImageCache();
    const { text, scene } = referencing({ s: 'Sky.png' });
    expect((await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { cache })).files).toEqual({});
    fail = false;
    expect(Object.keys((await readReferencedImages(store, 'Map.excalidraw.md', text, scene, { cache })).files)).toEqual(['s']);
  });

  it('never rejects: a project it can’t list gives no images', async () => {
    const memory = createMemoryFileStore({ 'Sky.png': blob(SKY) });
    const store: FileStore = { ...memory, list: async () => Promise.reject(new Error('Out of reach.')) };
    const { text, scene } = referencing({ s: 'Sky.png' });
    expect((await readReferencedImages(store, 'Map.excalidraw.md', text, scene)).files).toEqual({});
  });

  it('reads at most four at once, however many images a drawing has', async () => {
    const initial = Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`Image ${at}.png`, blob([at])]));
    const { store, peak } = counting(initial, 5);
    const lines = Object.fromEntries(Array.from({ length: 12 }, (_, at) => [`id${at}`, `Image ${at}.png`]));
    const { text, scene } = referencing(lines);
    const found = await readReferencedImages(store, 'Map.excalidraw.md', text, scene);
    expect(Object.keys(found.files)).toHaveLength(12);
    expect(peak()).toBeGreaterThan(1);
    expect(peak()).toBeLessThanOrEqual(4);
  });

  it('gives an image read the file’s own time, so a later change is a later `created`', async () => {
    const memory = createMemoryFileStore({ 'Sky.png': blob(SKY) });
    memory.setNow(() => 1_700_000_000_000);
    await memory.write('Sky.png', blob(SKY));
    const { text, scene } = referencing({ s: 'Sky.png' });
    expect((await readReferencedImages(memory, 'Map.excalidraw.md', text, scene)).files.s.created).toBe(1_700_000_000_000);
  });
});

describe('withImages', () => {
  it('adds the images read beside the drawing’s own, which win for the same id', () => {
    const scene = sceneWith([{ id: 'own', bytes: [1] }]);
    const read = { files: { own: { id: 'own', mimeType: 'image/png', dataURL: 'data:other', created: 1 }, extra: { id: 'extra', mimeType: 'image/png', dataURL: 'data:extra', created: 1 } }, links: new Map() };
    const merged = withImages(scene, read);
    expect(Object.keys(merged.files ?? {}).sort()).toEqual(['extra', 'own']);
    expect(inlineData((merged.files as Record<string, unknown>).own)).toBe(dataURLOf([1]));
    // Nothing read: the very same scene.
    expect(withImages(scene, { files: {}, links: new Map() })).toBe(scene);
  });
});

describe('fileIdFor', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('gives the SHA-1 hex of the file, as Excalidraw’s own default does', async () => {
    const node = await nodeCrypto();
    vi.stubGlobal('crypto', node.webcrypto);
    const bytes = new Uint8Array([10, 20, 30, 40, 250]);
    expect(await fileIdFor(new File([bytes], 'Sky.png', { type: 'image/png' }))).toBe(node.createHash('sha1').update(bytes).digest('hex'));
  });

  it('remembers a dropped file’s name by its id, and none for a clipboard’s image.png', async () => {
    vi.stubGlobal('crypto', (await nodeCrypto()).webcrypto);
    const dropped = await fileIdFor(new File([new Uint8Array([1, 1, 1])], 'Sky #1.png', { type: 'image/png' }));
    expect(ownNameOf(dropped)).toBe('Sky #1.png');
    const pasted = await fileIdFor(new File([new Uint8Array([2, 2, 2])], 'image.png', { type: 'image/png' }));
    expect(ownNameOf(pasted)).toBeUndefined();
  });

  it('gives one image one id, whichever name it came with', async () => {
    vi.stubGlobal('crypto', (await nodeCrypto()).webcrypto);
    const one = await fileIdFor(new File([new Uint8Array([3, 3])], 'A.png'));
    const two = await fileIdFor(new File([new Uint8Array([3, 3])], 'B.png'));
    expect(one).toBe(two);
    expect(one).toMatch(/^[0-9a-f]{40}$/);
  });

  it('still gives an id where there is no WebCrypto (an http address), as 40 hex digits of its own', async () => {
    vi.stubGlobal('crypto', { getRandomValues: (array: Uint8Array) => array.fill(171) });
    const id = await fileIdFor(new File([new Uint8Array([4])], 'Sky.png'));
    expect(id).toBe('ab'.repeat(20));
    expect(ownNameOf(id)).toBe('Sky.png');
  });
});

describe('data URLs', () => {
  it('round-trips bytes through base64, past a block of 32,768 bytes', async () => {
    const bytes = Uint8Array.from({ length: 70_000 }, (_, at) => (at * 7) % 256);
    const url = await blobToDataURL(new Blob([bytes]), 'image/png');
    const back = dataURLBytes(url)!;
    expect(back.mimeType).toBe('image/png');
    expect(back.bytes.length).toBe(70_000);
    expect(Array.from(back.bytes.subarray(0, 1000))).toEqual(Array.from(bytes.subarray(0, 1000)));
    expect(Array.from(back.bytes.subarray(69_000))).toEqual(Array.from(bytes.subarray(69_000)));
    expect(Array.from(await blobBytes(new Blob([back.bytes as BlobPart])))).toEqual(Array.from(bytes));
  });

  it('reads a percent-encoded data URL, and refuses what isn’t one', () => {
    expect(dataURLBytes('data:image/svg+xml,%3Csvg%2F%3E')).toEqual({ mimeType: 'image/svg+xml', bytes: new TextEncoder().encode('<svg/>') });
    expect(dataURLBytes('https://example.com/a.png')).toBeNull();
    expect(dataURLBytes('data:image/png;base64,%%%')).toBeNull();
    expect(inlineData({ dataURL: 'https://example.com/a.png' })).toBeNull();
    expect(inlineData({ dataURL: 'data:image/png;base64,AA==' })).toBe('data:image/png;base64,AA==');
    expect(inlineData(null)).toBeNull();
  });

  it('says which file ids a drawing’s live elements use', () => {
    const scene = sceneWith([{ id: 'live', bytes: [1] }, { id: 'gone', bytes: [2], deleted: true }, { id: 'orphan', bytes: [3], unused: true }]);
    expect([...usedFileIds(scene)]).toEqual(['live']);
  });
});
