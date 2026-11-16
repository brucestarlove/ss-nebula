import { describe, expect, it } from 'vitest';
import { DiskDir } from './fakeDisk';
import { OpfsFileStore } from './opfsStore';

/**
 * S14. Chromium's folder handles have no
 * move() (probed: e2e/folder-store.spec.ts, "directory move()"), so every
 * rename of a folder there is copy-then-remove. That must remove only what
 * it copied and verified, never the source recursively: a file another app
 * adds to the folder meanwhile stays, and a file another app changes
 * meanwhile stops the rename with the source untouched.
 */
const locks = { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() };

async function setup() {
  const root = DiskDir.root('Notes', { directoryMove: 'missing' });
  await root.seed('Folder/a.md', 'a');
  await root.seed('Folder/Deep/b.md', 'b');
  await root.seed('Folder/.hidden', 'dotfile');
  const store = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: locks as never });
  return { root, store };
}
const recursive = (root: DiskDir) => root.calls.filter((call) => call.op === 'removeEntry' && call.recursive);

describe('copy-then-remove, where a folder can’t be moved', () => {
  it('renames a folder with everything in it, hidden files too, and removes nothing recursively', async () => {
    const { root, store } = await setup();
    await store.rename('Folder', 'Moved');
    expect(root.tree()).toEqual(['Moved/', 'Moved/.hidden', 'Moved/Deep/', 'Moved/Deep/b.md', 'Moved/a.md']);
    expect(await root.read('Moved/Deep/b.md')).toBe('b');
    expect(recursive(root)).toEqual([]);
  });

  it('leaves a file another app added during the copy where it is, and the folders it is in', async () => {
    const { root, store } = await setup();
    root.before = async (op, name) => {
      // After each folder was being walked: nothing made now is in the plan.
      if (op !== 'write') return;
      if (name === 'a.md') await root.seed('Folder/Late.md', 'made by another app');
      if (name === 'b.md') await root.seed('Folder/Deep/Later.md', 'also another app’s');
    };
    await store.rename('Folder', 'Moved');
    expect(root.tree()).toEqual(['Folder/', 'Folder/Deep/', 'Folder/Deep/Later.md', 'Folder/Late.md', 'Moved/', 'Moved/.hidden', 'Moved/Deep/', 'Moved/Deep/b.md', 'Moved/a.md']);
    expect(await root.read('Folder/Late.md')).toBe('made by another app');
    expect(recursive(root)).toEqual([]);
  });

  it('a file another app changed after it was copied stops the rename: the source is untouched, the copy removed', async () => {
    const { root, store } = await setup();
    root.before = async (op, name) => {
      if (op !== 'write' || name !== 'b.md') return;
      root.before = undefined;
      await root.seed('Folder/a.md', 'changed by another app, after it was copied');
    };
    await expect(store.rename('Folder', 'Moved')).rejects.toMatchObject({ name: 'MoveChangedError' });
    expect(root.tree()).toEqual(['Folder/', 'Folder/.hidden', 'Folder/Deep/', 'Folder/Deep/b.md', 'Folder/a.md']);
    expect(await root.read('Folder/a.md')).toBe('changed by another app, after it was copied');
    expect(recursive(root)).toEqual([]);
    expect(root.calls.filter((call) => call.op === 'removeEntry' && call.dir === 'Folder')).toEqual([]);
  });

  it('a failure while copying removes only what it copied: the source stays, and so does what another app put in the new place', async () => {
    const { root, store } = await setup();
    root.before = async (op, name) => {
      if (op === 'write' && name === 'a.md') {
        // Another app makes a file in the new folder, where this rename is about to copy to.
        await root.seed('Moved/Deep/b.md', 'theirs');
      }
    };
    await expect(store.rename('Folder', 'Moved')).rejects.toMatchObject({ name: 'FileExistsError' });
    root.before = undefined;
    expect(await root.read('Moved/Deep/b.md')).toBe('theirs');
    expect(root.tree().filter((path) => path.startsWith('Folder'))).toEqual(['Folder/', 'Folder/.hidden', 'Folder/Deep/', 'Folder/Deep/b.md', 'Folder/a.md']);
    // What it copied is gone; what was another app's stays.
    expect(root.tree().filter((path) => path.startsWith('Moved'))).toEqual(['Moved/', 'Moved/Deep/', 'Moved/Deep/b.md']);
    expect(recursive(root)).toEqual([]);
  });

  it('a write that fails midway leaves the source whole and the new place empty', async () => {
    const { root, store } = await setup();
    root.before = (op, name) => {
      if (op === 'write' && name === 'b.md') throw new DOMException('disk full', 'QuotaExceededError');
    };
    await expect(store.rename('Folder', 'Moved')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(root.tree()).toEqual(['Folder/', 'Folder/.hidden', 'Folder/Deep/', 'Folder/Deep/b.md', 'Folder/a.md']);
    expect(recursive(root)).toEqual([]);
  });

  it('a file that is renamed this way too keeps its bytes', async () => {
    const root = DiskDir.root('Notes', { directoryMove: 'missing' });
    await root.seed('a.md', 'my note');
    const store = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: locks as never });
    await store.rename('a.md', 'b.md');
    expect(root.tree()).toEqual(['b.md']);
    expect(await root.read('b.md')).toBe('my note');
  });
});
