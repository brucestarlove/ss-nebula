import { beforeEach, describe, expect, it } from 'vitest';

import { createEmptyExcalidrawScene } from '../excalidraw/scene';
import { createEmptyNebulaMetadata } from '../excalidraw/metadata';
import { LocalStorageSceneStore } from './localStorageSceneStore';
import type { NebulaExcalidrawDocument } from './types';

function document(overrides: Partial<NebulaExcalidrawDocument> = {}): NebulaExcalidrawDocument {
  return {
    type: 'starscape.nebula.excalidraw',
    version: 1,
    boardId: 'board-a',
    canvasId: 'canvas-a',
    name: 'Canvas A',
    updatedAt: '2026-05-29T12:00:00.000Z',
    scene: createEmptyExcalidrawScene(),
    nebula: createEmptyNebulaMetadata(),
    ...overrides,
  };
}

describe('LocalStorageSceneStore', () => {
  let store: LocalStorageSceneStore;

  beforeEach(() => {
    window.localStorage.clear();
    store = new LocalStorageSceneStore();
  });

  it('saves and loads a Nebula Excalidraw document by board and canvas', async () => {
    const saved = document({
      boardId: 'board/a',
      canvasId: 'canvas b',
      scene: {
        ...createEmptyExcalidrawScene(),
        elements: [
          {
            id: 'shape-1',
            type: 'rectangle',
            x: 10,
            y: 20,
            width: 30,
            height: 40,
          },
        ],
      },
    });

    await store.save(saved);

    await expect(store.load({ boardId: 'board/a', canvasId: 'canvas b' })).resolves.toEqual(saved);
    await expect(store.load({ boardId: 'board/a', canvasId: 'missing' })).resolves.toBeNull();
  });

  it('returns null for malformed JSON and non-Nebula records', async () => {
    window.localStorage.setItem('nebula:excalidraw:board-a:bad-json', '{not-json');
    window.localStorage.setItem(
      'nebula:excalidraw:board-a:wrong-type',
      JSON.stringify({ ...document(), type: 'excalidraw' }),
    );
    window.localStorage.setItem(
      'nebula:excalidraw:board-a:no-elements',
      JSON.stringify({ ...document(), scene: {} }),
    );

    await expect(store.load({ boardId: 'board-a', canvasId: 'bad-json' })).resolves.toBeNull();
    await expect(store.load({ boardId: 'board-a', canvasId: 'wrong-type' })).resolves.toBeNull();
    await expect(store.load({ boardId: 'board-a', canvasId: 'no-elements' })).resolves.toBeNull();
  });

  it('lists only valid canvases for a board, newest first', async () => {
    await store.save(
      document({ canvasId: 'old', name: 'Old Canvas', updatedAt: '2026-05-29T10:00:00.000Z' }),
    );
    await store.save(
      document({ canvasId: 'new', name: 'New Canvas', updatedAt: '2026-05-29T13:00:00.000Z' }),
    );
    await store.save(
      document({ boardId: 'board-b', canvasId: 'other-board', updatedAt: '2026-05-29T14:00:00.000Z' }),
    );
    window.localStorage.setItem('nebula:excalidraw:board-a:malformed', '{bad-json');
    window.localStorage.setItem(
      'nebula:excalidraw:board-a:invalid',
      JSON.stringify({ ...document({ canvasId: 'invalid' }), version: 2 }),
    );

    await expect(store.list('board-a')).resolves.toEqual([
      {
        canvasId: 'new',
        name: 'New Canvas',
        updatedAt: '2026-05-29T13:00:00.000Z',
      },
      {
        canvasId: 'old',
        name: 'Old Canvas',
        updatedAt: '2026-05-29T10:00:00.000Z',
      },
    ]);
  });

  it('falls back to canvasId for unnamed valid documents when listing', async () => {
    await store.save(document({ canvasId: 'untitled', name: '' }));

    await expect(store.list('board-a')).resolves.toEqual([
      {
        canvasId: 'untitled',
        name: 'untitled',
        updatedAt: '2026-05-29T12:00:00.000Z',
      },
    ]);
  });
});
