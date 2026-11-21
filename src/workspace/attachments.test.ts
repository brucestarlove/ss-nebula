import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import type { FileEntry, FileStore } from '../files/types';
import { ATTACHMENTS, blobBytes, imageFileName, imageLink, imageMime, isKeptImageType, ownImageName, pastedImageName, writeImageFile } from './attachments';

// The module the canvas and the note editor share to keep an image as a file: its name, its
// create-only write, and the link that names it. Nothing here may write over a file.

const PNG = { mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71, 1, 2, 3]) };
const entry = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' });
const entries = (...paths: string[]) => paths.map(entry);

async function bytesAt(store: FileStore, path: string): Promise<number[]> {
  return Array.from(await blobBytes(await store.readBlob(path)));
}

describe('names', () => {
  it('names a pasted image as Obsidian does, in local time', () => {
    expect(pastedImageName(new Date(2026, 10, 21, 1, 30, 5), 'png')).toBe('Pasted image 20261121013005.png');
    expect(pastedImageName(new Date(2026, 0, 2, 3, 4, 5), 'webp')).toBe('Pasted image 20260102030405.webp');
  });

  it('keeps a dropped file’s own name, with the extension its bytes really have', () => {
    const now = new Date(2026, 10, 21, 1, 30, 0);
    expect(imageFileName('image/png', now, 'Sky.png')).toBe('Sky.png');
    // A name that lies about its type gets the real extension.
    expect(imageFileName('image/jpeg', now, 'Sky.png')).toBe('Sky.jpg');
    expect(imageFileName('image/png', now, 'Sky')).toBe('Sky.png');
  });

  it('turns what would break a `[[ ]]` link into `_`: # | ^ and brackets', () => {
    const now = new Date(2026, 10, 21, 1, 30, 0);
    expect(imageFileName('image/jpeg', now, 'Sky #1.jpg')).toBe('Sky _1.jpg');
    expect(imageFileName('image/png', now, 'a|b^c[d]e.png')).toBe('a_b_c_d_e.png');
  });

  it('falls back to the pasted-image name when the own name can’t be kept', () => {
    const now = new Date(2026, 10, 21, 1, 30, 0);
    expect(imageFileName('image/png', now, '..')).toBe('Pasted image 20261121013000.png');
    expect(imageFileName('image/png', now)).toBe('Pasted image 20261121013000.png');
  });

  it('refuses a type it can’t keep as a file', () => {
    expect(() => imageFileName('image/tiff', new Date())).toThrow();
    expect(() => imageFileName('image/heic', new Date(), 'Sky.heic')).toThrow();
  });

  it('counts a clipboard’s `image.png` as pasted, and a real name as its own', () => {
    expect(ownImageName({ name: 'image.png' })).toBeUndefined();
    expect(ownImageName({ name: 'Image.PNG' })).toBeUndefined();
    expect(ownImageName({ name: 'blob' })).toBeUndefined();
    expect(ownImageName({ name: '' })).toBeUndefined();
    expect(ownImageName({ name: 'Sky.png' })).toBe('Sky.png');
    expect(ownImageName({ name: 'image of the sky.png' })).toBe('image of the sky.png');
  });

  it('knows the types it keeps, by extension and by MIME', () => {
    expect(imageMime('Sky.PNG')).toBe('image/png');
    expect(imageMime('a.jpeg')).toBe('image/jpeg');
    expect(imageMime('a.svg')).toBe('image/svg+xml');
    expect(imageMime('notes.md')).toBeNull();
    expect(imageMime('Photo.tiff')).toBeNull();
    expect(isKeptImageType('image/webp')).toBe(true);
    expect(isKeptImageType('image/tiff')).toBe(false);
    expect(isKeptImageType('application/pdf')).toBe(false);
  });
});

describe('writeImageFile', () => {
  it('writes the bytes into Attachments/, made when needed, and gives the path', async () => {
    const store = createMemoryFileStore({ 'Notes/a.md': 'x' });
    const path = await writeImageFile(store, PNG, { name: 'Sky.png', files: await store.list() });
    expect(path).toBe(`${ATTACHMENTS}/Sky.png`);
    expect(await bytesAt(store, path)).toEqual(Array.from(PNG.bytes));
    expect((await store.stat(ATTACHMENTS))?.type).toBe('dir');
  });

  it('takes a free name when the name is taken, and never writes over the file that is there', async () => {
    const store = createMemoryFileStore({ 'Attachments/Sky.png': new Blob([new Uint8Array([9, 9])]) });
    const path = await writeImageFile(store, PNG, { name: 'Sky.png', files: await store.list() });
    expect(path).toBe('Attachments/Sky 2.png');
    expect(await bytesAt(store, 'Attachments/Sky.png')).toEqual([9, 9]);
  });

  it('takes the next name when another writer took the free one after the folder was listed', async () => {
    const store = createMemoryFileStore();
    // The list it was given is stale: it shows nothing in Attachments/.
    await store.write('Attachments/Sky.png', new Blob([new Uint8Array([7])]));
    await store.write('Attachments/Sky 2.png', new Blob([new Uint8Array([8])]));
    const path = await writeImageFile(store, PNG, { name: 'Sky.png', files: [] });
    expect(path).toBe('Attachments/Sky 3.png');
    expect(await bytesAt(store, 'Attachments/Sky.png')).toEqual([7]);
    expect(await bytesAt(store, 'Attachments/Sky 2.png')).toEqual([8]);
  });

  it('writes every file create-only', async () => {
    const store = createMemoryFileStore();
    const seen: unknown[] = [];
    const spy: FileStore = { ...store, write: (path, data, options) => (seen.push(options), store.write(path, data, options)) };
    await writeImageFile(spy, PNG, { name: 'Sky.png', files: [] });
    expect(seen).toEqual([{ exclusive: true }]);
  });

  it('gives up after 20 names that were all taken meanwhile, writing nothing', async () => {
    const store = createMemoryFileStore();
    let attempts = 0;
    const taken: FileStore = {
      ...store,
      write: async () => {
        attempts += 1;
        throw Object.assign(new Error('exists'), { name: 'FileExistsError' });
      },
    };
    await expect(writeImageFile(taken, PNG, { name: 'Sky.png', files: [] })).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(attempts).toBe(20);
  });

  it('stops at once on any other failure, and says it', async () => {
    const store = createMemoryFileStore();
    let attempts = 0;
    const full: FileStore = {
      ...store,
      write: async () => {
        attempts += 1;
        throw Object.assign(new Error('disk full'), { name: 'QuotaExceededError' });
      },
    };
    await expect(writeImageFile(full, PNG, { name: 'Sky.png', files: [] })).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(attempts).toBe(1);
  });

  it('writes into the folder it is given, not Attachments/', async () => {
    const store = createMemoryFileStore();
    expect(await writeImageFile(store, PNG, { name: 'Sky.png', folder: 'Photos', files: [] })).toBe('Photos/Sky.png');
  });
});

describe('imageLink', () => {
  it('is the bare name while that finds this file alone, else the shortest path that does', () => {
    expect(imageLink('Attachments/Sky.png', entries('Attachments/Sky.png', 'Notes/a.md'))).toBe('Sky.png');
    expect(imageLink('Attachments/Sky.png', entries('Attachments/Sky.png', 'Photos/Sky.png'))).toBe('Attachments/Sky.png');
    expect(imageLink('Photos/Sky.png', entries('Attachments/Sky.png', 'Photos/Sky.png'))).toBe('Photos/Sky.png');
  });
});

describe('blobBytes', () => {
  it('gives a blob’s bytes', async () => {
    expect(Array.from(await blobBytes(new Blob([new Uint8Array([1, 2, 3])])))).toEqual([1, 2, 3]);
  });
});
