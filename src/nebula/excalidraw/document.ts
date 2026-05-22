import type { NebulaContext } from '../context';
import { createEmptyNebulaMetadata } from './metadata';
import { createEmptyExcalidrawScene } from './scene';
import type { NebulaExcalidrawDocument } from '../storage/types';

export const DEFAULT_NEBULA_CANVAS_NAME = 'my canvas';

export function createEmptyNebulaExcalidrawDocument(
  context: NebulaContext,
  name = context.boardName || context.boardSlug || DEFAULT_NEBULA_CANVAS_NAME,
): NebulaExcalidrawDocument {
  return {
    type: 'starscape.nebula.excalidraw',
    version: 1,
    boardId: context.boardId,
    canvasId: context.canvasId,
    name,
    updatedAt: new Date().toISOString(),
    scene: createEmptyExcalidrawScene(),
    nebula: createEmptyNebulaMetadata(),
  };
}
