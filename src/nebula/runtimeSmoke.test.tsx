import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
    vi.restoreAllMocks();
  });

  it('boots the production standalone entrypoint into the workspace and retires the splash', async () => {
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
    // Since slice 3 the app opens on the workspace (jsdom has no OPFS, so it
    // runs on the in-memory registry), not straight onto a canvas.
    await waitFor(() => {
      expect(document.querySelector('aside.ws-rail')).not.toBeNull();
    });
    expect(document.querySelector('.nebula-error-state')).toBeNull();

    expect(startStarscape).toHaveBeenCalledTimes(1);
    // Excalidraw's fonts come from this site, not esm.sh (finding 20): the
    // build's base read against the page's, so a mounted copy finds them too.
    expect((window as Window & { EXCALIDRAW_ASSET_PATH?: unknown }).EXCALIDRAW_ASSET_PATH).toBe(
      new URL(import.meta.env.BASE_URL, document.baseURI).href,
    );
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.getAttribute('data-motion')).toBe('full');
    expect(document.documentElement.getAttribute('data-bg')).toBe('black');
    await delay(1300);
    expect(document.getElementById('loader')).toBeNull();
  }, 15000);
});
