import { unzipSync, zipSync, type Zippable } from 'fflate';
import { describe, expect, it } from 'vitest';
import { blobToBytes } from './bytes';
import { MemoryFileStore } from './memoryStore';
import { ancestors } from './paths';
import type { FileStore } from './types';
import { projectToZip, zipFileName } from './zip';

const encoder = new TextEncoder();
const everyByte = new Uint8Array(256).map((_, index) => index);

async function sampleStore(): Promise<MemoryFileStore> {
  const store = new MemoryFileStore();
  await store.write('README.md', '# Night Sky\n');
  await store.write('Guides/Orion.md', 'Betelgeuse 🌟 and Rigel');
  await store.write('Charts/Star chart — October.pdf', new Blob([everyByte]));
  await store.write('Photos/Winter hexagon.png', new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 255])]));
  await store.mkdir('Empty');
  await store.write('.nebula/project.json', '{"id":"night-sky","name":"Night Sky"}');
  await store.write('.nebula/legacy-metadata.json', '{"a.excalidraw.md":{}}');
  await store.write('.nebula/workspace.json', '{"tabs":["README.md"]}');
  return store;
}

/** Entries as plain arrays: under vitest's vmThreads, fflate's Uint8Arrays and
 * TextEncoder's come from different realms, which toEqual tells apart. */
async function unzip(blob: Blob): Promise<Record<string, number[]>> {
  return Object.fromEntries(Object.entries(unzipSync(await blobToBytes(blob))).map(([name, bytes]) => [name, Array.from(bytes)]));
}

const utf8 = (text: string) => Array.from(encoder.encode(text));

describe('projectToZip', () => {
  it('zips every file byte for byte, with .nebula/project.json but not the workspace state', async () => {
    const store = await sampleStore();
    const entries = await unzip(await projectToZip(store));

    expect(Object.keys(entries).sort()).toEqual(
      [
        '.nebula/legacy-metadata.json',
        '.nebula/project.json',
        'Charts/Star chart — October.pdf',
        'Empty/',
        'Guides/Orion.md',
        'Photos/Winter hexagon.png',
        'README.md',
      ].sort(),
    );
    expect(entries['README.md']).toEqual(utf8('# Night Sky\n'));
    expect(entries['Guides/Orion.md']).toEqual(utf8('Betelgeuse 🌟 and Rigel'));
    expect(entries['Charts/Star chart — October.pdf']).toEqual(Array.from(everyByte));
    expect(entries['Photos/Winter hexagon.png']).toEqual([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
    expect(entries['.nebula/project.json']).toEqual(utf8('{"id":"night-sky","name":"Night Sky"}'));
    expect(entries['Empty/']).toEqual([]);
  });

  it('can put everything in one folder named after the project', async () => {
    const entries = await unzip(await projectToZip(await sampleStore(), { folder: 'Night Sky' }));
    expect(Object.keys(entries).every((name) => name.startsWith('Night Sky/'))).toBe(true);
    expect(entries['Night Sky/Guides/Orion.md']).toEqual(utf8('Betelgeuse 🌟 and Rigel'));
  });

  it('is a zip Blob whose non-ASCII names are flagged as UTF-8, so unzip tools read them right', async () => {
    const blob = await projectToZip(await sampleStore());
    const bytes = await blobToBytes(blob);
    expect(blob.type).toBe('application/zip');
    expect(Array.from(bytes.slice(0, 4))).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const flags: Record<string, number> = {};
    for (let offset = 0; offset < bytes.length - 30; ) {
      if (view.getUint32(offset, true) !== 0x04034b50) break;
      const nameLength = view.getUint16(offset + 26, true);
      const name = new TextDecoder().decode(bytes.slice(offset + 30, offset + 30 + nameLength));
      flags[name] = view.getUint16(offset + 6, true);
      offset += 30 + nameLength + view.getUint16(offset + 28, true) + view.getUint32(offset + 18, true);
    }
    expect(flags['Charts/Star chart — October.pdf'] & 0x800).toBe(0x800);
  });

  it('makes an empty zip of an empty project', async () => {
    expect(await unzip(await projectToZip(new MemoryFileStore()))).toEqual({});
  });
});

describe('zipFileName', () => {
  it('names the download after the project, safely', () => {
    expect(zipFileName('Night Sky')).toBe('Night Sky.zip');
    expect(zipFileName('Plans: 2026/27')).toBe('Plans- 2026-27.zip');
    expect(zipFileName('  ')).toBe('Project.zip');
  });
});

/** The central directory: each entry's name, method, flags, time, CRC and size, in order. */
function centralDirectory(bytes: Uint8Array): Array<{ name: string; method: number; flags: number; time: number; date: number; crc: number; size: number }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = bytes.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end -= 1;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const entries = [];
  for (let index = 0; index < count; index += 1) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const nameLength = view.getUint16(offset + 28, true);
    entries.push({
      name: new TextDecoder().decode(bytes.slice(offset + 46, offset + 46 + nameLength)),
      method: view.getUint16(offset + 10, true),
      // Bit 3: sizes after the data, as any streamed zip writes them.
      flags: view.getUint16(offset + 8, true) & ~0x8,
      time: view.getUint16(offset + 12, true),
      date: view.getUint16(offset + 14, true),
      crc: view.getUint32(offset + 16, true),
      size: view.getUint32(offset + 24, true),
    });
    offset += 46 + nameLength + view.getUint16(offset + 30, true) + view.getUint16(offset + 32, true);
  }
  return entries;
}

/** projectToZip as it was, building the archive in one go with zipSync. */
async function zippedAtOnce(store: FileStore): Promise<Uint8Array> {
  const stored = new Set(['png', 'pdf']);
  const files: Zippable = {};
  const items = await store.list();
  const filled = new Set(items.flatMap((item) => ancestors(item.path)));
  const add = async (path: string, modified?: number) => {
    const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
    files[path] = [await blobToBytes(await store.readBlob(path)), { level: stored.has(ext) ? 0 : 6, ...(modified ? { mtime: new Date(modified) } : {}) }];
  };
  for (const item of items) {
    if (item.type === 'dir') {
      if (!filled.has(item.path)) files[`${item.path}/`] = [new Uint8Array(0), { level: 0 }];
    } else await add(item.path, item.modified);
  }
  for (const path of ['.nebula/project.json', '.nebula/legacy-metadata.json']) await add(path, (await store.stat(path))?.modified);
  return zipSync(files);
}

/** A Blob that can only be read a slice at a time: reading it whole fails. */
function sliceOnly(blob: Blob, slices: number[]): Blob {
  return {
    size: blob.size,
    type: blob.type,
    slice(start?: number, end?: number) {
      slices.push((end ?? blob.size) - (start ?? 0));
      return blob.slice(start, end);
    },
  } as unknown as Blob;
}

function checksum(bytes: ArrayLike<number>): number {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 1) sum = (sum * 31 + bytes[index]) >>> 0;
  return sum;
}

describe('projectToZip, streamed (review finding 25)', () => {
  it('makes the same archive as building it in one go: names, order, methods, UTF-8 flags, times, CRCs and sizes', async () => {
    const store = await sampleStore();
    const streamed = await blobToBytes(await projectToZip(store));
    expect(centralDirectory(streamed)).toEqual(centralDirectory(await zippedAtOnce(store)));
    expect(await unzip(new Blob([streamed as Uint8Array<ArrayBuffer>]))).toEqual(await unzip(new Blob([(await zippedAtOnce(store)) as Uint8Array<ArrayBuffer>])));
  });

  it('reads each file a slice at a time, never whole, so a project with big videos fits', async () => {
    const store = new MemoryFileStore();
    const video = new Uint8Array(2.5 * 1024 * 1024).map((_, index) => (index * 7) % 251);
    await store.write('Videos/launch.mp4', new Blob([video]));
    await store.write('notes.md', 'hello');
    const slices: number[] = [];
    const slicing: FileStore = {
      list: () => store.list(),
      stat: (path) => store.stat(path),
      readText: (path) => store.readText(path),
      readBlob: async (path) => sliceOnly(await store.readBlob(path), slices),
      write: (path, data) => store.write(path, data),
      mkdir: (path) => store.mkdir(path),
      rename: (from, to) => store.rename(from, to),
      remove: (path) => store.remove(path),
      watch: (listener) => store.watch(listener),
    };

    const entries = unzipSync(await blobToBytes(await projectToZip(slicing)));
    expect(entries['Videos/launch.mp4'].length).toBe(video.length);
    expect(checksum(entries['Videos/launch.mp4'])).toBe(checksum(video));
    expect(new TextDecoder().decode(entries['notes.md'])).toBe('hello');
    expect(Math.max(...slices)).toBeLessThanOrEqual(1024 * 1024);
    expect(slices.length).toBeGreaterThanOrEqual(4);
  });
});

describe('projectToZip names (review finding 22)', () => {
  it('maps names that would not unpack on Windows or macOS, keeping every file', async () => {
    const store = new MemoryFileStore();
    const files: Record<string, string> = {
      'CON.txt': 'device name',
      Notes: 'plain',
      'Plans: phase 1?.md': 'reserved characters',
      'README.md': 'upper',
      'Readme.md': 'differs only in case',
      'a|b/inner<1>.md': 'in a folder with a reserved character',
      'report\u202Efdp.exe': 'direction override',
      'notes.': 'trailing dot',
    };
    for (const [path, text] of Object.entries(files)) await store.write(path, text);

    const entries = await unzip(await projectToZip(store));
    expect(Object.keys(entries).sort()).toEqual(['CON_.txt', 'Notes', 'Plans_ phase 1_.md', 'README.md', 'Readme 2.md', 'a_b/inner_1_.md', 'notes 2', 'reportfdp.exe'].sort());
    expect(entries['Readme 2.md']).toEqual(utf8('differs only in case'));
    expect(entries['notes 2']).toEqual(utf8('trailing dot'));
    expect(entries['a_b/inner_1_.md']).toEqual(utf8('in a folder with a reserved character'));
  });

  it('keeps names that unpack anywhere exactly as they are', async () => {
    const entries = await unzip(await projectToZip(await sampleStore()));
    expect(Object.keys(entries)).toContain('Charts/Star chart — October.pdf');
  });
});
