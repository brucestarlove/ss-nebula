import { describe, expect, it } from 'vitest';
import { DiskDir } from './fakeDisk';
import { OpfsFileStore } from './opfsStore';
import type { FileChange } from './types';

/**
 * S13: on a case-insensitive disk (macOS,
 * Windows) `a.md` and `A.md` are one entry, so a rename that changes only
 * case found "the target" and was refused. When source and target are the
 * same entry (isSameEntry) the rename goes through a temporary name, which
 * is visible, never hidden: a crash between the two steps must not hide a
 * person's file. A different file already at the target is still refused.
 */
const locks = { request: (_name: string, _options: unknown, callback: () => Promise<unknown>) => callback() };

function storeOver(root: DiskDir) {
  const store = new OpfsFileStore(root as unknown as FileSystemDirectoryHandle, { fileLocks: locks as never });
  const heard: FileChange[] = [];
  store.watch((change) => heard.push(change));
  return { store, heard };
}

describe('a rename that changes only case', () => {
  it('works on a case-insensitive disk: same file, new case, nothing left behind', async () => {
    const root = DiskDir.root('Notes', { caseInsensitive: true });
    await root.seed('a.md', 'my note');
    const { store, heard } = storeOver(root);
    await store.rename('a.md', 'A.md');
    expect(root.tree()).toEqual(['A.md']);
    expect(await root.read('A.md')).toBe('my note');
    expect((await store.list()).map((entry) => entry.path)).toEqual(['A.md']);
    expect(heard).toEqual([{ type: 'rename', from: 'a.md', to: 'A.md' }]);
  });

  it('works for a folder and what is in it, where the engine can move folders and where it can’t', async () => {
    for (const directoryMove of [true, false]) {
      const root = DiskDir.root('Notes', { caseInsensitive: true, directoryMove });
      await root.seed('docs/one.md', 'one');
      await root.seed('docs/Deep/two.md', 'two');
      const { store } = storeOver(root);
      await store.rename('docs', 'Docs');
      expect(root.tree(), `directoryMove ${directoryMove}`).toEqual(['Docs/', 'Docs/Deep/', 'Docs/Deep/two.md', 'Docs/one.md']);
      expect(await root.read('Docs/Deep/two.md')).toBe('two');
    }
  });

  it('works in a folder, for the file’s own name', async () => {
    const root = DiskDir.root('Notes', { caseInsensitive: true });
    await root.seed('Trips/iceland.md', 'north');
    const { store } = storeOver(root);
    await store.rename('Trips/iceland.md', 'Trips/Iceland.md');
    expect(root.tree()).toEqual(['Trips/', 'Trips/Iceland.md']);
  });

  it('never replaces a different file that has the new name: that is still refused', async () => {
    const root = DiskDir.root('Notes', { caseInsensitive: true });
    await root.seed('a.md', 'mine');
    await root.seed('b.md', 'theirs');
    const { store } = storeOver(root);
    await expect(store.rename('a.md', 'B.md')).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(root.tree()).toEqual(['a.md', 'b.md']);
    expect(await root.read('b.md')).toBe('theirs');
  });

  it('refuses a rename to the same name, and one that also changes the folder’s case', async () => {
    const root = DiskDir.root('Notes', { caseInsensitive: true });
    await root.seed('Docs/a.md', 'a');
    const { store } = storeOver(root);
    await expect(store.rename('Docs/a.md', 'Docs/a.md')).rejects.toMatchObject({ name: 'FileExistsError' });
    await expect(store.rename('Docs/a.md', 'docs/A.md')).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(root.tree()).toEqual(['Docs/', 'Docs/a.md']);
  });

  it('a failure on the way to the new name puts the file back as it was named, and says so', async () => {
    const root = DiskDir.root('Notes', { caseInsensitive: true });
    await root.seed('a.md', 'my note');
    const { store, heard } = storeOver(root);
    root.before = (op, name) => {
      if (op === 'move' && name === 'A.md') {
        root.before = undefined;
        throw new DOMException('disk full', 'QuotaExceededError');
      }
    };
    await expect(store.rename('a.md', 'A.md')).rejects.toMatchObject({ name: 'QuotaExceededError' });
    expect(root.tree()).toEqual(['a.md']);
    expect(await root.read('a.md')).toBe('my note');
    expect(heard).toEqual([]);
  });

  it('on a case-sensitive disk is an ordinary rename, and refuses when the other case is a different file', async () => {
    const root = DiskDir.root('Notes');
    await root.seed('a.md', 'lower');
    const { store } = storeOver(root);
    await store.rename('a.md', 'A.md');
    expect(root.tree()).toEqual(['A.md']);
    await root.seed('a.md', 'another');
    await expect(store.rename('a.md', 'A.md')).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(root.tree()).toEqual(['A.md', 'a.md']);
  });
});
