import { localStorageNebulaAdapter } from './localStorageAdapter';
import type { NebulaDocumentRef, NebulaStorageAdapter } from '../storage';
import type { NebulaDocument, NebulaElement } from '../types';

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '');
}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function getOrbitNebulaUrl(baseUrl: string, { boardId, canvasId }: NebulaDocumentRef): string {
  return `${normalizeBaseUrl(baseUrl)}/api/boards/${encodePathSegment(boardId)}/nebula/${encodePathSegment(canvasId)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNebulaElement(value: unknown): value is NebulaElement {
  if (!isRecord(value)) return false;

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
  if (!isRecord(value)) return false;

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

async function parseOrbitDocumentResponse(response: Response, ref: NebulaDocumentRef): Promise<NebulaDocument | null> {
  if (response.status === 404) return null;

  if (!response.ok) {
    throw new Error(`Orbit failed to load Nebula document ${ref.boardId}/${ref.canvasId}: ${response.status} ${response.statusText}`);
  }

  const payload: unknown = await response.json();
  const document = isRecord(payload) && 'document' in payload ? payload.document : payload;

  if (document === null) return null;

  if (!isNebulaDocument(document)) {
    throw new Error(`Orbit returned an invalid Nebula document for ${ref.boardId}/${ref.canvasId}`);
  }

  if (document.boardId !== ref.boardId || document.canvasId !== ref.canvasId) {
    throw new Error(`Orbit returned Nebula document identity mismatch for ${ref.boardId}/${ref.canvasId}`);
  }

  return document;
}

export function createOrbitNebulaAdapter(baseUrl: string): NebulaStorageAdapter {
  const normalizedBaseUrl = normalizeBaseUrl(baseUrl);

  return {
    async loadDocument(ref) {
      const response = await fetch(getOrbitNebulaUrl(normalizedBaseUrl, ref), {
        method: 'GET',
        headers: {
          Accept: 'application/json',
        },
      });

      return parseOrbitDocumentResponse(response, ref);
    },

    async saveDocument(document) {
      const response = await fetch(getOrbitNebulaUrl(normalizedBaseUrl, document), {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({ document }),
      });

      if (!response.ok) {
        throw new Error(
          `Orbit failed to save Nebula document ${document.boardId}/${document.canvasId}: ${response.status} ${response.statusText}`
        );
      }
    },
  };
}

const orbitBaseUrl = import.meta.env.VITE_ORBIT_BASE_URL as string | undefined;

export const defaultNebulaStorageAdapter: NebulaStorageAdapter = orbitBaseUrl
  ? createOrbitNebulaAdapter(orbitBaseUrl)
  : localStorageNebulaAdapter;

export { getOrbitNebulaUrl };
