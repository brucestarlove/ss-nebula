import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { render, waitFor } from '../testing/render';

// The chrome-less mode of NebulaExcalidrawShell (lane C), with Excalidraw
// mocked as in src/nebula/runtimeSmoke.test.tsx.
const excalidraw = vi.hoisted(() => ({ themes: [] as string[], initialData: [] as Array<Record<string, unknown> | undefined> }));

vi.mock('@excalidraw/excalidraw', async () => {
  const React = await import('react');
  type Props = {
    excalidrawAPI?: (api: unknown) => void;
    initialData?: { elements?: unknown[]; appState?: Record<string, unknown>; files?: Record<string, unknown> };
    onChange?: (elements: unknown[], appState: Record<string, unknown>, files: Record<string, unknown>) => void;
    renderTopRightUI?: (isMobile: boolean, appState: Record<string, unknown>) => React.ReactNode;
    theme?: string;
  };
  return {
    CaptureUpdateAction: { NEVER: 'NEVER' },
    Excalidraw({ excalidrawAPI, initialData, onChange, renderTopRightUI, theme }: Props) {
      React.useEffect(() => {
        excalidrawAPI?.({
          getAppState: () => initialData?.appState ?? {},
          getFiles: () => initialData?.files ?? {},
          getSceneElements: () => initialData?.elements ?? [],
          updateLibrary: async ({ libraryItems }: { libraryItems: unknown[] }) => libraryItems,
          updateScene: () => undefined,
          toggleSidebar: () => true,
        });
        onChange?.(initialData?.elements ?? [], initialData?.appState ?? {}, initialData?.files ?? {});
      }, [excalidrawAPI, initialData, onChange]);
      excalidraw.themes.push(theme ?? '');
      excalidraw.initialData.push(initialData as Record<string, unknown> | undefined);
      return React.createElement(
        'section',
        { 'data-mock-excalidraw': 'ready', 'data-theme': theme },
        renderTopRightUI?.(false, { selectedElementIds: {} }),
      );
    },
    useHandleLibrary: () => undefined,
    loadLibraryFromBlob: async () => [],
    mergeLibraryItems: (local: unknown[], other: unknown[]) => [...other, ...local],
    serializeLibraryAsJSON: (items: unknown[]) => JSON.stringify({ type: 'excalidrawlib', version: 2, libraryItems: items }),
  };
});

function sceneStore(elements: unknown[] = [], appState: Record<string, unknown> = {}) {
  const saved: NebulaExcalidrawDocument[] = [];
  return {
    saved,
    load: vi.fn(async ({ boardId, canvasId }: { boardId: string; canvasId: string }) => ({
      type: 'starscape.nebula.excalidraw' as const,
      version: 1 as const,
      boardId,
      canvasId,
      name: 'Winter hexagon',
      updatedAt: new Date(0).toISOString(),
      scene: { type: 'excalidraw' as const, version: 2, source: 'test', elements: elements as never[], appState, files: {} },
      nebula: { ticketLinks: [], missionFrames: [], artifactRefs: [], semanticIndex: {} },
    })),
    save: vi.fn(async (document: NebulaExcalidrawDocument) => {
      saved.push(document);
    }),
    list: vi.fn(async () => []),
  };
}

describe('NebulaExcalidrawShell without chrome', () => {
  beforeEach(() => {
    excalidraw.themes.length = 0;
    excalidraw.initialData.length = 0;
    localStorage.clear();
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.setAttribute('data-bg', 'parchment');
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
        onchange: null,
      })),
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    document.documentElement.removeAttribute('data-theme');
    document.documentElement.removeAttribute('data-bg');
  });

  it('renders only the canvas: no topbar, footer, drawer or dialog', async () => {
    const { NebulaExcalidrawShell } = await import('../../../nebula/NebulaExcalidrawShell');
    const store = sceneStore();
    const view = await render(
      <NebulaExcalidrawShell chrome={false} context={{ boardId: 'night-sky', canvasId: 'Sketches/Winter hexagon.excalidraw.md' }} store={store} />,
    );
    await waitFor(() => expect(view.container.querySelector('[data-mock-excalidraw="ready"]')).not.toBeNull());

    expect(view.container.querySelector('.nebula-app')).toBeNull();
    expect(view.container.querySelector('.nebula-topbar')).toBeNull();
    expect(view.container.querySelector('.frame-footer')).toBeNull();
    expect(document.querySelector('.drawer, dialog')).toBeNull();
    const canvas = view.container.querySelector('.nebula-canvas');
    expect(canvas?.getAttribute('data-nebula-canvas-id')).toBe('Sketches/Winter hexagon.excalidraw.md');
    // Library collections still sit in Excalidraw's top-right corner.
    expect(canvas?.querySelector('.nebula-library-controls')).not.toBeNull();
    expect(store.load).toHaveBeenCalledWith({ boardId: 'night-sky', canvasId: 'Sketches/Winter hexagon.excalidraw.md' });
    await waitFor(() => expect(store.save).toHaveBeenCalled());
    await view.unmount();
  });

  it('follows the page theme instead of owning it', async () => {
    localStorage.setItem('nebula:theme', 'dark');
    localStorage.setItem('nebula:bg-light', 'plain');
    const { NebulaExcalidrawShell } = await import('../../../nebula/NebulaExcalidrawShell');
    const view = await render(<NebulaExcalidrawShell chrome={false} context={{ boardId: 'b', canvasId: 'c' }} store={sceneStore()} />);
    await waitFor(() => expect(view.container.querySelector('[data-mock-excalidraw]')?.getAttribute('data-theme')).toBe('light'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-bg')).toBe('parchment');

    await act(async () => {
      document.documentElement.setAttribute('data-theme', 'dark');
    });
    await waitFor(() => expect(view.container.querySelector('[data-mock-excalidraw]')?.getAttribute('data-theme')).toBe('dark'));
    await view.unmount();
  });

  it('centres a drawing that was saved without a scroll position, as excalidraw.com does', async () => {
    const { NebulaExcalidrawShell } = await import('../../../nebula/NebulaExcalidrawShell');
    const view = await render(<NebulaExcalidrawShell chrome={false} context={{ boardId: 'b', canvasId: 'c' }} store={sceneStore()} />);
    await waitFor(() => expect(view.container.querySelector('[data-mock-excalidraw="ready"]')).not.toBeNull());
    expect(excalidraw.initialData.at(-1)?.scrollToContent).toBe(true);
    await view.unmount();

    // .excalidraw.md files carry Obsidian's default 0, 0: never scrolled.
    const unscrolled = await render(
      <NebulaExcalidrawShell chrome={false} context={{ boardId: 'b', canvasId: 'e' }} store={sceneStore([], { scrollX: 0, scrollY: 0 })} />,
    );
    await waitFor(() => expect(unscrolled.container.querySelector('[data-mock-excalidraw="ready"]')).not.toBeNull());
    expect(excalidraw.initialData.at(-1)?.scrollToContent).toBe(true);
    await unscrolled.unmount();

    const placed = await render(
      <NebulaExcalidrawShell chrome={false} context={{ boardId: 'b', canvasId: 'd' }} store={sceneStore([], { scrollX: 120, scrollY: -40 })} />,
    );
    await waitFor(() => expect(placed.container.querySelector('[data-mock-excalidraw="ready"]')).not.toBeNull());
    expect(excalidraw.initialData.at(-1)?.scrollToContent).toBeUndefined();
    await placed.unmount();
  });

  it('keeps the full shell by default', async () => {
    const { NebulaExcalidrawShell } = await import('../../../nebula/NebulaExcalidrawShell');
    const view = await render(<NebulaExcalidrawShell context={{ boardId: 'b', canvasId: 'c' }} store={sceneStore()} />);
    await waitFor(() => expect(view.container.querySelector('[data-mock-excalidraw="ready"]')).not.toBeNull());
    expect(view.container.querySelector('.nebula-app .nebula-topbar')).not.toBeNull();
    expect(view.container.querySelector('.frame-footer')).not.toBeNull();
    expect(excalidraw.initialData.at(-1)?.scrollToContent).toBeUndefined();
    await view.unmount();
  });
});
