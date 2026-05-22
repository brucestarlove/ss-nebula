import { isExcalidrawScene, type ExcalidrawScene } from '../excalidraw/scene';
import type { NebulaExcalidrawMetadata } from '../excalidraw/metadata';

export const NEBULA_EXCALIDRAW_DOCUMENT_TYPE = 'starscape.nebula.excalidraw';
export const NEBULA_EXCALIDRAW_DOCUMENT_VERSION = 1;

export type NebulaExcalidrawDocument = {
  type: typeof NEBULA_EXCALIDRAW_DOCUMENT_TYPE;
  version: typeof NEBULA_EXCALIDRAW_DOCUMENT_VERSION;
  boardId: string;
  canvasId: string;
  name: string;
  updatedAt: string;
  scene: ExcalidrawScene;
  nebula: NebulaExcalidrawMetadata;
};

export type SceneStoreRef = {
  boardId: string;
  canvasId: string;
};

export type CanvasSummary = {
  canvasId: string;
  name: string;
  updatedAt: string;
};

export interface SceneStore {
  load(ref: SceneStoreRef): Promise<NebulaExcalidrawDocument | null>;
  save(document: NebulaExcalidrawDocument): Promise<void>;
  /** Enumerate the canvases persisted for a board, most-recently-updated first. */
  list(boardId: string): Promise<CanvasSummary[]>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isNebulaMetadata(value: unknown): value is NebulaExcalidrawMetadata {
  return (
    isRecord(value) &&
    Array.isArray(value.ticketLinks) &&
    Array.isArray(value.missionFrames) &&
    Array.isArray(value.artifactRefs) &&
    isRecord(value.semanticIndex)
  );
}

export function isNebulaExcalidrawDocument(value: unknown): value is NebulaExcalidrawDocument {
  return (
    isRecord(value) &&
    value.type === NEBULA_EXCALIDRAW_DOCUMENT_TYPE &&
    value.version === NEBULA_EXCALIDRAW_DOCUMENT_VERSION &&
    typeof value.boardId === 'string' &&
    typeof value.canvasId === 'string' &&
    typeof value.name === 'string' &&
    typeof value.updatedAt === 'string' &&
    isExcalidrawScene(value.scene) &&
    isNebulaMetadata(value.nebula)
  );
}
