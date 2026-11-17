import { CaptureUpdateAction, Excalidraw, useHandleLibrary } from '@excalidraw/excalidraw';
import { elementsWithTextLinks } from './excalidraw/textLinks';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ExcalidrawProps, LibraryItems, UIAppState } from '@excalidraw/excalidraw/types';
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
import { nameExcalidrawControls } from './excalidraw/controlNames';
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

type ExcalidrawInitialData = ReturnType<typeof toInitialData> & { scrollToContent?: boolean };

export type NebulaExcalidrawShellProps = {
  context?: NebulaContextInput;
  store?: SceneStore;
  onReady?: () => void;
  /**
   * `false` renders only the canvas: Excalidraw with Nebula's library
   * collections (keyed by `context.boardId`), find on canvas (Excalidraw's own
   * search) and the canvas pan gestures, without NebulaShell's topbar, footer,
   * settings drawer and about dialog. The canvas then follows the page's theme
   * (`<html data-theme>`, else the system's) instead of owning it, and writes
   * no theme or background state. Defaults to `true`: the full shell.
   */
  chrome?: boolean;
  /** Called when an element's link is clicked (Excalidraw's `onLinkOpen`):
   * calling `event.preventDefault()` keeps Excalidraw from opening it as a web
   * address. Nebula's canvas view opens `[[links]]` in the project with it. */
  onLinkOpen?: ExcalidrawProps['onLinkOpen'];
  /** A `[[link]]` written in a text element becomes its link once the text is
   * no longer being edited, as Obsidian Excalidraw does (excalidraw/textLinks.ts).
   * Off by default: it writes to the drawing. */
  linksFromText?: boolean;
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

/** The page's resolved theme, read-only: the chrome-less canvas follows the
 * host instead of owning `data-theme` and `data-bg`. */
function useDocumentTheme(): ResolvedTheme {
  return useSyncExternalStore(subscribeToDocumentTheme, readDocumentTheme, () => 'light');
}

/**
 * Canonical Nebula shell seam for both standalone Vite and future Orbit React
 * island mounts. Excalidraw owns the drawing engine; Nebula owns Orbit context,
 * document wrapping, metadata, persistence adapter wiring, and shell overlays.
 * With `chrome={false}` it renders the canvas alone, for hosts that bring
 * their own frame (the workspace's canvas tab).
 */
export function NebulaExcalidrawShell(props: NebulaExcalidrawShellProps) {
  return props.chrome === false ? <ChromelessNebulaCanvas {...props} /> : <ChromeNebulaShell {...props} />;
}

function ChromelessNebulaCanvas(props: NebulaExcalidrawShellProps) {
  const resolved = useDocumentTheme();
  return useNebulaCanvas(props, resolved).canvas;
}

function ChromeNebulaShell(props: NebulaExcalidrawShellProps) {
  const { resolved, setMode } = useTheme();
  const { isPlain, setFlavor: setBackgroundFlavor, toggleFlavor } = useBackground(resolved);
  const {
    canvas,
    boardName,
    canvases,
    context,
    setActiveCanvasId,
    createCanvas,
    resetCanvasBackground,
    exportScene,
    exportNebulaDocument,
    exportObsidianMarkdown,
    importScene,
    openCanvasSearch,
  } = useNebulaCanvas(props, resolved);

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
      {canvas}
    </NebulaShell>
  );
}

/** A store over one file (the workspace's canvas tab) says so: when its load
 * fails, the shell shows the error rather than an empty canvas that would
 * take edits nobody can save. A 1.x board's store keeps the
 * empty canvas. */
function isFileBacked(store: SceneStore | undefined): boolean {
  return (store as { fileBacked?: unknown } | undefined)?.fileBacked === true;
}

function loadErrorMessage(error: unknown): string {
  if (error instanceof Error || error instanceof DOMException) return error.message || error.name;
  return typeof error === 'string' && error ? error : 'The file couldn’t be read.';
}

/** Everything but the chrome: the scene, persistence, libraries, gestures and
 * the Excalidraw element itself. */
function useNebulaCanvas({ context: contextInput, store, onReady, chrome = true, onLinkOpen, linksFromText = false }: NebulaExcalidrawShellProps, resolved: ResolvedTheme) {
  const baseContext = useMemo(() => resolveNebulaContext(contextInput), [contextInput]);
  const sceneStore = useMemo(() => store || createLocalStorageSceneStore(), [store]);
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
  /** A file-backed load that failed, shown instead of the canvas; Try again
   * counts up `loadAttempt`, which loads once more. */
  const [loadError, setLoadError] = useState<{ error: unknown } | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const fileBacked = isFileBacked(store);
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
        refreshCanvases();
      });

    return () => {
      cancelled = true;
    };
  }, [context.boardId, context.canvasId, fallbackDocument, sceneStore, refreshCanvases, fileBacked, loadAttempt]);

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

  const canvas = loadError ? (
    <div className="nebula-loading" data-nebula-load-error="">
      <div className="nebula-error-card" role="alert">
        <p className="nebula-error-eyebrow">This canvas didn’t open</p>
        <p className="nebula-loading__title">Couldn’t read this drawing.</p>
        <p>Nothing was changed. Try again, or it opens by itself when the file changes.</p>
        <pre>{loadErrorMessage(loadError.error)}</pre>
        {/* The chrome-less canvas lives in the workspace's tab: its buttons. */}
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
          chrome || hasScrollPosition(document.scene)
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
      />
    </div>
  ) : (
    <div className="nebula-loading">Loading Nebula scene…</div>
  );

  return {
    canvas,
    boardName,
    canvases,
    context,
    setActiveCanvasId,
    createCanvas,
    resetCanvasBackground,
    exportScene,
    exportNebulaDocument,
    exportObsidianMarkdown,
    importScene,
    openCanvasSearch,
  };
}

export default NebulaExcalidrawShell;
