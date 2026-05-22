import { describe, expect, it } from 'vitest';

import {
  getExcalidrawInteropFilename,
  getNebulaDocumentInteropFilename,
  readExcalidrawSceneFile,
} from './interop';
import { createEmptyNebulaMetadata } from './metadata';
import { createEmptyExcalidrawScene } from './scene';
import type { NebulaExcalidrawDocument } from '../storage/types';

describe('Excalidraw interop helpers', () => {
  it('generates distinct pure Excalidraw and Nebula wrapper filenames', () => {
    expect(getExcalidrawInteropFilename('Ss Nebula / Missions', 'board:id', 'main canvas')).toBe(
      'Ss-Nebula-Missions-main-canvas.excalidraw',
    );
    expect(getNebulaDocumentInteropFilename('Ss Nebula / Missions', 'board:id', 'main canvas')).toBe(
      'Ss-Nebula-Missions-main-canvas.nebula.json',
    );
  });

  it('imports Nebula wrapper documents by extracting their canonical Excalidraw scene', async () => {
    const scene = {
      ...createEmptyExcalidrawScene(),
      elements: [{ id: 'shape-1', type: 'rectangle', x: 1, y: 2, width: 3, height: 4 }],
    };
    const document: NebulaExcalidrawDocument = {
      type: 'starscape.nebula.excalidraw',
      version: 1,
      boardId: 'board-a',
      canvasId: 'canvas-a',
      name: 'Canvas A',
      updatedAt: '2026-05-29T12:00:00.000Z',
      scene,
      nebula: createEmptyNebulaMetadata(),
    };
    const file = new File([JSON.stringify(document)], 'canvas.nebula.json', { type: 'application/json' });

    await expect(readExcalidrawSceneFile(file)).resolves.toEqual(scene);
  });
});
