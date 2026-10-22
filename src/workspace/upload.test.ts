import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import { isValidPath } from '../files/paths';
import { addFiles, uploadName } from './upload';

const utf8 = new TextEncoder();

function file(name: string, text = name): File {
  return new File([text], name);
}

describe('upload names', () => {
  it('maps a name Windows reserves instead of refusing the file (review finding 22)', () => {
    expect(uploadName('CON.txt')).toEqual({ name: 'CON_.txt' });
    expect(uploadName('draft.')).toEqual({ name: 'draft' });
  });


  it('keeps an ordinary name as it is', () => {
    expect(uploadName('Orion Nebula.jpg')).toEqual({ name: 'Orion Nebula.jpg' });
    expect(uploadName('Été à Montréal.md')).toEqual({ name: 'Été à Montréal.md' });
  });

  it('swaps backslashes, slashes and control characters for _', () => {
    expect(uploadName('C:\\photos\\sky.png')).toEqual({ name: 'C__photos_sky.png' });
    expect(uploadName('a/b.txt')).toEqual({ name: 'a_b.txt' });
    expect(uploadName('tab\there\u0000.txt')).toEqual({ name: 'tab_here_.txt' });
    expect(uploadName('bell\u0007\u009b.txt')).toEqual({ name: 'bell__.txt' });
  });

  it('trims spaces at the ends', () => {
    expect(uploadName('  spaced.txt  ')).toEqual({ name: 'spaced.txt' });
  });

  it('shortens a name over 255 bytes, keeping its extension', () => {
    const long = `${'é'.repeat(200)}.excalidraw.md`;
    const result = uploadName(long);
    expect('name' in result).toBe(true);
    const name = (result as { name: string }).name;
    expect(utf8.encode(name).length).toBeLessThanOrEqual(255);
    expect(name.endsWith('é.excalidraw.md')).toBe(true);
    expect(isValidPath(name)).toBe(true);
  });

  it('refuses names that can’t be kept, saying why', () => {
    for (const name of ['', '   ', '.', '..', '.nebula']) expect(uploadName(name)).toHaveProperty('problem');
  });
});

describe('adding files', () => {
  it('adds every file it can, skips the rest with a message each, and keeps going', async () => {
    const store = createMemoryFileStore({ 'Photos/one.txt': 'old' });
    const result = await addFiles(store, 'Photos', [file('one.txt'), file('back\\slash.txt'), file('..'), file('three.txt')], ['one.txt']);
    expect(result.added).toEqual(['Photos/one 2.txt', 'Photos/back_slash.txt', 'Photos/three.txt']);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toContain('“..”');
    expect(store.peek('Photos/one.txt')).toBe('old');
    expect(await store.readText('Photos/three.txt')).toBe('three.txt');
  });

  it('goes on after a write fails', async () => {
    const store = createMemoryFileStore();
    const write = store.write.bind(store);
    store.write = async (path, data) => {
      if (path === 'two.txt') throw new Error('Disk full');
      return write(path, data);
    };
    const result = await addFiles(store, '', [file('one.txt'), file('two.txt'), file('three.txt')], []);
    expect(result.added).toEqual(['one.txt', 'three.txt']);
    expect(result.skipped).toEqual(['“two.txt”: Disk full.']);
  });
});
