import type { NebulaDocument } from './types';

export type { NebulaExcalidrawDocument, SceneStore, SceneStoreRef } from './storage/types';

export interface NebulaDocumentRef {
  boardId: string;
  canvasId: string;
}

export interface NebulaStorageAdapter {
  loadDocument(ref: NebulaDocumentRef): Promise<NebulaDocument | null>;
  saveDocument(document: NebulaDocument): Promise<void>;
}
