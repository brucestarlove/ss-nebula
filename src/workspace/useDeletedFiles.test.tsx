import { afterEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError } from '../files/errors';
import type { DeletedFile, DeletedFilesPage } from '../files/history';
import { ServerError } from '../files/serverStore';
import type { FileStore } from '../files/types';
import { useDeletedFiles, type DeletedFilesState } from './useDeletedFiles';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { act } from 'react';

const file = (path: string): DeletedFile => ({ path, version: `v-${path}`, size: 3, deletedAt: '2026-11-20T10:00:00.000Z' });

type Fake = FileStore & { deletedFiles: ReturnType<typeof vi.fn>; restore: ReturnType<typeof vi.fn> };

/** A server project's store as far as the hook asks: the history calls and the deleted files. */
function fakeStore(pages: (DeletedFilesPage | Error)[], restore: () => Promise<unknown> = async () => ({})): Fake {
  let call = 0;
  return {
    deletedFiles: vi.fn(async () => {
      const next = pages[Math.min(call++, pages.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    }),
    restore: vi.fn(restore),
    versions: vi.fn(),
    readVersion: vi.fn(),
    changes: vi.fn(),
  } as unknown as Fake;
}

let rendered: Rendered | null = null;
let state: DeletedFilesState | undefined;

function Harness(props: { store: FileStore | null; wanted: boolean; restored?: (file: DeletedFile) => void }) {
  state = useDeletedFiles(props.store, props.wanted, props.restored ?? (() => {}));
  return null;
}

async function mount(props: Parameters<typeof Harness>[0]) {
  rendered = await render(<Harness {...props} />);
  return rendered;
}

afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  state = undefined;
});

describe('useDeletedFiles', () => {
  it('asks the server for the list while Settings wants it, and not before', async () => {
    const store = fakeStore([{ files: [file('a.md')], more: false }]);
    const view = await mount({ store, wanted: false });
    await settle(20);
    expect(store.deletedFiles).not.toHaveBeenCalled();
    expect(state?.files).toBeNull();

    await view.rerender(<Harness store={store} wanted />);
    await waitFor(() => expect(state?.files?.map((each) => each.path)).toEqual(['a.md']));
    expect(store.deletedFiles).toHaveBeenCalledTimes(1);
  });

  it('offers nothing for a store with no deleted-file list (a folder, the browser)', async () => {
    await mount({ store: null, wanted: true });
    expect(state).toBeUndefined();
    await rendered?.unmount();
    const plain = { versions: vi.fn(), readVersion: vi.fn(), restore: vi.fn(), changes: vi.fn() } as unknown as FileStore;
    rendered = await render(<Harness store={plain} wanted />);
    expect(state).toBeUndefined();
  });

  it('offers nothing when the server says it does not list them (405)', async () => {
    const store = fakeStore([new ServerError(405, 'not-supported', 'No')]);
    await mount({ store, wanted: true });
    await waitFor(() => expect(store.deletedFiles).toHaveBeenCalled());
    await waitFor(() => expect(state).toBeUndefined());
  });

  it('restores a file with its version, only into an empty path, then reads the list again and tells the caller', async () => {
    const restored = vi.fn();
    const store = fakeStore([{ files: [file('a.md'), file('b.md')], more: false }, { files: [file('b.md')], more: false }]);
    await mount({ store, wanted: true, restored });
    await waitFor(() => expect(state?.files).toHaveLength(2));

    await act(async () => state?.restore(file('a.md')));

    await waitFor(() => expect(state?.files?.map((each) => each.path)).toEqual(['b.md']));
    expect(store.restore).toHaveBeenCalledTimes(1);
    expect(store.restore).toHaveBeenCalledWith('a.md', 'v-a.md', { ifAbsent: true });
    expect(restored).toHaveBeenCalledWith(expect.objectContaining({ path: 'a.md' }));
    expect(state?.busy).toBeNull();
  });

  it('marks a file whose path is taken now, keeps it listed, and tells no one it was restored', async () => {
    const restored = vi.fn();
    const store = fakeStore([{ files: [file('a.md')], more: false }], async () => {
      throw new FileChangedError('a.md');
    });
    await mount({ store, wanted: true, restored });
    await waitFor(() => expect(state?.files).toHaveLength(1));

    await act(async () => state?.restore(file('a.md')));

    await waitFor(() => expect(state?.taken.has('a.md')).toBe(true));
    expect(state?.files?.map((each) => each.path)).toEqual(['a.md']);
    expect(state?.error).toBeNull();
    expect(restored).not.toHaveBeenCalled();
    expect(store.restore).toHaveBeenCalledTimes(1);
  });

  it('says why when a restore fails some other way, and does not mark the file as taken', async () => {
    const store = fakeStore([{ files: [file('a.md')], more: false }], async () => {
      throw new Error('The disk is full');
    });
    await mount({ store, wanted: true });
    await waitFor(() => expect(state?.files).toHaveLength(1));

    await act(async () => state?.restore(file('a.md')));

    await waitFor(() => expect(state?.error).toContain('The disk is full'));
    expect(state?.taken.has('a.md')).toBe(false);
  });

  it('reads the list again when the project changes', async () => {
    const one = fakeStore([{ files: [file('one.md')], more: false }]);
    const two = fakeStore([{ files: [file('two.md')], more: false }]);
    const view = await mount({ store: one, wanted: true });
    await waitFor(() => expect(state?.files?.[0].path).toBe('one.md'));

    await view.rerender(<Harness store={two} wanted />);

    await waitFor(() => expect(state?.files?.[0].path).toBe('two.md'));
  });
});
