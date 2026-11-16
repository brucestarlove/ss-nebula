import { act, useEffect } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeRegistry, type FakeRegistry } from './dev/fakeRegistry';
import type { TextSession } from './views/shared/textSession';
import { useTextSession } from './views/shared/useTextSession';
import { render, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Reading lane, task 3, in the workspace: a rename or a move in the file tree
// brings the notes' links along, safely, and says so in the status line.

const live: { session: TextSession | null } = { session: null };

function SessionView({ store, entry, projectId }: FileViewProps) {
  const { session, state } = useTextSession(store, entry.path, projectId);
  useEffect(() => {
    live.session = session;
  }, [session]);
  return <p data-testid="probe">{state.status === 'ready' ? entry.path : ''}</p>;
}

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
});

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  live.session = null;
  localStorage.clear();
});

const probe = (container: HTMLElement) => container.querySelector('[data-testid="probe"]')?.textContent ?? '';
const status = (container: HTMLElement) => container.querySelector('.ws-status-text')?.textContent ?? '';

async function start(registry: FakeRegistry) {
  rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
  await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
  await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
  return rendered.container;
}

async function renameInTree(container: HTMLElement, path: string, name: string) {
  const row = container.querySelector<HTMLElement>(`.ws-filetree [role="treeitem"][data-path="${path}"]`)!;
  await act(async () => row.focus());
  await act(async () => {
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
  });
  const input = container.querySelector<HTMLInputElement>('.ws-rename-input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, name);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
}

describe('links follow a rename in the file tree', () => {
  it('rewrites the links in the other notes and says how many', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    const store = registry.stores.get('night-sky')!;
    const container = await start(registry);
    await renameInTree(container, 'Guides/Orion.md', 'Orion, the hunter');
    await waitFor(() => expect(status(container)).toBe('Updated 1 link in 1 note.'));
    expect(await store.readText('Guides/Observing plan.md')).toContain('Notes in [[Orion, the hunter]].');
    expect(await store.readText('README.md')).toContain('[[Observing plan]]');
    expect(await store.readText('Guides/Orion, the hunter.md')).toContain('see the [[Observing plan]]');
  });

  it('the rename stands, and says what it could not do, when a note can’t be written', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    const store = registry.stores.get('night-sky')!;
    const write = store.write.bind(store);
    store.write = async (path, data, options) => {
      if (path === 'Guides/Observing plan.md' && options?.ifUnchanged) throw new Error('disk full');
      return write(path, data, options);
    };
    const container = await start(registry);
    await renameInTree(container, 'Guides/Orion.md', 'Hunter');
    await waitFor(() => expect(status(container)).toContain('Couldn’t update 1 note.'));
    expect(await store.stat('Guides/Hunter.md')).not.toBeNull();
    expect(await store.stat('Guides/Orion.md')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('leaves the note open with unsaved changes as it is, and says so', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    const store = registry.stores.get('night-sky')!;
    const container = await start(registry);
    await act(async () => live.session!.edit('My unsaved thought about [[Orion]].'));
    await renameInTree(container, 'Guides/Orion.md', 'Hunter');
    await waitFor(() => expect(status(container)).toContain('Left 1 note as it was: it has unsaved changes.'));
    expect(live.session!.getState().text).toBe('My unsaved thought about [[Orion]].');
    expect(await store.readText('Guides/Observing plan.md')).toContain('Notes in [[Orion]].');
  });

  it('says nothing when no link needed to change', async () => {
    const registry = createFakeRegistry({ projects: 1 });
    const container = await start(registry);
    await renameInTree(container, 'Photos/Pleiades.png', 'Seven sisters');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200));
    });
    expect(status(container)).toBe('');
  });
});
