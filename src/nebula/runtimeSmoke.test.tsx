import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NebulaExcalidrawDocument } from './storage/types';

const startStarscape = vi.hoisted(() => vi.fn());
const excalidrawMock = vi.hoisted(() => {
  const state: {
    appState: Record<string, unknown>;
    elements: unknown[];
    files: Record<string, unknown>;
  } = {
    appState: {},
    elements: [],
    files: {},
  };

  return {
    state,
    updateScene: vi.fn(
      (scene: { appState?: Record<string, unknown>; elements?: unknown[]; files?: Record<string, unknown> }) => {
        if (scene.appState) state.appState = { ...state.appState, ...scene.appState };
        if (scene.elements) state.elements = scene.elements;
        if (scene.files) state.files = scene.files;
      },
    ),
  };
});

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('@starlove/ui/starscape', () => ({
  startStarscape,
}));

vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');

  type ExcalidrawMockProps = {
    excalidrawAPI?: (api: unknown) => void;
    initialData?: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
    name?: string;
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => void;
    renderTopRightUI?: (isMobile: boolean, appState: Record<string, unknown>) => React.ReactNode;
    theme?: string;
  };

  return {
    Excalidraw({ excalidrawAPI, initialData, name, onChange, renderTopRightUI, theme }: ExcalidrawMockProps) {
      React.useEffect(() => {
        excalidrawMock.state.appState = initialData?.appState ?? {};
        excalidrawMock.state.elements = initialData?.elements ?? [];
        excalidrawMock.state.files = initialData?.files ?? {};
        excalidrawAPI?.({
          getAppState: () => excalidrawMock.state.appState,
          getFiles: () => excalidrawMock.state.files,
          getSceneElements: () => excalidrawMock.state.elements,
          updateLibrary: vi.fn(async ({ libraryItems }: { libraryItems: unknown[] }) => libraryItems),
          updateScene: excalidrawMock.updateScene,
          toggleSidebar: vi.fn(() => true),
          setToast: vi.fn(),
        });
        onChange?.(initialData?.elements ?? [], initialData?.appState ?? {}, initialData?.files ?? {});
      }, [excalidrawAPI, initialData, onChange]);

      return React.createElement(
        'section',
        {
          'aria-label': 'mock excalidraw canvas',
          'data-nebula-smoke-excalidraw': 'ready',
          'data-theme': theme,
        },
        name ?? 'Nebula canvas',
        renderTopRightUI?.(false, { selectedElementIds: {} }),
      );
    },
    loadLibraryFromBlob: vi.fn(async () => []),
    mergeLibraryItems: vi.fn((localItems: unknown[], otherItems: unknown[]) => [...otherItems, ...localItems]),
    serializeLibraryAsJSON: vi.fn((libraryItems: unknown[]) =>
      JSON.stringify({ type: 'excalidrawlib', version: 2, source: 'test', libraryItems }),
    ),
    useHandleLibrary: vi.fn(),
  };
});

async function flushReact(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await delay(10);
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(assertion: () => void): Promise<void> {
  let lastError: unknown;

  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await flushReact();
    }
  }

  throw lastError;
}

describe('Nebula runtime smoke paths', () => {
  beforeEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    startStarscape.mockClear();
    excalidrawMock.updateScene.mockClear();
    excalidrawMock.state.appState = {};
    excalidrawMock.state.elements = [];
    excalidrawMock.state.files = {};
    localStorage.clear();
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-motion');
    document.documentElement.removeAttribute('data-bg');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        addEventListener: vi.fn(),
        addListener: vi.fn(),
        dispatchEvent: vi.fn(),
        matches: query.includes('prefers-color-scheme: dark'),
        media: query,
        onchange: null,
        removeEventListener: vi.fn(),
        removeListener: vi.fn(),
      })),
    });
    delete window.__NEBULA_CONTEXT__;
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('boots the production standalone entrypoint through the lazy canvas shell and retires the splash', async () => {
    localStorage.setItem('nebula:theme', 'dark');
    localStorage.setItem('nebula:motion', 'full');
    localStorage.setItem('nebula:bg-dark', 'plain');
    document.body.innerHTML = `
      <div id="loader" class="loader" role="status" aria-live="polite">Loading Starscape Canvas…</div>
      <div id="root"></div>
    `;

    await act(async () => {
      await import('../main');
    });
    await waitFor(() => {
      expect(document.querySelector('[data-nebula-smoke-excalidraw="ready"]')).not.toBeNull();
    });

    expect(startStarscape).toHaveBeenCalledTimes(1);
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-motion')).toBe('full');
    expect(document.documentElement.getAttribute('data-bg')).toBe('black');
    await delay(1300);
    expect(document.getElementById('loader')).toBeNull();
  }, 15000);

  it('mounts as a host-embedded island, updates context, and unmounts without owning sibling DOM', async () => {
    const host = document.createElement('main');
    host.innerHTML = `
      <h1 id="suite-title">Suite Dashboard</h1>
      <div id="nebula-island"></div>
      <aside id="suite-sidebar">Host chrome</aside>
    `;
    document.body.append(host);
    const island = document.getElementById('nebula-island');
    if (!island) throw new Error('missing island fixture');

    const onReady = vi.fn();
    const onUnmount = vi.fn();
    const onError = vi.fn();
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async () => undefined),
      list: vi.fn(async () => []),
    };
    const { mountNebula } = await import('./mountNebula');

    let handle: ReturnType<typeof mountNebula> | undefined;
    await act(async () => {
      handle = mountNebula(island, {
        context: { boardId: 'suite-board', boardName: 'Suite Board', canvasId: 'mission-map' },
        lifecycle: { onReady, onUnmount, onError },
        store,
      });
    });
    if (!handle) throw new Error('mountNebula did not return a handle');
    const mountedHandle = handle;

    await expect(mountedHandle.ready).resolves.toBeUndefined();
    expect(onReady).toHaveBeenCalledTimes(1);
    expect(onReady).toHaveBeenCalledWith(mountedHandle);
    expect(onError).not.toHaveBeenCalled();
    expect(mountedHandle.getStatus()).toBe('mounted');
    expect(window.__NEBULA_CONTEXT__).toBeUndefined();
    expect(document.getElementById('suite-title')?.textContent).toBe('Suite Dashboard');
    expect(document.getElementById('suite-sidebar')?.textContent).toBe('Host chrome');
    expect(island.querySelector('.nebula-app')).not.toBeNull();
    await waitFor(() => {
      expect(island.querySelector('.nebula-canvas')?.getAttribute('data-nebula-canvas-id')).toBe('mission-map');
    });

    await act(async () => {
      mountedHandle.update({
        context: { boardId: 'suite-board', boardName: 'Suite Board', canvasId: 'retro' },
        lifecycle: { onReady, onUnmount, onError },
        store,
      });
    });
    await waitFor(() => {
      expect(island.querySelector('.nebula-canvas')?.getAttribute('data-nebula-canvas-id')).toBe('retro');
    });

    await act(async () => {
      mountedHandle.unmount();
    });

    expect(mountedHandle.getStatus()).toBe('unmounted');
    expect(onUnmount).toHaveBeenCalledTimes(1);
    expect(island.innerHTML).toBe('');
    expect(document.getElementById('suite-title')?.textContent).toBe('Suite Dashboard');
    expect(document.getElementById('suite-sidebar')?.textContent).toBe('Host chrome');
  });

  it('resets an opaque Excalidraw canvas background when Nebula theme controls are used', async () => {
    const host = document.createElement('main');
    host.innerHTML = '<div id="nebula-island"></div>';
    document.body.append(host);
    const island = document.getElementById('nebula-island');
    if (!island) throw new Error('missing island fixture');

    const savedDocuments: NebulaExcalidrawDocument[] = [];
    const store = {
      load: vi.fn(async () => null),
      save: vi.fn(async (document: NebulaExcalidrawDocument) => {
        savedDocuments.push(document);
      }),
      list: vi.fn(async () => []),
    };
    const { mountNebula } = await import('./mountNebula');

    let handle: ReturnType<typeof mountNebula> | undefined;
    await act(async () => {
      handle = mountNebula(island, {
        context: { boardId: 'suite-board', boardName: 'Suite Board', canvasId: 'mission-map' },
        store,
      });
    });
    if (!handle) throw new Error('mountNebula did not return a handle');
    const mountedHandle = handle;

    await expect(mountedHandle.ready).resolves.toBeUndefined();
    await waitFor(() => {
      expect(island.querySelector('[data-nebula-smoke-excalidraw="ready"]')).not.toBeNull();
    });

    store.save.mockClear();
    excalidrawMock.updateScene.mockClear();
    excalidrawMock.state.appState = {
      ...excalidrawMock.state.appState,
      viewBackgroundColor: '#f8f9fa',
    };

    const activeThemeButton = Array.from(island.querySelectorAll<HTMLButtonElement>('.nebula-theme-option')).find(
      (button) => button.getAttribute('aria-checked') === 'true',
    );
    if (!activeThemeButton) throw new Error('missing active theme button');

    await act(async () => {
      activeThemeButton.click();
    });

    expect(excalidrawMock.updateScene).toHaveBeenCalledWith({
      appState: expect.objectContaining({ viewBackgroundColor: 'transparent' }),
    });
    const savedDocument = savedDocuments.at(-1);
    expect(savedDocument?.scene.appState?.viewBackgroundColor).toBe('transparent');

    await act(async () => {
      mountedHandle.unmount();
    });
  });
});
