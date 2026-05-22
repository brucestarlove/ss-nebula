import { isNebulaExcalidrawDocument, type CanvasSummary, type NebulaExcalidrawDocument, type SceneStore, type SceneStoreRef } from './types';

const STORAGE_PREFIX = 'nebula:excalidraw';

function storageKey({ boardId, canvasId }: SceneStoreRef): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(boardId)}:${encodeURIComponent(canvasId)}`;
}

function boardKeyPrefix(boardId: string): string {
  return `${STORAGE_PREFIX}:${encodeURIComponent(boardId)}:`;
}

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined;

  try {
    return window.localStorage;
  } catch {
    return undefined;
  }
}

export class LocalStorageSceneStore implements SceneStore {
  async load(ref: SceneStoreRef): Promise<NebulaExcalidrawDocument | null> {
    const storage = getStorage();
    if (!storage) return null;

    const raw = storage.getItem(storageKey(ref));
    if (!raw) return null;

    try {
      const parsed: unknown = JSON.parse(raw);
      return isNebulaExcalidrawDocument(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async save(document: NebulaExcalidrawDocument): Promise<void> {
    const storage = getStorage();
    if (!storage) return;

    storage.setItem(
      storageKey({ boardId: document.boardId, canvasId: document.canvasId }),
      JSON.stringify(document),
    );
  }

  async list(boardId: string): Promise<CanvasSummary[]> {
    const storage = getStorage();
    if (!storage) return [];

    const prefix = boardKeyPrefix(boardId);
    const summaries: CanvasSummary[] = [];

    for (let i = 0; i < storage.length; i += 1) {
      const key = storage.key(i);
      if (!key || !key.startsWith(prefix)) continue;

      const raw = storage.getItem(key);
      if (!raw) continue;

      try {
        const parsed: unknown = JSON.parse(raw);
        if (!isNebulaExcalidrawDocument(parsed)) continue;
        summaries.push({
          canvasId: parsed.canvasId,
          name: parsed.name || parsed.canvasId,
          updatedAt: parsed.updatedAt,
        });
      } catch {
        // Skip malformed entries.
      }
    }

    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
}

export function createLocalStorageSceneStore(): SceneStore {
  return new LocalStorageSceneStore();
}
