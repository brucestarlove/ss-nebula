import type { NebulaStorageAdapter } from '../storage';
import type { NebulaDocument, NebulaElement } from '../types';

function getNebulaStorageKey(boardId: string, canvasId: string): string {
  return `nebula:${boardId}:${canvasId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNebulaElement(value: unknown): value is NebulaElement {
  if (!isRecord(value)) {
    return false;
  }

  return (
    typeof value.id === 'string' &&
    typeof value.type === 'string' &&
    typeof value.x === 'number' &&
    typeof value.y === 'number' &&
    typeof value.width === 'number' &&
    typeof value.height === 'number'
  );
}

function isNebulaDocument(value: unknown): value is NebulaDocument {
  if (!isRecord(value)) {
    return false;
  }

  return (
    value.schema === 'nebula.document' &&
    value.version === 1 &&
    typeof value.boardId === 'string' &&
    typeof value.canvasId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.updatedAt === 'string' &&
    Array.isArray(value.elements) &&
    value.elements.every(isNebulaElement)
  );
}

function getStorage(): Storage | undefined {
  if (typeof window === 'undefined') {
    return undefined;
  }

  try {
    return window.localStorage;
  } catch (error) {
    console.warn('Nebula localStorage is unavailable:', error);
    return undefined;
  }
}

export { getNebulaStorageKey };

export const localStorageNebulaAdapter: NebulaStorageAdapter = {
  async loadDocument({ boardId, canvasId }) {
    const storage = getStorage();
    if (!storage) {
      return null;
    }

    let rawDocument: string | null;
    try {
      rawDocument = storage.getItem(getNebulaStorageKey(boardId, canvasId));
    } catch (error) {
      console.warn(`Failed to read Nebula document ${boardId}/${canvasId}:`, error);
      return null;
    }

    if (!rawDocument) {
      return null;
    }

    let parsedDocument: unknown;
    try {
      parsedDocument = JSON.parse(rawDocument);
    } catch (error) {
      console.warn(`Invalid Nebula JSON in localStorage for ${boardId}/${canvasId}:`, error);
      return null;
    }

    if (!isNebulaDocument(parsedDocument)) {
      console.warn(`Invalid Nebula document in localStorage for ${boardId}/${canvasId}`);
      return null;
    }

    if (parsedDocument.boardId !== boardId || parsedDocument.canvasId !== canvasId) {
      console.warn(
        `Ignoring Nebula document identity mismatch for ${boardId}/${canvasId}`,
        parsedDocument
      );
      return null;
    }

    return parsedDocument;
  },

  async saveDocument(document) {
    const storage = getStorage();
    if (!storage) {
      return;
    }

    try {
      storage.setItem(
        getNebulaStorageKey(document.boardId, document.canvasId),
        JSON.stringify(document)
      );
    } catch (error) {
      throw new Error(
        `Failed to save Nebula document ${document.boardId}/${document.canvasId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  },
};
