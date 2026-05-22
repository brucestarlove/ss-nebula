import {
  loadLibraryFromBlob,
  serializeLibraryAsJSON,
} from "@excalidraw/excalidraw";
import type { LibraryItem, LibraryItems } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElementLike } from "./scene";

export const EXCALIDRAW_LIBRARY_CATALOG_URL =
  "https://libraries.excalidraw.com/";
// In-app publishing posts to Excalidraw's own backend (VITE_APP_LIBRARY_BACKEND),
// which the bundled package doesn't ship — so Nebula points users at the official
// submission guide instead of a POST that would just fail.
export const EXCALIDRAW_LIBRARY_SUBMIT_URL =
  "https://github.com/excalidraw/excalidraw-libraries#guidelines";

const EXCALIDRAW_LIBRARY_MIME_TYPE = "application/vnd.excalidrawlib+json";
// Legacy flat store, written before Nebula tracked multiple named libraries.
const LEGACY_LIBRARY_STORAGE_PREFIX = "nebula:excalidraw-library";
// Current store: named collections plus the active selection, scoped per board.
const LIBRARY_COLLECTIONS_STORAGE_PREFIX = "nebula:excalidraw-libraries";

/**
 * Excalidraw owns a single flat library list — there is no native concept of
 * multiple named libraries. Nebula layers that on top: it keeps several named
 * collections and loads whichever is active into Excalidraw's one library slot
 * (the same mental model as switching canvases). "Personal Library" is the
 * always-present home collection.
 */
export const PERSONAL_LIBRARY_ID = "personal";
export const PERSONAL_LIBRARY_NAME = "Personal Library";

export type LibraryCollection = {
  id: string;
  name: string;
  items: LibraryItems;
  createdAt: number;
};

export type LibraryCollectionsState = {
  collections: LibraryCollection[];
  activeId: string;
};

function legacyStorageKey(boardId: string): string {
  return `${LEGACY_LIBRARY_STORAGE_PREFIX}:${boardId}`;
}

function collectionsStorageKey(boardId: string): string {
  return `${LIBRARY_COLLECTIONS_STORAGE_PREFIX}:${boardId}`;
}

function makeCollectionId(): string {
  return `lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function personalCollection(items: LibraryItems = []): LibraryCollection {
  return {
    id: PERSONAL_LIBRARY_ID,
    name: PERSONAL_LIBRARY_NAME,
    items,
    createdAt: Date.now(),
  };
}

function readLegacyItems(boardId: string): LibraryItems {
  if (typeof window === "undefined") return [];
  try {
    const stored = window.localStorage.getItem(legacyStorageKey(boardId));
    if (!stored) return [];
    const parsed: unknown = JSON.parse(stored);
    return Array.isArray(parsed) ? (parsed as unknown as LibraryItems) : [];
  } catch {
    return [];
  }
}

/** Keep Personal first and present, and guarantee activeId points at a real collection. */
function normalizeState(
  state: LibraryCollectionsState,
): LibraryCollectionsState {
  const valid = state.collections.filter(
    (collection): collection is LibraryCollection =>
      Boolean(collection) &&
      typeof collection.id === "string" &&
      Array.isArray(collection.items),
  );
  const personal =
    valid.find((collection) => collection.id === PERSONAL_LIBRARY_ID) ??
    personalCollection();
  const rest = valid.filter(
    (collection) => collection.id !== PERSONAL_LIBRARY_ID,
  );
  const collections = [personal, ...rest];
  const activeId = collections.some(
    (collection) => collection.id === state.activeId,
  )
    ? state.activeId
    : PERSONAL_LIBRARY_ID;
  return { collections, activeId };
}

export function loadLibraryCollections(
  boardId: string,
): LibraryCollectionsState {
  if (typeof window === "undefined") {
    return {
      collections: [personalCollection()],
      activeId: PERSONAL_LIBRARY_ID,
    };
  }

  try {
    const stored = window.localStorage.getItem(collectionsStorageKey(boardId));
    if (stored) {
      const parsed: unknown = JSON.parse(stored);
      if (
        parsed &&
        typeof parsed === "object" &&
        Array.isArray((parsed as { collections?: unknown }).collections)
      ) {
        return normalizeState(parsed as LibraryCollectionsState);
      }
    }
  } catch {
    // Corrupt store — fall through to legacy migration / default below.
  }

  // First run on this board: migrate any legacy flat library into Personal.
  return normalizeState({
    collections: [personalCollection(readLegacyItems(boardId))],
    activeId: PERSONAL_LIBRARY_ID,
  });
}

export function saveLibraryCollections(
  boardId: string,
  state: LibraryCollectionsState,
): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(
    collectionsStorageKey(boardId),
    JSON.stringify(state),
  );
}

export function getActiveCollection(
  state: LibraryCollectionsState,
): LibraryCollection {
  return (
    state.collections.find((collection) => collection.id === state.activeId) ??
    state.collections[0] ??
    personalCollection()
  );
}

export function getCollection(
  state: LibraryCollectionsState,
  id: string,
): LibraryCollection | undefined {
  return state.collections.find((collection) => collection.id === id);
}

export function setActiveCollection(
  state: LibraryCollectionsState,
  id: string,
): LibraryCollectionsState {
  if (!state.collections.some((collection) => collection.id === id))
    return state;
  return { ...state, activeId: id };
}

export function createCollection(
  state: LibraryCollectionsState,
  name: string,
  items: LibraryItems = [],
): { state: LibraryCollectionsState; collection: LibraryCollection } {
  const collection: LibraryCollection = {
    id: makeCollectionId(),
    name: name.trim() || "Untitled library",
    items,
    createdAt: Date.now(),
  };
  // Creating a library makes it active so the user lands in their new collection.
  return {
    state: {
      collections: [...state.collections, collection],
      activeId: collection.id,
    },
    collection,
  };
}

export function renameCollection(
  state: LibraryCollectionsState,
  id: string,
  name: string,
): LibraryCollectionsState {
  const trimmed = name.trim();
  if (!trimmed) return state;
  return {
    ...state,
    collections: state.collections.map((collection) =>
      collection.id === id ? { ...collection, name: trimmed } : collection,
    ),
  };
}

export function deleteCollection(
  state: LibraryCollectionsState,
  id: string,
): LibraryCollectionsState {
  // Personal Library is the guaranteed home and cannot be deleted.
  if (id === PERSONAL_LIBRARY_ID) return state;
  const collections = state.collections.filter(
    (collection) => collection.id !== id,
  );
  const activeId = state.activeId === id ? PERSONAL_LIBRARY_ID : state.activeId;
  return normalizeState({ collections, activeId });
}

export function setCollectionItems(
  state: LibraryCollectionsState,
  id: string,
  items: LibraryItems,
): LibraryCollectionsState {
  return {
    ...state,
    collections: state.collections.map((collection) =>
      collection.id === id ? { ...collection, items } : collection,
    ),
  };
}

export function addItemsToCollection(
  state: LibraryCollectionsState,
  id: string,
  items: LibraryItems,
): LibraryCollectionsState {
  return {
    ...state,
    collections: state.collections.map((collection) =>
      collection.id === id
        ? {
            ...collection,
            items: mergeLibraryItemsById(collection.items, items),
          }
        : collection,
    ),
  };
}

/** Merge incoming items into existing, de-duplicating by id (incoming wins). */
function mergeLibraryItemsById(
  existing: LibraryItems,
  incoming: LibraryItems,
): LibraryItems {
  const byId = new Map(existing.map((item) => [item.id, item]));
  for (const item of incoming) byId.set(item.id, item);
  return [...byId.values()] as unknown as LibraryItems;
}

export function createLibraryReturnUrl(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const url = new URL(window.location.href);
  url.searchParams.delete("addLibrary");
  url.searchParams.delete("idToken");
  return url.toString();
}

export async function loadLibraryItemsFromFile(
  file: Blob,
): Promise<LibraryItems> {
  return (await loadLibraryFromBlob(file, "published")) as LibraryItems;
}

export function createLibraryItemFromElements(
  name: string,
  elements: readonly ExcalidrawElementLike[],
): LibraryItem {
  const cleaned = elements
    .filter((element) => element && element.isDeleted !== true)
    .map((element) => ({ ...element, isDeleted: false }));

  if (cleaned.length === 0) {
    throw new Error(
      "Select at least one visible element before adding to a library.",
    );
  }

  return {
    id: `nebula-lib-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    status: "unpublished",
    elements: cleaned as never,
    created: Date.now(),
    name: name.trim() || "Nebula library item",
  };
}

export function getSelectedLibraryElements(
  elements: readonly ExcalidrawElementLike[],
  selectedElementIds: Record<string, unknown> = {},
): ExcalidrawElementLike[] {
  const selectedIds = new Set(
    Object.entries(selectedElementIds)
      .filter(([, selected]) => Boolean(selected))
      .map(([id]) => id),
  );
  if (selectedIds.size === 0) return [];

  const expandedIds = new Set(selectedIds);
  for (const element of elements) {
    if (selectedIds.has(element.id)) {
      const boundElements = Array.isArray(element.boundElements)
        ? element.boundElements
        : [];
      for (const boundElement of boundElements) {
        if (boundElement && typeof boundElement === "object") {
          const id = (boundElement as { id?: unknown }).id;
          if (typeof id === "string") expandedIds.add(id);
        }
      }
    }

    const containerId =
      typeof element.containerId === "string" ? element.containerId : undefined;
    if (containerId && selectedIds.has(containerId))
      expandedIds.add(element.id);
  }

  return elements.filter(
    (element) => expandedIds.has(element.id) && element.isDeleted !== true,
  );
}

export function getExcalidrawLibraryPackFilename(name: string): string {
  const safeName =
    name
      .trim()
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "nebula-library";
  return `${safeName}.excalidrawlib`;
}

export function downloadExcalidrawLibrary(
  libraryItems: LibraryItems,
  filename: string,
): void {
  if (libraryItems.length === 0)
    throw new Error("This library has no items to save yet.");
  downloadTextFile(
    serializeLibraryAsJSON(libraryItems),
    filename,
    EXCALIDRAW_LIBRARY_MIME_TYPE,
  );
}

function downloadTextFile(
  contents: string,
  filename: string,
  type: string,
): void {
  if (typeof document === "undefined") {
    throw new Error("Excalidraw library downloads require a browser document.");
  }

  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
