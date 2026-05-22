import { CaptureUpdateAction, Excalidraw, useHandleLibrary } from '@excalidraw/excalidraw';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { LibraryItems, UIAppState } from '@excalidraw/excalidraw/types';
import type { NebulaContext, NebulaContextInput } from './context';
import { resolveNebulaContext } from './context';
import {
  DEFAULT_NEBULA_CANVAS_NAME,
  createEmptyNebulaExcalidrawDocument,
} from './excalidraw/document';
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
import {
  downloadExcalidrawScene,
  downloadNebulaExcalidrawDocument,
  downloadObsidianExcalidrawMarkdown,
  getExcalidrawInteropFilename,
  getNebulaDocumentInteropFilename,
  readExcalidrawSceneFile,
} from './excalidraw/interop';
import { getObsidianExcalidrawInteropFilename } from './excalidraw/obsidianMarkdown';
import { createLocalStorageSceneStore } from './storage/localStorageSceneStore';
import type { CanvasSummary, NebulaExcalidrawDocument, SceneStore } from './storage/types';
import { NebulaShell } from './ui/NebulaShell';
import { useTheme, type ResolvedTheme } from './ui/useTheme';
import { useBackground } from './ui/useBackground';

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

type ExcalidrawInitialData = ReturnType<typeof toInitialData>;

export type NebulaExcalidrawShellProps = {
  context?: NebulaContextInput;
  store?: SceneStore;
  onReady?: () => void;
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

/**
 * Canonical Nebula shell seam for both standalone Vite and future Orbit React
 * island mounts. Excalidraw owns the drawing engine; Nebula owns Orbit context,
 * document wrapping, metadata, persistence adapter wiring, and shell overlays.
 */
export function NebulaExcalidrawShell({ context: contextInput, store, onReady }: NebulaExcalidrawShellProps) {
  const baseContext = useMemo(() => resolveNebulaContext(contextInput), [contextInput]);
  const sceneStore = useMemo(() => store || createLocalStorageSceneStore(), [store]);
  const { resolved, setMode } = useTheme();
  const { isPlain, setFlavor: setBackgroundFlavor, toggleFlavor } = useBackground(resolved);
  const [activeCanvasId, setActiveCanvasId] = useState(baseContext.canvasId);
  useEffect(() => {
    setActiveCanvasId(baseContext.canvasId);
  }, [baseContext.canvasId]);
  const context = useMemo<NebulaContext>(
    () => ({ ...baseContext, canvasId: activeCanvasId }),
    [baseContext, activeCanvasId],
  );
  const fallbackDocument = useMemo(() => createEmptyNebulaExcalidrawDocument(context), [context]);
  const [document, setDocument] = useState<NebulaExcalidrawDocument>(fallbackDocument);
  const documentRef = useRef<NebulaExcalidrawDocument>(fallbackDocument);
  const [isLoaded, setIsLoaded] = useState(false);
  const [canvases, setCanvases] = useState<CanvasSummary[]>([]);
  const [collections, setCollections] = useState<LibraryCollectionsState>(() =>
    loadLibraryCollections(baseContext.boardId),
  );
  const apiRef = useRef<ExcalidrawAPI | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const [excalidrawApi, setExcalidrawApi] = useState<ExcalidrawAPI | null>(null);

  const activeLibraryItems = getActiveCollection(collections).items;

  const persistCollections = useCallback(
    (next: LibraryCollectionsState) => {
      saveLibraryCollections(baseContext.boardId, next);
      setCollections(next);
    },
    [baseContext.boardId],
  );

  // Route any edit to Excalidraw's single library list back into whichever
  // named collection is currently active.
  const applyActiveLibraryItems = useCallback(
    (nextLibraryItems: LibraryItems) => {
      setCollections((current) => {
        const next = setCollectionItems(current, current.activeId, nextLibraryItems);
        saveLibraryCollections(baseContext.boardId, next);
        return next;
      });
    },
    [baseContext.boardId],
  );

  const libraryAdapter = useMemo(
    () => ({
      load() {
        const state = loadLibraryCollections(baseContext.boardId);
        setCollections(state);
        return { libraryItems: getActiveCollection(state).items };
      },
      save({ libraryItems: nextLibraryItems }: { libraryItems: LibraryItems }) {
        applyActiveLibraryItems(nextLibraryItems);
      },
    }),
    [baseContext.boardId, applyActiveLibraryItems],
  );

  useHandleLibrary({
    excalidrawAPI: excalidrawApi as never,
    adapter: libraryAdapter,
    validateLibraryUrl: (libraryUrl: string) =>
      libraryUrl.startsWith('https://libraries.excalidraw.com/libraries/') ||
      libraryUrl.startsWith('https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/'),
  });

  useEffect(() => {
    setCollections(loadLibraryCollections(baseContext.boardId));
  }, [baseContext.boardId]);

  useEffect(() => {
    onReady?.();
  }, [onReady]);

  const refreshCanvases = useCallback(() => {
    sceneStore
      .list(baseContext.boardId)
      .then(setCanvases)
      .catch(() => setCanvases([]));
  }, [sceneStore, baseContext.boardId]);

  useEffect(() => {
    let cancelled = false;
    setIsLoaded(false);

    sceneStore
      .load({ boardId: context.boardId, canvasId: context.canvasId })
      .then((stored) => {
        if (cancelled) return;
        const loaded = stored || fallbackDocument;
        documentRef.current = loaded;
        setDocument(loaded);
      })
      .catch(() => {
        if (cancelled) return;
        documentRef.current = fallbackDocument;
        setDocument(fallbackDocument);
      })
      .finally(() => {
        if (cancelled) return;
        setIsLoaded(true);
        refreshCanvases();
      });

    return () => {
      cancelled = true;
    };
  }, [context.boardId, context.canvasId, fallbackDocument, sceneStore, refreshCanvases]);

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
    [saveDocument],
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

  const currentDocument = useCallback((): NebulaExcalidrawDocument => {
    return nextDocument(documentRef.current, currentScene());
  }, [currentScene]);

  const resetCanvasBackground = useCallback(() => {
    const scene = currentScene();
    const appState = {
      ...sanitizeAppState(scene.appState || {}),
      viewBackgroundColor: CANVAS_BACKGROUND,
    };
    const nextScene = { ...scene, appState };

    apiRef.current?.updateScene?.({ appState });
    saveDocument(nextDocument(documentRef.current, nextScene), { updateState: true });
  }, [currentScene, saveDocument]);

  // Nebula themes own the visible app background. If Excalidraw's native
  // Canvas background picker made the scene opaque, clear it before switching
  // theme/flavor so Starfield, Parchment, white, or black show through again.
  const setNebulaFlavor = useCallback(
    (next: Parameters<typeof setBackgroundFlavor>[0]) => {
      resetCanvasBackground();
      setBackgroundFlavor(next);
    },
    [resetCanvasBackground, setBackgroundFlavor],
  );

  // The sun/moon buttons double as a flavor switch: clicking the inactive theme
  // switches theme; clicking the active theme toggles its background flavor.
  const activateTheme = useCallback(
    (next: ResolvedTheme) => {
      resetCanvasBackground();
      if (next === resolved) toggleFlavor();
      else setMode(next);
    },
    [resolved, resetCanvasBackground, toggleFlavor, setMode],
  );

  const exportNebulaDocument = useCallback(() => {
    downloadNebulaExcalidrawDocument(
      currentDocument(),
      getNebulaDocumentInteropFilename(context.boardSlug, context.boardId, context.canvasId),
    );
  }, [context.boardId, context.boardSlug, context.canvasId, currentDocument]);

  const exportScene = useCallback(() => {
    downloadExcalidrawScene(
      currentScene(),
      getExcalidrawInteropFilename(context.boardSlug, context.boardId, context.canvasId),
    );
  }, [context.boardId, context.boardSlug, context.canvasId, currentScene]);

  const exportObsidianMarkdown = useCallback(() => {
    downloadObsidianExcalidrawMarkdown(
      currentScene(),
      getObsidianExcalidrawInteropFilename(context.boardSlug, context.boardId, context.canvasId),
    );
  }, [context.boardId, context.boardSlug, context.canvasId, currentScene]);

  const importScene = useCallback(async (file: File) => {
    const scene = await readExcalidrawSceneFile(file);
    const imported = nextDocument(documentRef.current, { ...scene, source: scene.source || 'imported.excalidraw' });
    saveDocument(imported, { updateState: true });
    apiRef.current?.updateScene?.({ elements: scene.elements, appState: sanitizeAppState(scene.appState), files: scene.files });
  }, [saveDocument]);

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

  // The top-bar search box opens Excalidraw's native "Find on canvas" panel,
  // where the user types and navigates matches.
  const openCanvasSearch = useCallback(() => {
    apiRef.current?.toggleSidebar?.({ name: 'default', tab: 'search', force: true });
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

  const createCanvas = useCallback(() => {
    if (typeof window === 'undefined') return;
    const name = window.prompt('Name your new canvas', 'Untitled canvas');
    if (name === null) return;
    const canvasId = `canvas-${Date.now().toString(36)}`;
    const created = createEmptyNebulaExcalidrawDocument({ ...baseContext, canvasId }, name.trim() || canvasId);
    saveDocument(created);
    refreshCanvases();
    setActiveCanvasId(canvasId);
  }, [baseContext, saveDocument, refreshCanvases]);

  const boardName = baseContext.boardName || baseContext.boardSlug || DEFAULT_NEBULA_CANVAS_NAME;

  return (
    <NebulaShell
      boardName={boardName}
      canvases={canvases}
      activeCanvasId={context.canvasId}
      onSelectCanvas={setActiveCanvasId}
      onCreateCanvas={createCanvas}
      themeResolved={resolved}
      onActivateTheme={activateTheme}
      isPlain={isPlain}
      setFlavor={setNebulaFlavor}
      onExport={exportScene}
      onExportNebulaDocument={exportNebulaDocument}
      onExportObsidianMarkdown={exportObsidianMarkdown}
      onImport={(file) => void importScene(file)}
      onOpenSearch={openCanvasSearch}
    >
      {isLoaded ? (
        <div ref={canvasRef} className="nebula-canvas" data-nebula-canvas-id={context.canvasId}>
          <Excalidraw
            key={`${context.boardId}:${context.canvasId}`}
            excalidrawAPI={handleApi}
            initialData={toExcalidrawInitialData(toInitialData(document.scene, activeLibraryItems))}
            onChange={handleChange}
            onLibraryChange={handleLibraryChange}
            renderTopRightUI={renderLibraryControls}
            theme={resolved}
            name={document.name}
            libraryReturnUrl={createLibraryReturnUrl()}
            UIOptions={{ canvasActions: { loadScene: false, saveToActiveFile: false } }}
          />
        </div>
      ) : (
        <div className="nebula-loading">Loading Nebula scene…</div>
      )}
    </NebulaShell>
  );
}

export default NebulaExcalidrawShell;
