import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../../../e2e/harness/views-store';
import type { FileEntry } from '../../../files/types';
import { byLabel, click, render, waitFor } from '../testing/render';
import OtherView from './OtherView';

const entry: FileEntry = {
  path: 'Charts/archive.zip',
  name: 'archive.zip',
  type: 'file',
  size: 2_100_000,
  modified: Date.UTC(2026, 9, 22, 3, 5),
};

describe('OtherView', () => {
  let created: Blob[];

  beforeEach(() => {
    created = [];
    URL.createObjectURL = vi.fn((blob: Blob) => {
      created.push(blob);
      return `blob:test/${created.length}`;
    });
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('shows what Nebula knows about the file and reports its size', async () => {
    const store = createMemoryFileStore({ 'Charts/archive.zip': new Blob(['PK']) });
    const onStatus = vi.fn();
    const view = await render(<OtherView projectId="p" store={store} entry={entry} kind="other" onStatus={onStatus} />);

    const card = view.container.querySelector('.ws-info-card');
    expect(card?.querySelector('h2')?.textContent).toBe('archive.zip');
    expect(card?.textContent).toContain('ZIP file');
    expect(card?.textContent).toContain('2.1 MB');
    expect(card?.textContent).toContain('2026');
    expect(onStatus).toHaveBeenLastCalledWith('2.1 MB');
    await view.unmount();
  });

  it('downloads the bytes as opaque data under the file name', async () => {
    const store = createMemoryFileStore({ 'Charts/archive.zip': new Blob(['PK'], { type: 'text/html' }) });
    const clicked: HTMLAnchorElement[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked.push(this);
    });
    const view = await render(<OtherView projectId="p" store={store} entry={entry} kind="other" />);

    await click(byLabel(view.container, 'Download'));
    await waitFor(() => expect(clicked).toHaveLength(1));

    expect(clicked[0].download).toBe('archive.zip');
    expect(clicked[0].href).toBe('blob:test/1');
    expect(created[0].type).toBe('application/octet-stream');
    await view.unmount();
  });

  it('explains when the file could not be opened', async () => {
    const store = createMemoryFileStore({});
    const view = await render(
      <OtherView projectId="p" store={store} entry={entry} kind="note" error={new Error('No file at Charts/archive.zip')} />,
    );

    const alert = view.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toMatch(/Nebula couldn.t open this file/);
    expect(alert?.textContent).toContain('No file at Charts/archive.zip');
    await view.unmount();
  });
});
