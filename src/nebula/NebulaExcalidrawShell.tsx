import { CaptureUpdateAction, Excalidraw, useHandleLibrary } from '@excalidraw/excalidraw';
import { elementsWithTextLinks } from './excalidraw/textLinks';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExcalidrawProps, LibraryItems, UIAppState } from '@excalidraw/excalidraw/types';
import type { NebulaContext } from './context';
import { createEmptyNebulaExcalidrawDocument } from './excalidraw/document';
import {
  addItemsToCollection,
  createCollection,
  createLibraryItemFromElements,
  createLibraryReturnUrl,
  deleteCollection,
  downloadExcalidrawLibrary,
  EXCALIDRAW_LIBRARY_SUBMIT_URL,
  getActiveCollection,
  getCollection,
  getExcalidrawLibraryPackFilename,
  getSelectedLibraryElements,
  loadLibraryCollections,
  renameCollection,
  saveLibraryCollections,
  setActiveCollection,
  setCollectionItems,
  type LibraryCollectionsState,
} from './excalidraw/library';
import { LibraryControls } from './ui/LibraryControls';
import { normalizeExcalidrawScene, type ExcalidrawScene } from './excalidraw/scene';
import { nameExcalidrawControls } from './excalidraw/controlNames';
import type { NebulaExcalidrawDocument, SceneStore } from './storage/types';
import type { ResolvedTheme } from './ui/useTheme';

type ExcalidrawAPI = {
  id?: string;
  updateScene?: (scene: {
    elements?: ExcalidrawScene['elements'];
    appState?: ExcalidrawScene['appState'];
    files?: ExcalidrawScene['files'];
    captureUpdate?: (typeof CaptureUpdateAction)[keyof typeof CaptureUpdateAction];
  }) => void;
  updateLibrary?: (options: {
    libraryItems: LibraryItems;
    merge?: boolean;
    prompt?: boolean;
    openLibraryMenu?: boolean;
    defaultStatus?: 'published' | 'unpublished';
  }) => Promise<LibraryItems>;
  getSceneElements?: () => ExcalidrawScene['elements'];
  getAppState?: () => ExcalidrawScene['appState'];
  getFiles?: () => ExcalidrawScene['files'];
  toggleSidebar?: (options: { name: string | null; tab?: string; force?: boolean }) => boolean;
  setToast?: (toast: { message: string; closable?: boolean; duration?: number } | null) => void;
};

type ExcalidrawInitialData = ReturnType<typeof toInitialData> & { scrollToContent?: boolean };

export type NebulaExcalidrawShellProps = {
  /** The project and the canvas file: the workspace gives the project's id and
   * the file's path. The library collections are keyed by the project. */
  context: NebulaContext;
  /** Where the canvas is read and saved: the workspace gives the canvas file's own store. */
  store: SceneStore;
  /** Called when an element's link is clicked (Excalidraw's `onLinkOpen`):
   * calling `event.preventDefault()` keeps Excalidraw from opening it as a web
   * address. Nebula's canvas view opens `[[links]]` in the project with it. */
  onLinkOpen?: ExcalidrawProps['onLinkOpen'];
  /** A `[[link]]` written in a text element becomes its link once the text is
   * no longer being edited, as Obsidian Excalidraw does (excalidraw/textLinks.ts).
   * Off by default: it writes to the drawing. */
  linksFromText?: boolean;
  /** Excalidraw's `generateIdForFile`: the canvas view gives one that keeps
   * a dropped image's name for the file it's written to (2.0.4). */
  generateIdForFile?: ExcalidrawProps['generateIdForFile'];
};

function sanitizeAppState(appState: ExcalidrawScene['appState'] = {}): ExcalidrawScene['appState'] {
  // Excalidraw's runtime appState may contain ephemeral collaborators as a Map.
  // JSON persistence turns that into a plain object, which crashes on reload when
  // Excalidraw calls collaborators.forEach. Nebula v1 has no presence layer, so
  // collaborators are deliberately not persisted or rehydrated.
  const rest = { ...appState };
  delete rest.collaborators;
  return rest;
}

// The canvas is transparent in both themes so the app's themed background shows
// through it: the Starscape starfield in dark mode, the parchment surface in
// light. Excalidraw's dark-theme invert filter only touches drawn strokes (the
// transparent fill stays transparent), so the starfield behind renders true.
const CANVAS_BACKGROUND = 'transparent';

function toInitialData(scene: ExcalidrawScene, libraryItems: LibraryItems = []) {
  return {
    elements: scene.elements,
    appState: {
      ...sanitizeAppState(scene.appState),
      // Force transparent over any persisted background so the themed app
      // surface always shows through (a scene saved before this shouldn't
      // reopen with an opaque fill).
      viewBackgroundColor: CANVAS_BACKGROUND,
    },
    files: scene.files || {},
    libraryItems,
  };
}

/** A file saved by another app (or by hand) often has no scroll position,
 * or Obsidian's default 0, 0: open it centred on its content, as
 * excalidraw.com does. */
function hasScrollPosition(scene: ExcalidrawScene): boolean {
  const { scrollX, scrollY } = (scene.appState ?? {}) as { scrollX?: unknown; scrollY?: unknown };
  return Number.isFinite(scrollX) && Number.isFinite(scrollY) && (scrollX !== 0 || scrollY !== 0);
}

function nextDocument(
  current: NebulaExcalidrawDocument,
  scene: ExcalidrawScene,
): NebulaExcalidrawDocument {
  return {
    ...current,
    updatedAt: new Date().toISOString(),
    scene: normalizeExcalidrawScene({
      ...scene,
      appState: sanitizeAppState(scene.appState),
    }),
  };
}

function toExcalidrawElements(elements: readonly unknown[]): ExcalidrawScene['elements'] {
  // Excalidraw's onChange callback is typed upstream, but Nebula keeps this seam
  // package-version tolerant by accepting unknown and asserting only at the edge.
  return [...elements] as ExcalidrawScene['elements'];
}

function toExcalidrawRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {};
}

function toExcalidrawInitialData(initialData: ExcalidrawInitialData): never {
  // @excalidraw/excalidraw v0.18 does not export a stable InitialData type for
  // this package boundary. Keep the cast isolated at the React component seam.
  return initialData as never;
}

const DARK_QUERY = '(prefers-color-scheme: dark)';

function readDocumentTheme(): ResolvedTheme {
  if (typeof document === 'undefined') return 'light';
  const theme = document.documentElement.getAttribute('data-theme');
  if (theme === 'dark' || theme === 'light') return theme;
  return typeof window !== 'undefined' && window.matchMedia?.(DARK_QUERY).matches ? 'dark' : 'light';
}

function subscribeToDocumentTheme(onChange: () => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') return () => undefined;
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = typeof window !== 'undefined' ? window.matchMedia?.(DARK_QUERY) : undefined;
  media?.addEventListener?.('change', onChange);
  return () => {
    observer.disconnect();
    media?.removeEventListener?.('change', onChange);
  };
}

/** The page's resolved theme, read-only: the canvas follows the host
 * instead of owning `data-theme` and `data-bg`. */
function useDocumentTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeToDocumentTheme, readDocumentTheme, () => 'light');
}

/** A store over one file (the workspace's canvas tab) says so: when its load
 * fails, the shell shows the error rather than an empty canvas that would
 * take edits nobody can save. */
function isFileBacked(store: SceneStore): boolean {
  return (store as { fileBacked?: unknown }).fileBacked === true;
}

function loadErrorMessage(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) return error.message || error.name;
  return typeof error === 'string' && error ? error : 'The file couldn’t be read.';
}

/**
 * Nebula's canvas: Excalidraw owns the drawing engine; Nebula owns the
 * document wrapping, metadata, the store wiring, library collections and
 * overlays. It renders the canvas alone, for the workspace's canvas tab, which
 * brings its own frame, and follows the page's theme instead of owning it.
 */
export function NebulaExcalidrawShell({ context, store, onLinkOpen, linksFromText = false, generateIdForFile }: NebulaExcalidrawShellProps) {
  const resolved = useDocumentTheme();
  const sceneStore = store;
  const { boardId, canvasId } = context;
  const fallbackDocument = useMemo(() => createEmptyNebulaExcalidrawDocument({ boardId, canvasId }), [boardId, canvasId]);
  const [document, setDocument] = useState<NebulaExcalidrawDocument>(fallbackDocument);
  const documentRef = useRef<NebulaExcalidrawDocument>(fallbackDocument);
  const [isLoaded, setIsLoaded] = useState(false);
  /** A file-backed load that failed, shown instead of the canvas; Try again
   * counts up `loadAttempt`, which loads once more. */
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const fileBacked = isFileBacked(store);
  const [collections, setCollections] = useState<LibraryCollectionsState>(() =>
    loadLibraryCollections(context.boardId),
  );
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawAPI | null>(null);

  const activeLibraryItems = getActiveCollection(collections).items;

  const persistCollections = useCallback(
    (next: LibraryCollectionsState) => {
      saveLibraryCollections(context.boardId, next);
      setCollections(next);
    },
    [context.boardId],
  );

  // Route any edit to Excalidraw's single library list back into whichever
  // named collection is currently active.
  const applyActiveLibraryItems = useCallback(
    (nextLibraryItems: LibraryItems) => {
      setCollections((current) => {
        const next = setCollectionItems(current, current.activeId, nextLibraryItems);
        saveLibraryCollections(context.boardId, next);
        return next;
      });
    },
    [context.boardId],
  );

  const libraryAdapter = useMemo(
    () => ({
      load() {
        const state = loadLibraryCollections(context.boardId);
        setCollections(state);
        return { libraryItems: getActiveCollection(state).items };
      },
      save({ libraryItems: nextLibraryItems }: { libraryItems: LibraryItems }) {
        applyActiveLibraryItems(nextLibraryItems);
      },
    }),
    [context.boardId, applyActiveLibraryItems],
  );

  useHandleLibrary({
    excalidrawAPI: excalidrawApi as never,
    adapter: libraryAdapter,
    validateLibraryUrl: (libraryUrl: string) =>
      libraryUrl.startsWith('https://libraries.excalidraw.com/libraries/') ||
      libraryUrl.startsWith('https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/'),
  });

  useEffect(() => {
    setCollections(loadLibraryCollections(context.boardId));
  }, [context.boardId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoaded(false);
    setLoadError(null);

    sceneStore
      .load({ boardId: context.boardId, canvasId: context.canvasId })
      .then((stored) => {
        if (cancelled) return;
        const loaded = stored || fallbackDocument;
        documentRef.current = loaded;
        setDocument(loaded);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        if (fileBacked) {
          setLoadError({ error });
          return;
        }
        documentRef.current = fallbackDocument;
        setDocument(fallbackDocument);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoaded(true);
      });

    return () => {
      cancelled = true;
    };
  }, [context.boardId, context.canvasId, fallbackDocument, sceneStore, fileBacked, loadAttempt]);

  const saveDocument = useCallback(
    (next: NebulaExcalidrawDocument, options: { updateState?: boolean } = {}) => {
      documentRef.current = next;
      if (options.updateState) setDocument(next);
      void sceneStore.save(next);
    },
    [sceneStore],
  );

  const handleChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      // [[links]] in text become links once the text is left (not while it is typed):
      // the scene is updated, and its own change event saves it.
      if (linksFromText && apiRef.current?.updateScene && !(appState as { editingTextElement?: unknown } | null)?.editingTextElement) {
        const changed = elementsWithTextLinks(elements as readonly ExcalidrawScene['elements'][number][]);
        if (changed.length > 0) {
          const byId = new Map(changed.map((element) => [element.id, element]));
          apiRef.current.updateScene({
            elements: (elements as ExcalidrawScene['elements']).map((element) => byId.get(element.id) ?? element),
            captureUpdate: CaptureUpdateAction.EVENTUALLY,
          });
          return;
        }
      }
      const excalidrawElements = toExcalidrawElements(elements);
      const nextAppState = sanitizeAppState(toExcalidrawRecord(appState)) || {};
      saveDocument(
        nextDocument(documentRef.current, {
          type: 'excalidraw',
          version: 2,
          source: 'starscape.nebula',
          elements: excalidrawElements,
          appState: nextAppState,
          files: toExcalidrawRecord(files),
        }),
      );
    },
    [saveDocument, linksFromText],
  );

  const handleApi = useCallback((api: unknown) => {
    // Excalidraw's public API type is not exported from v0.18; keep this cast at
    // the callback edge and consume every method through optional chaining.
    const nextApi = api as ExcalidrawAPI;
    apiRef.current = nextApi;
    setExcalidrawApi((currentApi) => {
      if (currentApi === nextApi) return currentApi;
      if (currentApi && nextApi.id && currentApi.id === nextApi.id) return currentApi;
      if (currentApi && !nextApi.id && !currentApi.id) return currentApi;
      return nextApi;
    });
  }, []);

  const handleLibraryChange = useCallback(
    (nextLibraryItems: LibraryItems) => {
      applyActiveLibraryItems(nextLibraryItems);
    },
    [applyActiveLibraryItems],
  );

  const currentScene = useCallback((): ExcalidrawScene => {
    return apiRef.current
      ? {
          type: 'excalidraw' as const,
          version: 2,
          source: 'starscape.nebula',
          elements: apiRef.current.getSceneElements?.() || documentRef.current.scene.elements,
          appState: sanitizeAppState(apiRef.current.getAppState?.() || documentRef.current.scene.appState || {}),
          files: apiRef.current.getFiles?.() || documentRef.current.scene.files || {},
        }
      : documentRef.current.scene;
  }, []);

  // Load a named collection into Excalidraw's single library slot (merge:false
  // replaces the grid). Set active first so the resulting onLibraryChange writes
  // back to the collection we just switched to.
  const loadCollectionIntoExcalidraw = useCallback((items: LibraryItems) => {
    void apiRef.current?.updateLibrary?.({ libraryItems: items, merge: false, openLibraryMenu: true });
  }, []);

  const switchLibrary = useCallback(
    (id: string) => {
      if (id === collections.activeId) return;
      const next = setActiveCollection(collections, id);
      persistCollections(next);
      loadCollectionIntoExcalidraw(getActiveCollection(next).items);
    },
    [collections, persistCollections, loadCollectionIntoExcalidraw],
  );

  const createLibrary = useCallback(
    (name: string) => {
      const { state } = createCollection(collections, name);
      persistCollections(state);
      loadCollectionIntoExcalidraw(getActiveCollection(state).items);
    },
    [collections, persistCollections, loadCollectionIntoExcalidraw],
  );

  const renameLibrary = useCallback(
    (id: string, name: string) => {
      persistCollections(renameCollection(collections, id, name));
    },
    [collections, persistCollections],
  );

  const deleteLibrary = useCallback(
    (id: string) => {
      const next = deleteCollection(collections, id);
      persistCollections(next);
      if (id === collections.activeId) {
        loadCollectionIntoExcalidraw(getActiveCollection(next).items);
      }
    },
    [collections, persistCollections, loadCollectionIntoExcalidraw],
  );

  const selectionLibraryItem = useCallback((name: string) => {
    const scene = currentScene();
    const selectedElementIds = toExcalidrawRecord(scene.appState?.selectedElementIds);
    const selected = getSelectedLibraryElements(scene.elements, selectedElementIds);
    return createLibraryItemFromElements(name, selected);
  }, [currentScene]);

  const addSelectionToLibrary = useCallback(
    (id: string) => {
      const item = selectionLibraryItem('Library item');
      const next = addItemsToCollection(collections, id, [item] as unknown as LibraryItems);
      persistCollections(next);
      if (id === collections.activeId) {
        loadCollectionIntoExcalidraw(getActiveCollection(next).items);
      }
    },
    [collections, persistCollections, loadCollectionIntoExcalidraw, selectionLibraryItem],
  );

  const newLibraryFromSelection = useCallback(
    (name: string) => {
      const item = selectionLibraryItem(name);
      const { state } = createCollection(collections, name, [item] as unknown as LibraryItems);
      persistCollections(state);
      loadCollectionIntoExcalidraw(getActiveCollection(state).items);
    },
    [collections, persistCollections, loadCollectionIntoExcalidraw, selectionLibraryItem],
  );

  const saveLibraryToFile = useCallback(
    (id: string) => {
      const collection = getCollection(collections, id);
      if (!collection) return;
      downloadExcalidrawLibrary(collection.items, getExcalidrawLibraryPackFilename(collection.name));
    },
    [collections],
  );

  // Excalidraw's in-app "Publish library" POSTs to a backend the bundled package
  // doesn't ship, so it can't complete here. Send users to the official
  // submission guide instead; they attach the .excalidrawlib saved from a library.
  const openPublish = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.open(EXCALIDRAW_LIBRARY_SUBMIT_URL, '_blank', 'noopener,noreferrer');
    }
  }, []);

  const panCanvasByClientDelta = useCallback((deltaX: number, deltaY: number) => {
    const api = apiRef.current;
    if (!api) return;

    const appState = api.getAppState?.() || {};
    const zoom = appState.zoom && typeof appState.zoom === 'object' && 'value' in appState.zoom
      ? Number(appState.zoom.value) || 1
      : 1;
    const scrollX = typeof appState.scrollX === 'number' ? appState.scrollX : 0;
    const scrollY = typeof appState.scrollY === 'number' ? appState.scrollY : 0;

    api.updateScene?.({
      appState: {
        scrollX: scrollX + deltaX / zoom,
        scrollY: scrollY + deltaY / zoom,
      },
      captureUpdate: CaptureUpdateAction.NEVER,
    });
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;

    let lastDualMousePoint: { x: number; y: number } | null = null;
    let lastTouchCentroid: { x: number; y: number } | null = null;
    let suppressContextMenuUntil = 0;

    const onPointerDown = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse' || (event.buttons & 3) !== 3) return;
      lastDualMousePoint = { x: event.clientX, y: event.clientY };
      suppressContextMenuUntil = Date.now() + 750;
      event.preventDefault();
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      if ((event.buttons & 3) !== 3) {
        lastDualMousePoint = null;
        return;
      }

      if (lastDualMousePoint) {
        panCanvasByClientDelta(event.clientX - lastDualMousePoint.x, event.clientY - lastDualMousePoint.y);
      }
      lastDualMousePoint = { x: event.clientX, y: event.clientY };
      suppressContextMenuUntil = Date.now() + 750;
      event.preventDefault();
    };

    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType === 'mouse' && (event.buttons & 3) !== 3) {
        lastDualMousePoint = null;
      }
    };

    const getTouchCentroid = (touches: TouchList) => ({
      x: (touches[0].clientX + touches[1].clientX) / 2,
      y: (touches[0].clientY + touches[1].clientY) / 2,
    });

    const onTouchStart = (event: TouchEvent) => {
      if (event.touches.length === 2) {
        lastTouchCentroid = getTouchCentroid(event.touches);
        event.preventDefault();
      } else {
        lastTouchCentroid = null;
      }
    };

    const onTouchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        lastTouchCentroid = null;
        return;
      }

      const centroid = getTouchCentroid(event.touches);
      if (lastTouchCentroid) {
        panCanvasByClientDelta(centroid.x - lastTouchCentroid.x, centroid.y - lastTouchCentroid.y);
      }
      lastTouchCentroid = centroid;
      event.preventDefault();
    };

    const onTouchEnd = (event: TouchEvent) => {
      if (event.touches.length < 2) lastTouchCentroid = null;
    };

    const onContextMenu = (event: MouseEvent) => {
      if (Date.now() < suppressContextMenuUntil) {
        event.preventDefault();
      }
    };

    canvas.addEventListener('pointerdown', onPointerDown, { capture: true });
    canvas.addEventListener('pointermove', onPointerMove, { capture: true });
    canvas.addEventListener('pointerup', onPointerUp, { capture: true });
    canvas.addEventListener('pointercancel', onPointerUp, { capture: true });
    canvas.addEventListener('touchstart', onTouchStart, { passive: false });
    canvas.addEventListener('touchmove', onTouchMove, { passive: false });
    canvas.addEventListener('touchend', onTouchEnd);
    canvas.addEventListener('touchcancel', onTouchEnd);
    canvas.addEventListener('contextmenu', onContextMenu, { capture: true });

    return () => {
      canvas.removeEventListener('pointerdown', onPointerDown, { capture: true });
      canvas.removeEventListener('pointermove', onPointerMove, { capture: true });
      canvas.removeEventListener('pointerup', onPointerUp, { capture: true });
      canvas.removeEventListener('pointercancel', onPointerUp, { capture: true });
      canvas.removeEventListener('touchstart', onTouchStart);
      canvas.removeEventListener('touchmove', onTouchMove);
      canvas.removeEventListener('touchend', onTouchEnd);
      canvas.removeEventListener('touchcancel', onTouchEnd);
      canvas.removeEventListener('contextmenu', onContextMenu, { capture: true });
    };
  }, [panCanvasByClientDelta]);

  // Excalidraw 0.18 leaves its menu trigger unnamed and names the zoom reset
  // without the zoom it shows; name both for screen readers and speech
  // (axe on the canvas tab).
  useEffect(() => {
    const canvas = canvasRef.current;
    return canvas ? nameExcalidrawControls(canvas) : undefined;
  }, [isLoaded]);

  const renderLibraryControls = useCallback(
    (_isMobile: boolean, appState: UIAppState) => {
      const selectedElementIds = toExcalidrawRecord(appState.selectedElementIds);
      const hasSelection = Object.values(selectedElementIds).some(Boolean);
      return (
        <LibraryControls
          collections={collections.collections}
          activeId={collections.activeId}
          hasSelection={hasSelection}
          onSwitch={switchLibrary}
          onCreate={createLibrary}
          onRename={renameLibrary}
          onDelete={deleteLibrary}
          onSaveToFile={saveLibraryToFile}
          onPublish={openPublish}
          onAddSelectionTo={addSelectionToLibrary}
          onNewFromSelection={newLibraryFromSelection}
        />
      );
    },
    [
      collections,
      switchLibrary,
      createLibrary,
      renameLibrary,
      deleteLibrary,
      saveLibraryToFile,
      openPublish,
      addSelectionToLibrary,
      newLibraryFromSelection,
    ],
  );

  const canvas = loadError ? (
    <div className="nebula-loading" data-nebula-load-error="">
      <div className="nebula-error-card" role="alert">
        <p className="nebula-error-eyebrow">This canvas didn’t open</p>
        <p className="nebula-loading__title">Couldn’t read this drawing.</p>
        <p>Nothing was changed. Try again, or it opens by itself when the file changes.</p>
        <pre>{loadErrorMessage(loadError.error)}</pre>
        {/* The canvas lives in the workspace's tab: its buttons. */}
        <button type="button" className="btn-secondary ws-view-btn" data-no-arc onClick={() => setLoadAttempt((count) => count + 1)}>
          Try again
        </button>
      </div>
    </div>
  ) : isLoaded ? (
    <div ref={canvasRef} className="nebula-canvas" data-nebula-canvas-id={context.canvasId}>
      <Excalidraw
        key={`${context.boardId}:${context.canvasId}`}
        excalidrawAPI={handleApi}
        initialData={toExcalidrawInitialData(
          hasScrollPosition(document.scene)
            ? toInitialData(document.scene, activeLibraryItems)
            : { ...toInitialData(document.scene, activeLibraryItems), scrollToContent: true },
        )}
        onChange={handleChange}
        onLibraryChange={handleLibraryChange}
        renderTopRightUI={renderLibraryControls}
        theme={resolved}
        name={document.name}
        libraryReturnUrl={createLibraryReturnUrl()}
        UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
        onLinkOpen={onLinkOpen}
        generateIdForFile={generateIdForFile}
      />
    </div>
  ) : (
    <div className="nebula-loading">Loading Nebula scene…</div>
  );

  return canvas;
}

export default NebulaExcalidrawShell;
