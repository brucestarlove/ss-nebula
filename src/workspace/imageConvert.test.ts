import { describe, expect, it } from 'vitest';
import { blobToText } from '../files/bytes';
import { MemoryFileStore } from '../files/memoryStore';
import {
  convertImages,
  describeConversions,
  imageMoves,
  isConvertible,
  outputSize,
  readChoices,
  sourceFormat,
  targetName,
  writeChoices,
  type BitmapLike,
  type ConvertChoice,
  type ImageTools,
} from './imageConvert';

/** The real memory store (it passes src/files/storeConformance.ts), with files in it. */
async function storeWith(files: Record<string, Blob>): Promise<MemoryFileStore> {
  const store = new MemoryFileStore();
  for (const [path, data] of Object.entries(files)) await store.write(path, data);
  return store;
}

/** A stand-in image: its "pixels" are its size, written as text. */
function picture(width: number, height: number, padding = 0): Blob {
  return new Blob([`${width}x${height}`, ' '.repeat(padding)], { type: 'image/png' });
}

type Encoded = { type: string; width: number; height: number; quality: number | undefined; fill: string | null };

/** jsdom has no image decoding or canvas: these play the browser's part. */
function fakeTools(options: { encodes?: string[]; size?: (encoded: Encoded) => number; failDecode?: boolean } = {}) {
  const encoded: Encoded[] = [];
  const closed: number[] = [];
  let opened = 0;
  const tools: ImageTools = {
    async decode(blob) {
      if (options.failDecode) throw new Error('decode');
      const [width, height] = (await blobToText(blob)).trim().split('x').map(Number);
      const id = (opened += 1);
      return { width, height, close: () => closed.push(id) } satisfies BitmapLike;
    },
    async encode(_bitmap, width, height, type, quality, fill) {
      const job = { type, width, height, quality, fill };
      encoded.push(job);
      return new Blob(['x'.repeat(options.size ? options.size(job) : 10)], { type });
    },
    async canEncode(type) {
      return (options.encodes ?? ['image/webp', 'image/jpeg', 'image/png']).includes(type);
    },
  };
  return { tools, encoded, closed, opened: () => opened };
}

const WEBP: ConvertChoice = { format: 'webp', quality: 0.8, side: null, then: 'keep' };

describe('which files it offers itself for', () => {
  it('takes the images a browser decodes, but not SVG: it has no pixels to convert', () => {
    for (const name of ['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.avif', 'f.gif']) expect(isConvertible(name)).toBe(true);
    for (const name of ['g.svg', 'h.md', 'i.excalidraw', 'j.pdf', 'png']) expect(isConvertible(name)).toBe(false);
  });

  it('names the format a file is in', () => {
    expect(['a.png', 'b.JPG', 'c.jpeg', 'd.webp', 'e.avif', 'f.gif'].map(sourceFormat)).toEqual(['PNG', 'JPEG', 'JPEG', 'WebP', 'AVIF', 'GIF']);
  });
});

describe('the new name', () => {
  it('swaps the extension for the new format', () => {
    expect(targetName('Orion Nebula.png', 'webp')).toBe('Orion Nebula.webp');
    expect(targetName('M42.final.jpg', 'png')).toBe('M42.final.png');
    expect(targetName('Sky.png', 'jpeg')).toBe('Sky.jpg');
  });

  it('keeps the name, as written, when the format stays', () => {
    expect(targetName('Sky.JPEG', 'jpeg')).toBe('Sky.JPEG');
    expect(targetName('Sky.webp', 'webp')).toBe('Sky.webp');
  });
});

describe('the new size', () => {
  it('fits the longest side, keeping the shape, and never makes an image bigger', () => {
    expect(outputSize({ width: 4032, height: 3024 }, 1920)).toEqual({ width: 1920, height: 1440 });
    expect(outputSize({ width: 3024, height: 4032 }, 1920)).toEqual({ width: 1440, height: 1920 });
    expect(outputSize({ width: 800, height: 600 }, 1920)).toEqual({ width: 800, height: 600 });
    expect(outputSize({ width: 4032, height: 3024 }, null)).toEqual({ width: 4032, height: 3024 });
    expect(outputSize({ width: 5000, height: 3 }, 100)).toEqual({ width: 100, height: 1 });
  });
});

/* ---- images that move -------------------------------------------- */

const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0));
const u32 = (value: number) => [(value >>> 24) & 255, (value >>> 16) & 255, (value >>> 8) & 255, value & 255];
const chunk = (type: string, data: number[] = []) => [...u32(data.length), ...ascii(type), ...data, 0, 0, 0, 0];
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function gif(frames: number, globalTable = false): Uint8Array<ArrayBuffer> {
  const bytes = [...ascii('GIF89a'), 1, 0, 1, 0, globalTable ? 0x80 : 0, 0, 0];
  if (globalTable) bytes.push(0, 0, 0, 255, 255, 255);
  for (let n = 0; n < frames; n += 1) {
    bytes.push(0x21, 0xf9, 4, 0, 10, 0, 0, 0); // graphic control
    bytes.push(0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0); // image descriptor
    bytes.push(2, 2, 0x4c, 0x01, 0); // code size, one sub-block, end
  }
  bytes.push(0x3b);
  return new Uint8Array(bytes);
}

describe('images that move', () => {
  it('finds an animated PNG by its acTL, which comes before the first IDAT', () => {
    const still = new Uint8Array([...PNG_SIGNATURE, ...chunk('IHDR', new Array(13).fill(0)), ...chunk('IDAT', [1, 2]), ...chunk('IEND')]);
    const moving = new Uint8Array([...PNG_SIGNATURE, ...chunk('IHDR', new Array(13).fill(0)), ...chunk('acTL', [0, 0, 0, 2, 0, 0, 0, 0]), ...chunk('IDAT', [1]), ...chunk('IEND')]);
    expect(imageMoves(still)).toBe(false);
    expect(imageMoves(moving)).toBe(true);
  });

  it('counts a GIF’s frames, past its colour table', () => {
    expect(imageMoves(gif(1))).toBe(false);
    expect(imageMoves(gif(2))).toBe(true);
    expect(imageMoves(gif(2, true))).toBe(true);
  });

  it('reads the animation flag of a WebP, and the brand of an AVIF', () => {
    const webp = (flags: number) => new Uint8Array([...ascii('RIFF'), 0, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, flags, 0, 0, 0]);
    expect(imageMoves(webp(0x02))).toBe(true);
    expect(imageMoves(webp(0x10))).toBe(false);
    const avif = (brands: string) => new Uint8Array([0, 0, 0, 8 + brands.length, ...ascii('ftyp'), ...ascii(brands)]);
    expect(imageMoves(avif('avis0000avifmif1'))).toBe(true);
    expect(imageMoves(avif('avif0000avifmif1'))).toBe(false);
  });

  it('calls nothing else moving, however short', () => {
    expect(imageMoves(new Uint8Array([0xff, 0xd8, 0xff]))).toBe(false);
    expect(imageMoves(new Uint8Array([]))).toBe(false);
  });
});

/* ---- converting --------------------------------------------------- */

describe('converting', () => {
  it('writes the WebP next to the original, at the size asked for, and keeps the original', async () => {
    const store = await storeWith({ 'Sky/Orion.png': picture(4032, 3024) });
    const { tools, encoded, closed, opened } = fakeTools();
    const outcomes = await convertImages(store, ['Sky/Orion.png'], { ...WEBP, side: 1920 }, { tools });
    expect(encoded).toEqual([{ type: 'image/webp', width: 1920, height: 1440, quality: 0.8, fill: null }]);
    expect(outcomes).toEqual([{ path: 'Sky/Orion.png', status: 'converted', to: 'Sky/Orion.webp', before: 9, after: 10, replaced: false }]);
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Sky', 'Sky/Orion.png', 'Sky/Orion.webp']);
    expect((await store.readBlob('Sky/Orion.webp')).type).toBe('image/webp');
    expect(closed).toHaveLength(opened());
  });

  it('replaces the original when asked: the new file is written first, then the old one goes', async () => {
    const store = await storeWith({ 'Orion.png': picture(100, 50) });
    const order: string[] = [];
    store.watch((change) => order.push(`${change.type} ${'path' in change ? change.path : ''}`));
    const outcomes = await convertImages(store, ['Orion.png'], { ...WEBP, then: 'replace' }, {
      tools: fakeTools().tools,
      // The workspace moves the tab, the star and the place here, so the remove closes nothing.
      onReplace: (from, to) => order.push(`follow ${from} → ${to}`),
    });
    expect(outcomes[0]).toMatchObject({ status: 'converted', to: 'Orion.webp', replaced: true });
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Orion.webp']);
    expect(order).toEqual(['write Orion.webp', 'follow Orion.png → Orion.webp', 'remove Orion.png']);
  });

  it('writes over the same file when replacing keeps its name', async () => {
    const store = await storeWith({ 'Orion.webp': picture(4000, 2000) });
    const outcomes = await convertImages(store, ['Orion.webp'], { ...WEBP, side: 1280, then: 'replace' }, { tools: fakeTools().tools });
    expect(outcomes[0]).toMatchObject({ status: 'converted', to: 'Orion.webp', replaced: true });
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Orion.webp']);
    expect((await store.readBlob('Orion.webp')).type).toBe('image/webp');
  });

  it('never writes over another file: a taken name gets a number, also between files of one run', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10), 'a.jpg': picture(10, 10), 'a.webp': new Blob(['mine']) });
    const outcomes = await convertImages(store, ['a.png', 'a.jpg'], { ...WEBP, then: 'replace' }, { tools: fakeTools().tools });
    expect(outcomes.map((outcome) => (outcome.status === 'converted' ? outcome.to : outcome.status))).toEqual(['a 2.webp', 'a 3.webp']);
    expect(await blobToText(await store.readBlob('a.webp'))).toBe('mine');
  });

  it('keeping the original in the same format means a second file, never the same one', async () => {
    const store = await storeWith({ 'a.webp': picture(3000, 3000) });
    const outcomes = await convertImages(store, ['a.webp'], { ...WEBP, side: 800 }, { tools: fakeTools().tools });
    expect(outcomes[0]).toMatchObject({ status: 'converted', to: 'a 2.webp', replaced: false });
  });

  it('puts a JPEG over white, since JPEG has no transparency, and gives PNG no quality', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10), 'b.webp': picture(10, 10) });
    const { tools, encoded } = fakeTools();
    await convertImages(store, ['a.png'], { ...WEBP, format: 'jpeg', quality: 0.9 }, { tools });
    await convertImages(store, ['b.webp'], { ...WEBP, format: 'png' }, { tools });
    expect(encoded.map(({ type, quality, fill }) => [type, quality, fill])).toEqual([
      ['image/jpeg', 0.9, '#ffffff'],
      ['image/png', undefined, null],
    ]);
  });

  it('leaves an image that moves as it is, since a still format keeps only its first frame', async () => {
    const store = await storeWith({ 'spin.gif': new Blob([gif(3)], { type: 'image/gif' }) });
    const { tools, encoded } = fakeTools();
    const outcomes = await convertImages(store, ['spin.gif'], WEBP, { tools });
    expect(outcomes).toEqual([{ path: 'spin.gif', status: 'skipped', reason: 'moves' }]);
    expect(encoded).toEqual([]);
  });

  it('skips what wouldn’t get smaller, and what is already in the format at that size, when told to', async () => {
    const store = await storeWith({ 'big.png': picture(10, 10, 100), 'tiny.png': picture(10, 10), 'done.webp': picture(10, 10) });
    const outcomes = await convertImages(store, ['big.png', 'tiny.png', 'done.webp'], WEBP, {
      tools: fakeTools({ size: () => 20 }).tools,
      onlySmaller: true,
    });
    expect(outcomes.map((outcome) => [outcome.path, outcome.status === 'skipped' ? outcome.reason : outcome.status])).toEqual([
      ['big.png', 'converted'],
      ['tiny.png', 'not-smaller'],
      ['done.webp', 'already'],
    ]);
    expect((await store.list()).map((entry) => entry.path)).toEqual(['big.png', 'big.webp', 'done.webp', 'tiny.png']);
  });

  it('says plainly when the browser can’t write the format', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10) });
    const outcomes = await convertImages(store, ['a.png'], WEBP, { tools: fakeTools({ encodes: ['image/jpeg', 'image/png'] }).tools });
    expect(outcomes).toEqual([{ path: 'a.png', status: 'failed', message: 'This browser can’t write WebP images.' }]);
    expect((await store.list()).map((entry) => entry.path)).toEqual(['a.png']);
  });

  it('goes on past an image it can’t open, and says which', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10), 'b.png': picture(10, 10) });
    const outcomes = await convertImages(store, ['a.png', 'b.png'], WEBP, { tools: fakeTools({ failDecode: true }).tools });
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'failed']);
    expect(outcomes[0]).toMatchObject({ message: 'This browser can’t open it.' });
  });

  it('uses a result it was handed, so what was shown is what gets written', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10) });
    const { tools, encoded } = fakeTools();
    const shown = new Blob(['shown'], { type: 'image/webp' });
    await convertImages(store, ['a.png'], WEBP, { tools, prepared: new Map([['a.png', shown]]) });
    expect(encoded).toEqual([]);
    expect(await blobToText(await store.readBlob('a.webp'))).toBe('shown');
  });

  it('reports progress, and stops between images when asked', async () => {
    const store = await storeWith({ 'a.png': picture(10, 10), 'b.png': picture(10, 10), 'c.png': picture(10, 10) });
    const stop = new AbortController();
    const seen: string[] = [];
    const outcomes = await convertImages(store, ['a.png', 'b.png', 'c.png'], WEBP, {
      tools: fakeTools().tools,
      signal: stop.signal,
      onProgress(done, total, path) {
        seen.push(`${done}/${total} ${path}`);
        if (done === 1) stop.abort();
      },
    });
    expect(seen).toEqual(['0/3 a.png', '1/3 b.png']);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['converted', 'converted']);
  });
});

describe('the choices, kept on this device', () => {
  it('come back as they were saved, and fall back to WebP at 80% for anything unreadable', () => {
    const storage = new Map<string, string>();
    const local = { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => void storage.set(key, value) };
    expect(readChoices(local)).toEqual({ format: 'webp', quality: 0.8, side: null, then: 'keep' });
    writeChoices({ format: 'jpeg', quality: 0.65, side: 1920, then: 'replace' }, local);
    expect(readChoices(local)).toEqual({ format: 'jpeg', quality: 0.65, side: 1920, then: 'replace' });
    storage.set('nebula:convert-images', '{"format":"tiff","quality":7,"side":-3,"then":"burn"}');
    expect(readChoices(local)).toEqual({ format: 'webp', quality: 0.8, side: null, then: 'keep' });
  });
});

describe('what it says when it’s done', () => {
  const MB = 1_000_000;
  it('names the file, for one', () => {
    expect(describeConversions([{ path: 'Sky/Orion.png', status: 'converted', to: 'Sky/Orion.webp', before: 3.1 * MB, after: 402_000, replaced: false }])).toBe(
      'Saved “Orion.webp” next to “Orion.png”: 3.1 MB → 402 KB.',
    );
    expect(describeConversions([{ path: 'Orion.png', status: 'converted', to: 'Orion.webp', before: 3.1 * MB, after: 402_000, replaced: true }])).toBe(
      'Replaced “Orion.png” with “Orion.webp”: 3.1 MB → 402 KB.',
    );
    expect(describeConversions([{ path: 'Orion.webp', status: 'converted', to: 'Orion.webp', before: 3.1 * MB, after: 1.2 * MB, replaced: true }])).toBe(
      'Converted “Orion.webp”: 3.1 MB → 1.2 MB.',
    );
    expect(describeConversions([{ path: 'spin.gif', status: 'skipped', reason: 'moves' }])).toBe('“spin.gif” moves, so it stayed as it is.');
    expect(describeConversions([{ path: 'x.avif', status: 'failed', message: 'This browser can’t open it.' }])).toBe('Couldn’t convert “x.avif”: This browser can’t open it.');
  });

  it('counts, for a folder', () => {
    expect(
      describeConversions(
        [
          { path: 'a.png', status: 'converted', to: 'a.webp', before: 30 * MB, after: 6 * MB, replaced: true },
          { path: 'b.png', status: 'converted', to: 'b.webp', before: 22 * MB, after: 3.8 * MB, replaced: true },
          { path: 'c.gif', status: 'skipped', reason: 'moves' },
          { path: 'd.png', status: 'skipped', reason: 'not-smaller' },
          { path: 'e.avif', status: 'failed', message: 'This browser can’t open it.' },
        ],
        { folder: true },
      ),
    ).toBe('Converted 2 images: 52 MB → 9.8 MB. 2 stayed as they were. Couldn’t convert 1: e.avif.');
    expect(describeConversions([{ path: 'c.gif', status: 'skipped', reason: 'moves' }], { folder: true })).toBe('No images were converted: 1 stayed as it was.');
  });
});
