import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memoryStore';
import { scopedStore } from './scopedStore';
import { registerFileStoreConformance } from './storeConformance';
import type { FileChange } from './types';

async function crowdedRoot(): Promise<MemoryFileStore> {
  const root = new MemoryFileStore();
  await root.write('.nebula/root.json', '{}');
  await root.write('projects/b/neighbour.md', 'next door');
  await root.write('projects/ab/prefix-lookalike.md', 'not inside projects/a');
  await root.write('registry.json', '{}');
  return root;
}

registerFileStoreConformance({ describe, it }, 'scopedStore over MemoryFileStore', async () => scopedStore(await crowdedRoot(), 'projects/a'));

describe('scopedStore', () => {
  it('keeps its files under the prefix of the store beneath it', async () => {
    const root = await crowdedRoot();
    const project = scopedStore(root, 'projects/a');
    await project.write('Guides/Orion.md', 'Orion');
    await project.write('.nebula/project.json', '{"name":"A"}');

    expect(await root.readText('projects/a/Guides/Orion.md')).toBe('Orion');
    expect((await root.list()).map((entry) => entry.path)).toContain('projects/a/.nebula/project.json');
    expect((await project.list()).map((entry) => entry.path)).toEqual(['Guides', 'Guides/Orion.md']);
    expect(await project.stat('Guides/Orion.md')).toMatchObject({ path: 'Guides/Orion.md', name: 'Orion.md', type: 'file', size: 5 });
  });

  it('hears changes inside the prefix, in its own paths, and nothing outside it', async () => {
    const root = await crowdedRoot();
    const project = scopedStore(root, 'projects/a');
    const heard: FileChange[] = [];
    const stop = project.watch((change) => heard.push(change));

    await root.write('projects/b/elsewhere.md', 'x');
    await root.write('projects/ab/lookalike.md', 'x');
    await scopedStore(root, 'projects/a').write('Notes/a.md', 'from another view of the same project');
    await root.rename('projects/a/Notes/a.md', 'projects/a/Notes/b.md');
    await root.rename('projects/a/Notes/b.md', 'projects/b/b.md');
    await root.rename('projects/b/b.md', 'projects/a/back.md');
    await root.remove('projects/a');
    stop();
    await root.write('projects/a/after.md', 'unheard');

    expect(heard).toEqual([
      { type: 'write', path: 'Notes/a.md' },
      { type: 'rename', from: 'Notes/a.md', to: 'Notes/b.md' },
      { type: 'remove', path: 'Notes/b.md' },
      { type: 'write', path: 'back.md' },
      // Its own folder removed: everything in it is gone (review finding 23).
      { type: 'remove', path: '' },
    ]);
  });

  it('rejects a prefix that is not a valid path', () => {
    expect(() => scopedStore(new MemoryFileStore(), '../escape')).toThrow(/Invalid path/);
    expect(() => scopedStore(new MemoryFileStore(), '')).toThrow(/Invalid path/);
  });

  it('tells its watchers when its own folder is removed or moved away, as the removal of everything (review finding 23)', async () => {
    const cases: Array<[string, (root: MemoryFileStore) => Promise<void>]> = [
      ['its folder removed', (root) => root.remove('projects/abc')],
      ['a folder above it removed', (root) => root.remove('projects')],
      ['its folder renamed', (root) => root.rename('projects/abc', 'projects/xyz')],
      ['a folder above it renamed', (root) => root.rename('projects', 'archive')],
    ];
    for (const [label, change] of cases) {
      const root = new MemoryFileStore();
      await root.write('projects/abc/a.md', 'A');
      await root.write('projects/other/b.md', 'B');
      const scoped = scopedStore(root, 'projects/abc');
      const heard: FileChange[] = [];
      scoped.watch((heardChange) => heard.push(heardChange));
      await change(root);
      expect(heard, label).toEqual([{ type: 'remove', path: '' }]);
    }
  });

  it('still hears nothing of a sibling folder whose name starts with its own', async () => {
    const root = new MemoryFileStore();
    await root.write('projects/abc/a.md', 'A');
    await root.write('projects/abcdef/b.md', 'B');
    const scoped = scopedStore(root, 'projects/abc');
    const heard: FileChange[] = [];
    scoped.watch((change) => heard.push(change));
    await root.remove('projects/abcdef');
    await root.rename('projects/abc/a.md', 'projects/abc/c.md');
    expect(heard).toEqual([{ type: 'rename', from: 'a.md', to: 'c.md' }]);
  });
});
