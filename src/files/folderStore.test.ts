import { describe, expect, it } from 'vitest';
import { FolderFileStore } from './folderStore';
import { MemoryFileStore } from './memoryStore';
import { NESTED_DOT_CASE, registerFileStoreConformance, registerFileStoreTwinConformance } from './storeConformance';

/**
 * The folder tier's store. In the browser it runs over the picked
 * folder's handle with OpfsFileStore (e2e/folder-store.spec.ts runs the same
 * suites there); here it runs over memory, so what it adds is tested apart
 * from the disk.
 */

const vitest = { describe, it };

// Every dot-entry is hidden in a folder (S1), not only the root's .nebula.
registerFileStoreConformance(vitest, 'FolderFileStore over memory', () => new FolderFileStore(new MemoryFileStore()), { skip: [NESTED_DOT_CASE] });
registerFileStoreTwinConformance(vitest, 'FolderFileStore over memory', () => {
  const disk = new MemoryFileStore();
  return [new FolderFileStore(disk), new FolderFileStore(disk.twin())];
});

describe('FolderFileStore', () => {
  it('leaves Chrome’s swap files out of the list: a save on disk writes <name>.crswap and moves it into place', async () => {
    const disk = new MemoryFileStore();
    await disk.write('Notes/Today.md', 'hello');
    await disk.write('Notes/Today.md.crswap', 'hel');
    const store = new FolderFileStore(disk);
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Notes', 'Notes/Today.md']);
  });

  it('hides every dot-entry, a nested .nebula too, and still reaches the root’s .nebula by path', async () => {
    const store = new FolderFileStore(new MemoryFileStore());
    await store.write('.nebula/project.json', '{}');
    await store.write('Guides/.nebula/kept.md', 'hidden in a folder');
    await store.write('note.md', 'note');
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Guides', 'note.md']);
    expect(await store.readText('.nebula/project.json')).toBe('{}');
  });
});
