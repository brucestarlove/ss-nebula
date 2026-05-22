export type ExcalidrawElementLike = {
  id: string;
  type: string;
  x: number;
  y: number;
  width: number;
  height: number;
  angle?: number;
  [key: string]: unknown;
};

export type ExcalidrawAppStateLike = Record<string, unknown>;
export type ExcalidrawFilesLike = Record<string, unknown>;

/**
 * Minimal Excalidraw scene shape used by Nebula until #28 installs the real
 * @excalidraw/excalidraw package types. Excalidraw scene JSON remains the
 * drawing source of truth; this type only captures the boundary Nebula needs.
 */
export type ExcalidrawScene = {
  type?: 'excalidraw';
  version?: number;
  source?: string;
  elements: ExcalidrawElementLike[];
  appState?: ExcalidrawAppStateLike;
  files?: ExcalidrawFilesLike;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isExcalidrawScene(value: unknown): value is ExcalidrawScene {
  return isRecord(value) && Array.isArray(value.elements);
}

export function normalizeExcalidrawScene(value: ExcalidrawScene): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: typeof value.version === 'number' ? value.version : 2,
    source: typeof value.source === 'string' ? value.source : 'starscape.nebula',
    elements: value.elements,
    appState: isRecord(value.appState) ? value.appState : {},
    files: isRecord(value.files) ? value.files : {},
  };
}

export function createEmptyExcalidrawScene(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'starscape.nebula',
    elements: [],
    appState: {},
    files: {},
  };
}
