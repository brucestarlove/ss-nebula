import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LibraryItem, LibraryItems } from '@excalidraw/excalidraw/types';

// library.ts pulls two helpers from the heavy Excalidraw package; stub them so
// the collection logic can be exercised in isolation.
vi.mock('@excalidraw/excalidraw', () => ({
  loadLibraryFromBlob: vi.fn(async () => []),
  serializeLibraryAsJSON: vi.fn((items: unknown[]) => JSON.stringify(items)),
}));

import {
  PERSONAL_LIBRARY_ID,
  PERSONAL_LIBRARY_NAME,
  addItemsToCollection,
  createCollection,
  deleteCollection,
  getActiveCollection,
  loadLibraryCollections,
  renameCollection,
  saveLibraryCollections,
  setActiveCollection,
  setCollectionItems,
  type LibraryCollectionsState,
} from './library';

function item(id: string): LibraryItem {
  return { id, status: 'unpublished', elements: [], created: 1, name: id } as unknown as LibraryItem;
}

function items(...ids: string[]): LibraryItems {
  return ids.map(item);
}

const BOARD = 'board-1';

describe('Nebula library collections', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('seeds a Personal Library when storage is empty', () => {
    const state = loadLibraryCollections(BOARD);
    expect(state.collections).toHaveLength(1);
    expect(state.collections[0].id).toBe(PERSONAL_LIBRARY_ID);
    expect(state.collections[0].name).toBe(PERSONAL_LIBRARY_NAME);
    expect(state.activeId).toBe(PERSONAL_LIBRARY_ID);
  });

  it('migrates a legacy flat library into Personal on first load', () => {
    localStorage.setItem(`nebula:excalidraw-library:${BOARD}`, JSON.stringify(items('a', 'b')));
    const state = loadLibraryCollections(BOARD);
    expect(state.collections).toHaveLength(1);
    expect(getActiveCollection(state).items.map((i) => i.id)).toEqual(['a', 'b']);
  });

  it('persists and reloads named collections, keeping Personal first', () => {
    const created = createCollection(loadLibraryCollections(BOARD), 'Icons', items('x')).state;
    saveLibraryCollections(BOARD, created);

    const reloaded = loadLibraryCollections(BOARD);
    expect(reloaded.collections.map((c) => c.name)).toEqual([PERSONAL_LIBRARY_NAME, 'Icons']);
    // createCollection makes the new library active.
    expect(getActiveCollection(reloaded).name).toBe('Icons');
  });

  it('renames and routes items into the active collection', () => {
    let state = createCollection(loadLibraryCollections(BOARD), 'Icons').state;
    const iconsId = state.activeId;
    state = renameCollection(state, iconsId, 'Glyphs');
    state = setCollectionItems(state, iconsId, items('only'));
    expect(getActiveCollection(state).name).toBe('Glyphs');
    expect(getActiveCollection(state).items.map((i) => i.id)).toEqual(['only']);
  });

  it('de-duplicates added items by id', () => {
    let state: LibraryCollectionsState = loadLibraryCollections(BOARD);
    state = addItemsToCollection(state, PERSONAL_LIBRARY_ID, items('a', 'b'));
    state = addItemsToCollection(state, PERSONAL_LIBRARY_ID, items('b', 'c'));
    expect(getActiveCollection(state).items.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });

  it('refuses to delete Personal but removes others and falls back to Personal', () => {
    let state = createCollection(loadLibraryCollections(BOARD), 'Icons').state;
    const iconsId = state.activeId;

    expect(deleteCollection(state, PERSONAL_LIBRARY_ID)).toBe(state);

    state = setActiveCollection(state, iconsId);
    state = deleteCollection(state, iconsId);
    expect(state.collections.map((c) => c.id)).toEqual([PERSONAL_LIBRARY_ID]);
    expect(state.activeId).toBe(PERSONAL_LIBRARY_ID);
  });
});
