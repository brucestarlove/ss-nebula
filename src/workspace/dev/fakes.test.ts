import { describe, expect, it } from 'vitest';
import type { FileChange } from '../../files/types';
import { createFakeRegistry } from './fakeRegistry';
import { MemoryStore } from './memoryStore';

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('MemoryStore (dev fake)', () => {
  it('lists files and the folders above them by path, hiding .nebula', async () => {
    const store = new MemoryStore();
    await store.write('Guides/Orion.md', '# Orion');
    await store.write('.nebula/workspace.json', '{}');
    await store.write('README.md', 'hi');
    const entries = await store.list();
    expect(entries.map((entry) => [entry.path, entry.type])).toEqual([
      ['Guides', 'dir'],
      ['Guides/Orion.md', 'file'],
      ['README.md', 'file'],
    ]);
    expect(await store.readText('.nebula/workspace.json')).toBe('{}');
    expect(entries[1].size).toBe(7);
  });

  it('moves a folder with everything in it, and refuses to overwrite', async () => {
    const store = new MemoryStore();
    await store.write('Guides/Orion.md', 'a');
    await store.write('Notes/x.md', 'b');
    await expect(store.rename('Guides', 'Notes')).rejects.toThrow();
    await store.rename('Guides', 'Archive/Guides');
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Archive', 'Archive/Guides', 'Archive/Guides/Orion.md', 'Notes', 'Notes/x.md']);
  });

  it('removes a folder and everything in it', async () => {
    const store = new MemoryStore();
    await store.write('Guides/Deep/M42.md', 'a');
    await store.write('README.md', 'b');
    await store.remove('Guides');
    expect((await store.list()).map((entry) => entry.path)).toEqual(['README.md']);
    expect(await store.stat('Guides/Deep/M42.md')).toBeNull();
    await expect(store.readText('Guides/Deep/M42.md')).rejects.toThrow();
  });

  it('tells watchers about every change', async () => {
    const store = new MemoryStore();
    const seen: FileChange[] = [];
    const stop = store.watch((change) => seen.push(change));
    await store.write('a.md', '1');
    await store.mkdir('F');
    await store.rename('a.md', 'F/a.md');
    await store.remove('F');
    await flush();
    stop();
    await store.write('b.md', '2');
    await flush();
    expect(seen).toEqual([
      { type: 'write', path: 'a.md' },
      { type: 'mkdir', path: 'F' },
      { type: 'rename', from: 'a.md', to: 'F/a.md' },
      { type: 'remove', path: 'F' },
    ]);
  });
});

describe('createFakeRegistry (dev fake)', () => {
  it('seeds Night Sky and four more projects, most recently opened first', async () => {
    const registry = createFakeRegistry({ projects: 5 });
    const projects = await registry.list();
    expect(projects.map((project) => project.name)).toEqual(['Night Sky', 'Starscape Biz', 'Orbit', 'Pulse', 'Earth Village']);
    expect(await registry.current()).toBe(projects[0].id);
    const store = await registry.open(projects[0].id);
    const paths = (await store.list()).map((entry) => entry.path);
    expect(paths).toContain('Guides/Observing plan.md');
    expect(paths).toContain('Sketches/Winter hexagon.excalidraw.md');
    expect(paths).toContain('README.md');
  });

  it('opens, creates, updates and removes projects', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    const created = await registry.create({ name: 'Field notes', color: '#fbbf24' });
    expect(created).toMatchObject({ name: 'Field notes', color: '#fbbf24', tier: 'browser', createdBy: 'nebula' });
    await registry.open(created.id);
    expect(await registry.current()).toBe(created.id);
    expect((await registry.list())[0].id).toBe(created.id);
    expect(await registry.update(created.id, { color: '#fb7a5a' })).toMatchObject({ color: '#fb7a5a' });
    await registry.remove(created.id);
    expect((await registry.list()).map((project) => project.name)).toEqual(['Night Sky']);
  });
});
