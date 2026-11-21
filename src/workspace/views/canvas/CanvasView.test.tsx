import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import type { AccountStatus } from '../../../files/account';
import { SignedOutError, SpaceFullError } from '../../../files/serverStore';
import type { FileEntry } from '../../../files/types';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { LazyNebulaExcalidrawShellProps } from '../../../nebula/LazyNebulaExcalidrawShell';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { byLabel, click, render, settle, waitFor } from '../testing/render';
import { ViewActionsContext } from '../shared/viewActions';
import { slowWrites } from '../testing/slowWrites';
import CanvasView from './CanvasView';

// The real shell (and Excalidraw) run in Playwright; here a stand-in loads
// through the store it is given and lets the test draw.
const shell = vi.hoisted(() => ({
  props: null as LazyNebulaExcalidrawShellProps | null,
  loaded: null as NebulaExcalidrawDocument | null,
  /** The element ids of every scene the shell loaded, in order. */
  loads: [] as string[][],
}));

vi.mock('../../../nebula/LazyNebulaExcalidrawShell', async () => {
  const { useEffect } = await import('react');
  return {
    LazyNebulaExcalidrawShell(props: LazyNebulaExcalidrawShellProps) {
      shell.props = props;
      // Like the real shell: load once per store and canvas, then echo the
      // scene as it opened through onChange.
      const { store, context } = props;
      useEffect(() => {
        let cancelled = false;
        void store
          ?.load({ boardId: context?.boardId ?? '', canvasId: context?.canvasId ?? '' })
          .then((document) => {
            if (cancelled || !document) return;
            shell.loaded = document;
            shell.loads.push(document.scene.elements.map((element) => element.id));
            void store.save(document);
          });
        return () => {
          cancelled = true;
        };
      }, [store, context]);
      return <div data-fake-shell="canvas" />;
    },
  };
});

const PATH = 'Sketches/Winter hexagon.excalidraw.md';
const entry: FileEntry = { path: PATH, name: 'Winter hexagon.excalidraw.md', type: 'file', size: 400, modified: 0 };

function rectangle(id: string, version = 1) {
  return { id, type: 'rectangle', x: 0, y: 0, width: 10, height: 10, version, versionNonce: version, isDeleted: false };
}

const SCENE = {
  type: 'excalidraw' as const,
  version: 2,
  source: 'test',
  elements: [rectangle('a'), rectangle('b')],
  appState: { viewBackgroundColor: 'transparent' },
  files: {},
};

async function draw(elements: ReturnType<typeof rectangle>[], zoom = 1) {
  const loaded = shell.loaded!;
  await act(async () => {
    await shell.props!.store!.save({ ...loaded, scene: { ...loaded.scene, elements, appState: { zoom: { value: zoom } } } });
  });
}

describe('CanvasView', () => {
  let store: MemoryFileStore;

  beforeEach(() => {
    shell.props = null;
    shell.loaded = null;
    shell.loads = [];
    store = createMemoryFileStore({ [PATH]: toObsidianExcalidrawMarkdown(SCENE, { compressed: true }) });
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('opens the canvas in the framed board, with the project\u2019s libraries', async () => {
    const view = await render(<CanvasView projectId="night-sky" store={store} entry={entry} kind="canvas" />);
    await waitFor(() => expect(shell.loaded).not.toBeNull());
    const board = view.container.querySelector('.ws-board');
    expect(board?.getAttribute('data-view-of')).toBe('canvas');
    expect(board?.querySelector('[data-fake-shell="canvas"]')).not.toBeNull();
    expect(shell.props?.context).toMatchObject({ boardId: 'night-sky', canvasId: PATH });
    expect(shell.loaded?.scene.elements.map((element) => element.id)).toEqual(['a', 'b']);
    await view.unmount();
  });

  it('reports the element count and zoom, and saves what is drawn', async () => {
    const onStatus = vi.fn();
    const onDirty = vi.fn();
    const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" onStatus={onStatus} onDirty={onDirty} />);
    await waitFor(() => expect(shell.loaded).not.toBeNull());
    await waitFor(() => expect(onStatus).toHaveBeenLastCalledWith('2 elements \u00b7 100%'));

    vi.useFakeTimers();
    await draw([rectangle('a', 2), rectangle('b'), rectangle('c')], 1.25);
    expect(onStatus).toHaveBeenLastCalledWith('3 elements \u00b7 125%');
    expect(onDirty).toHaveBeenLastCalledWith(true);
    expect(store.writes).toHaveLength(0);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(400);
    });
    expect(store.writes).toHaveLength(1);
    expect(readObsidianExcalidrawMarkdown(store.peek(PATH) ?? '').elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
    expect(onDirty).toHaveBeenLastCalledWith(false);
    vi.useRealTimers();
    await view.unmount();
  });

  it('writes a pending drawing when the page hides, and when the tab closes', async () => {
    const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
    await waitFor(() => expect(shell.loaded).not.toBeNull());

    await draw([rectangle('a', 2)]);
    await act(async () => {
      window.dispatchEvent(new Event('pagehide'));
    });
    await waitFor(() => expect(store.writes).toHaveLength(1));

    await draw([rectangle('a', 3)]);
    await view.unmount();
    await waitFor(() => expect(store.writes).toHaveLength(2));
    expect(readObsidianExcalidrawMarkdown(store.peek(PATH) ?? '').elements[0]).toMatchObject({ version: 3 });
  });

  it('reopened while its last save is still being written, it opens with that change', async () => {
    const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
    await waitFor(() => expect(shell.loaded).not.toBeNull());
    await draw([rectangle('a', 2), rectangle('b'), rectangle('c')]);
    const slow = slowWrites(store);
    // Switching to another tab and straight back.
    await view.unmount();
    shell.loads = [];
    const again = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
    await settle(20);
    slow.release();
    await waitFor(() => expect(shell.loads.length).toBeGreaterThan(0));
    expect(shell.loads).toEqual([['a', 'b', 'c']]);
    await again.unmount();
  });

  it('shows the info card, and never the canvas, when the file is not a drawing', async () => {
    store = createMemoryFileStore({ 'Sketches/Broken.excalidraw': '{ not json' });
    const broken: FileEntry = { ...entry, path: 'Sketches/Broken.excalidraw', name: 'Broken.excalidraw' };
    const view = await render(<CanvasView projectId="p" store={store} entry={broken} kind="canvas" />);
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    expect(view.container.querySelector('[data-fake-shell]')).toBeNull();
    expect(store.writes).toHaveLength(0);
    await view.unmount();
  });

  it('offers to open a canvas that won’t load as a note, when the workspace can', async () => {
    store = createMemoryFileStore({ 'Sketches/Broken.excalidraw.md': '# Not a drawing\n\nJust words.' });
    const broken: FileEntry = { ...entry, path: 'Sketches/Broken.excalidraw.md', name: 'Broken.excalidraw.md' };
    const openAs = vi.fn();
    const view = await render(
      <ViewActionsContext.Provider value={{ openAs }}>
        <CanvasView projectId="p" store={store} entry={broken} kind="canvas" />
      </ViewActionsContext.Provider>,
    );
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    const button = byLabel(view.container, 'Open as note');
    expect(button).not.toBeNull();
    await click(button);
    expect(openAs).toHaveBeenCalledWith('note');
    expect(store.writes).toHaveLength(0);
    await view.unmount();
  });

  it('offers nothing more where the workspace can’t switch views', async () => {
    store = createMemoryFileStore({ 'Sketches/Broken.excalidraw.md': 'Just words.' });
    const broken: FileEntry = { ...entry, path: 'Sketches/Broken.excalidraw.md', name: 'Broken.excalidraw.md' };
    const view = await render(<CanvasView projectId="p" store={store} entry={broken} kind="canvas" />);
    await waitFor(() => expect(view.container.querySelector('.ws-info-card')).not.toBeNull());
    expect(byLabel(view.container, 'Open as note')).toBeNull();
    await view.unmount();
  });

  describe('changes made elsewhere', () => {
    const THEIRS = toObsidianExcalidrawMarkdown({ ...SCENE, elements: [rectangle('a'), rectangle('b'), rectangle('theirs')] }, { compressed: true });

    function bar(container: HTMLElement): HTMLElement | null {
      return container.querySelector('.ws-canvas-bar');
    }

    function button(container: HTMLElement, label: string): HTMLButtonElement | undefined {
      return [...container.querySelectorAll<HTMLButtonElement>('.ws-canvas-bar button')].find((item) => item.textContent === label);
    }

    it('reloads the canvas when its file changes elsewhere and nothing here is unsaved', async () => {
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      await waitFor(() => expect(shell.loaded).not.toBeNull());
      await act(async () => {
        await store.write(PATH, THEIRS);
      });
      await waitFor(() => expect(shell.loaded?.scene.elements.map((element) => element.id)).toEqual(['a', 'b', 'theirs']));
      expect(bar(view.container)).toBeNull();
      expect(store.writes).toHaveLength(1);
      await view.unmount();
    });

    it('asks Reload or Keep mine when a drawing here is unsaved, and Keep mine writes it', async () => {
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      await waitFor(() => expect(shell.loaded).not.toBeNull());
      await draw([rectangle('a', 2), rectangle('b'), rectangle('mine')]);
      await act(async () => {
        await store.write(PATH, THEIRS);
      });
      await waitFor(() => expect(bar(view.container)?.textContent).toContain('Changed elsewhere'));
      expect(bar(view.container)?.getAttribute('role')).toBe('alert');
      expect(button(view.container, 'Reload')).toBeDefined();
      await act(async () => {
        button(view.container, 'Keep mine')?.click();
      });
      await waitFor(() => expect(readObsidianExcalidrawMarkdown(store.peek(PATH) ?? '').elements.map((element) => element.id)).toEqual(['a', 'b', 'mine']));
      await waitFor(() => expect(bar(view.container)).toBeNull());
      await view.unmount();
    });

    it('Reload drops the unsaved drawing and shows the file', async () => {
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      await waitFor(() => expect(shell.loaded).not.toBeNull());
      await draw([rectangle('a', 2), rectangle('b'), rectangle('mine')]);
      await act(async () => {
        await store.write(PATH, THEIRS);
      });
      await waitFor(() => expect(button(view.container, 'Reload')).toBeDefined());
      await act(async () => {
        button(view.container, 'Reload')?.click();
      });
      await waitFor(() => expect(shell.loaded?.scene.elements.map((element) => element.id)).toEqual(['a', 'b', 'theirs']));
      expect(bar(view.container)).toBeNull();
      expect(readObsidianExcalidrawMarkdown(store.peek(PATH) ?? '').elements.map((element) => element.id)).toEqual(['a', 'b', 'theirs']);
      await view.unmount();
    });

    it('says plainly when the canvas was deleted elsewhere', async () => {
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      await waitFor(() => expect(shell.loaded).not.toBeNull());
      await act(async () => {
        await store.remove(PATH);
      });
      await waitFor(() => expect(bar(view.container)?.textContent).toBe('Deleted elsewhere. Edits here aren’t saved.'));
      await view.unmount();
    });
  });
  describe('a save the account refuses (signed out, space full)', () => {
    /** The store refuses writes as `refusing` says, and tells whoever listens when it's signed in. */
    function accountStore() {
      const stored = store.write.bind(store);
      const listeners = new Set<(status: AccountStatus) => void>();
      let refusing: Error | null = null;
      store.write = async (path, data, options) => {
        if (refusing) throw refusing;
        await stored(path, data, options);
      };
      Object.assign(store, {
        onAccount(listener: (status: AccountStatus) => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        signedOut: () => (refusing instanceof SignedOutError ? {} : null),
        retryAccount: async () => {},
      });
      return {
        refuse(error: Error | null) {
          refusing = error;
        },
        say: (status: AccountStatus) => [...listeners].forEach((listener) => listener(status)),
      };
    }

    const bar = (container: HTMLElement) => container.querySelector('.ws-canvas-bar');
    const labels = (container: HTMLElement) => [...container.querySelectorAll('.ws-canvas-bar button, .ws-canvas-bar a')].map((item) => item.textContent);

    async function drawRefused(view: Awaited<ReturnType<typeof render>>) {
      await waitFor(() => expect(shell.loaded).not.toBeNull());
      vi.useFakeTimers();
      await draw([rectangle('a', 2), rectangle('b'), rectangle('c')]);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(400);
      });
      vi.useRealTimers();
      await waitFor(() => expect(bar(view.container)).not.toBeNull());
    }

    it('keeps the drawing, offers to sign in again, and saves it by itself once the store says signed-in', async () => {
      const { refuse, say } = accountStore();
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      refuse(new SignedOutError());
      await drawRefused(view);
      expect(labels(view.container)).toEqual(['Sign in again', 'Try again']);
      expect(store.writes).toHaveLength(0);

      refuse(null);
      await act(async () => {
        say('signed-in');
      });
      await waitFor(() => expect(store.writes).toHaveLength(1));
      expect(readObsidianExcalidrawMarkdown(store.peek(PATH) ?? '').elements.map((element) => element.id)).toEqual(['a', 'b', 'c']);
      await waitFor(() => expect(bar(view.container)).toBeNull());
      await view.unmount();
    });

    it('a full space offers a way to more space, and does not save by itself when the store says signed-in', async () => {
      const { refuse, say } = accountStore();
      const view = await render(<CanvasView projectId="p" store={store} entry={entry} kind="canvas" />);
      refuse(new SpaceFullError({ used: 10, limit: 10, upgrade: 'https://suite.test/plans' }));
      await drawRefused(view);
      expect(labels(view.container)).toEqual(['Get more space', 'Try again']);
      refuse(null);
      await act(async () => {
        say('signed-in');
      });
      await settle(50);
      expect(store.writes).toHaveLength(0);
      await act(async () => {
        byLabel(view.container, 'Try again')?.click();
      });
      await waitFor(() => expect(store.writes).toHaveLength(1));
      await view.unmount();
    });
  });
});
