import { Suspense } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../../e2e/harness/views-store';
import type { FileEntry, FileKind, FileViewProps } from '../../files/types';
import { viewFor, withFallback } from './index';
import { render, waitFor } from './testing/render';

const KINDS: FileKind[] = ['note', 'canvas', 'image', 'pdf', 'audio', 'video', 'text', 'other'];
const LAZY = Symbol.for('react.lazy');

describe('viewFor', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('gives every kind its own lazy view, the same one on every call', () => {
    const views = KINDS.map((kind) => viewFor(kind));
    for (const [index, kind] of KINDS.entries()) {
      expect((views[index] as unknown as { $$typeof: symbol }).$$typeof).toBe(LAZY);
      expect(viewFor(kind)).toBe(views[index]);
    }
    expect(new Set(views).size).toBe(KINDS.length);
  });

  it('loads the info card for other files', async () => {
    const entry: FileEntry = { path: 'archive.zip', name: 'archive.zip', type: 'file', size: 10, modified: 0 };
    const store = createMemoryFileStore({ 'archive.zip': 'PK' });
    const View = viewFor('other');
    const view = await render(
      <Suspense fallback={<p>loading</p>}>
        <View projectId="p" store={store} entry={entry} kind="other" />
      </Suspense>,
    );
    await waitFor(() => expect(view.container.querySelector('.ws-info-card h2')?.textContent).toBe('archive.zip'));
    await view.unmount();
  });
});

describe('withFallback', () => {
  it('shows the info card, with the error, when a view crashes', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const entry: FileEntry = { path: 'Broken.md', name: 'Broken.md', type: 'file', size: 3, modified: 0 };
    const store = createMemoryFileStore({ 'Broken.md': 'abc' });
    function Crashing(props: FileViewProps): never {
      throw new Error(`Bad markdown in ${props.entry.name}`);
    }
    const Guarded = withFallback(Crashing);
    const view = await render(<Guarded projectId="p" store={store} entry={entry} kind="note" />);

    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    expect(view.container.querySelector('[role="alert"]')?.textContent).toContain('Bad markdown in Broken.md');
    await view.unmount();
  });
});
