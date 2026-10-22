import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { MemoryFileStore } from '../files/memoryStore';
import { createBrowserRegistry, type BrowserRegistry } from '../files/registry';
import { askToKeepOnFirstEdit } from './keepOnEdit';

let inner: BrowserRegistry;
let ask: Mock<() => void>;
let registry: BrowserRegistry;
let projectId: string;

beforeEach(async () => {
  inner = createBrowserRegistry(new MemoryFileStore());
  projectId = (await inner.create({ name: 'Night Sky', color: '#7c8cff' })).id;
  await (await inner.files(projectId)).write('Guides/Orion.md', '# Orion\n');
  ask = vi.fn<() => void>();
  registry = askToKeepOnFirstEdit(inner, ask);
});

describe('askToKeepOnFirstEdit', () => {
  it('doesn’t ask while files are only opened and read', async () => {
    const store = await registry.open(projectId);
    await store.list();
    expect(await store.readText('Guides/Orion.md')).toBe('# Orion\n');
    await registry.list();
    await registry.current();
    expect(ask).not.toHaveBeenCalled();
  });

  it('doesn’t count what Nebula saves for itself in .nebula/', async () => {
    const store = await registry.open(projectId);
    await store.write('.nebula/workspace.json', '{}\n');
    expect(ask).not.toHaveBeenCalled();
  });

  it('asks once, after the first edit', async () => {
    const store = await registry.open(projectId);
    await store.write('Guides/Orion.md', '# Orion\n\nBetelgeuse\n');
    expect(ask).toHaveBeenCalledTimes(1);
    await store.write('Guides/Orion.md', '# Orion\n\nRigel\n');
    await store.mkdir('Photos');
    expect(ask).toHaveBeenCalledTimes(1);
    expect(await (await inner.files(projectId)).readText('Guides/Orion.md')).toBe('# Orion\n\nRigel\n');
  });

  it('passes an exclusive write through, refusing a file that exists (round 4, F1)', async () => {
    const store = await registry.open(projectId);
    await expect(store.write('Guides/Orion.md', 'over', { exclusive: true })).rejects.toMatchObject({ name: 'FileExistsError' });
    expect(await store.readText('Guides/Orion.md')).toBe('# Orion\n');
    await store.write('Guides/Rigel.md', 'new', { exclusive: true });
    expect(await (await inner.files(projectId)).readText('Guides/Rigel.md')).toBe('new');
  });

  it('counts a rename, a move or a delete as an edit', async () => {
    const store = await registry.open(projectId);
    await store.rename('Guides/Orion.md', 'Guides/Hunter.md');
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('asks when a project is made', async () => {
    await registry.create({ name: 'Field notes', color: '#e0a458' });
    expect(ask).toHaveBeenCalledTimes(1);
    expect((await inner.list()).map((project) => project.name).sort()).toEqual(['Field notes', 'Night Sky']);
  });

  it('asks when a project’s colour or name changes', async () => {
    await registry.update(projectId, { color: '#e0a458' });
    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('keeps going when the browser refuses', async () => {
    const refusing = askToKeepOnFirstEdit(inner, () => Promise.reject(new Error('no')));
    const store = await refusing.open(projectId);
    await expect(store.write('Guides/Orion.md', 'x')).resolves.toBeUndefined();
  });

  it('hears changes through the store it hands out', async () => {
    const store = await registry.open(projectId);
    const heard: string[] = [];
    const stop = store.watch((change) => heard.push(change.type));
    await store.write('Guides/Moon.md', 'Waxing');
    stop();
    expect(heard).toContain('write');
  });
});

describe('what the wrapped registry still says (re-review R5)', () => {
  it('forwards readOnly as it changes: a registry.json from a newer Nebula', async () => {
    const root = new MemoryFileStore();
    const browser = createBrowserRegistry(root);
    const wrapped = askToKeepOnFirstEdit(browser, ask);
    expect(wrapped.readOnly).toBe(false);
    await root.write('registry.json', `${JSON.stringify({ version: 99, projects: [] })}\n`);
    await wrapped.list();
    expect(browser.readOnly).toBe(true);
    expect(wrapped.readOnly).toBe(true);
  });

  it('forwards the tree', () => {
    expect(registry.tree).toBe(inner.tree);
    expect(registry.tree).toBeDefined();
  });
});
