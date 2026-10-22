import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memoryStore';
import { DEFAULT_WORKSPACE_STATE, readWorkspaceState, writeWorkspaceState } from './workspaceState';

describe('workspace state (.nebula/workspace.json)', () => {
  it('starts with nothing open when the file is missing', async () => {
    expect(await readWorkspaceState(new MemoryFileStore())).toEqual({ tabs: [], active: null, expanded: [], starred: [] });
    expect(DEFAULT_WORKSPACE_STATE).toEqual({ tabs: [], active: null, expanded: [], starred: [] });
  });

  it('writes the state to .nebula/workspace.json, out of the file list, and reads it back', async () => {
    const store = new MemoryFileStore();
    const state = { tabs: ['Guides/Observing plan.md', 'Sketches/Winter hexagon.excalidraw.md'], active: 'Guides/Observing plan.md', expanded: ['Guides'], starred: ['README.md'] };
    await writeWorkspaceState(store, state);

    expect(await readWorkspaceState(store)).toEqual(state);
    expect(JSON.parse(await store.readText('.nebula/workspace.json'))).toEqual(state);
    expect(await store.list()).toEqual([]);
  });

  it('falls back to nothing open when the file is not JSON', async () => {
    const store = new MemoryFileStore();
    await store.write('.nebula/workspace.json', '{"tabs": [');
    expect(await readWorkspaceState(store)).toEqual(DEFAULT_WORKSPACE_STATE);
    await store.write('.nebula/workspace.json', '[1, 2]');
    expect(await readWorkspaceState(store)).toEqual(DEFAULT_WORKSPACE_STATE);
  });

  it('keeps the valid parts of a damaged file: paths only, no duplicates, an active tab that is open', async () => {
    const store = new MemoryFileStore();
    await store.write(
      '.nebula/workspace.json',
      JSON.stringify({ tabs: ['a.md', 42, '../escape.md', 'a.md', 'b.md'], active: 'gone.md', expanded: 'Guides', starred: ['b.md', null, 'Guides'] }),
    );
    expect(await readWorkspaceState(store)).toEqual({ tabs: ['a.md', 'b.md'], active: null, expanded: [], starred: ['b.md', 'Guides'] });
  });

  it('does not share the default arrays between callers', async () => {
    const first = await readWorkspaceState(new MemoryFileStore());
    first.tabs.push('mutated.md');
    expect((await readWorkspaceState(new MemoryFileStore())).tabs).toEqual([]);
  });
});
