import type { Shape } from '../../types/shapes';

type ExcalidrawElementType = 'rectangle' | 'ellipse' | 'text' | 'line' | 'arrow' | 'diamond';
type ExcalidrawArrowhead = 'arrow' | 'bar' | 'dot' | 'triangle' | null;

interface ExcalidrawBoundElement {
  id: string;
  type: 'text' | 'arrow';
}

interface ExcalidrawElement {
  id: string;
  type: ExcalidrawElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  strokeColor: string;
  backgroundColor: string;
  fillStyle: 'solid' | 'hachure' | 'cross-hatch';
  strokeWidth: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
  roughness: number;
  opacity: number;
  groupIds: string[];
  frameId: null;
  roundness: { type: number } | null;
  seed: number;
  version: number;
  versionNonce: number;
  isDeleted: boolean;
  boundElements: ExcalidrawBoundElement[] | null;
  updated: number;
  link: null;
  locked: boolean;
  customData?: Record<string, unknown>;
  points?: number[][];
  lastCommittedPoint?: null;
  startBinding?: null;
  endBinding?: null;
  startArrowhead?: ExcalidrawArrowhead;
  endArrowhead?: ExcalidrawArrowhead;
  text?: string;
  fontSize?: number;
  fontFamily?: number;
  textAlign?: 'left' | 'center' | 'right';
  verticalAlign?: 'top' | 'middle' | 'bottom';
  containerId?: string | null;
  originalText?: string;
  lineHeight?: number;
  baseline?: number;
}

export interface ExcalidrawScene {
  type: 'excalidraw';
  version: 2;
  source: string;
  elements: ExcalidrawElement[];
  appState: {
    viewBackgroundColor: string;
    gridSize: number | null;
  };
  files: Record<string, unknown>;
}

const SOURCE = 'ss-nebula';
const DEFAULT_STROKE = '#1e1e1e';
const TRANSPARENT = 'transparent';

function stableSeed(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 31 + input.charCodeAt(index)) | 0;
  }
  return Math.abs(hash) || 1;
}

function safeElementId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40) || crypto.randomUUID();
}

function groupIds(shape: Shape): string[] {
  return shape.groupId ? [shape.groupId] : [];
}

function baseElement(shape: Shape, type: ExcalidrawElementType): ExcalidrawElement {
  const strokeColor = shape.stroke || DEFAULT_STROKE;

  return {
    id: safeElementId(shape.id),
    type,
    x: shape.x,
    y: shape.y,
    width: shape.width || 1,
    height: shape.height || 1,
    angle: ((shape.rotation || 0) * Math.PI) / 180,
    strokeColor,
    backgroundColor: shape.fill || TRANSPARENT,
    fillStyle: 'solid',
    strokeWidth: shape.strokeWidth || 2,
    strokeStyle: 'solid',
    roughness: 1,
    opacity: 100,
    groupIds: groupIds(shape),
    frameId: null,
    roundness: { type: 3 },
    seed: stableSeed(shape.id),
    version: 1,
    versionNonce: stableSeed(`${shape.id}:nonce`),
    isDeleted: false,
    boundElements: null,
    updated: shape.updatedAt || Date.now(),
    link: null,
    locked: false,
  };
}

function linePoints(shape: Shape): number[][] {
  const points = shape.points && shape.points.length >= 4 ? shape.points : [0, 0, shape.width || 1, 0];
  return [
    [points[0] || 0, points[1] || 0],
    [points[2] || 0, points[3] || 0],
  ];
}

function lineDimensions(points: number[][]): { width: number; height: number } {
  const xs = points.map((point) => point[0]);
  const ys = points.map((point) => point[1]);
  return {
    width: Math.max(1, Math.max(...xs) - Math.min(...xs)),
    height: Math.max(1, Math.max(...ys) - Math.min(...ys)),
  };
}

function textElement(shape: Shape): ExcalidrawElement {
  const text = 'text' in shape && typeof shape.text === 'string' ? shape.text : '';
  const fontSize = 'fontSize' in shape && typeof shape.fontSize === 'number' ? shape.fontSize : 20;
  const element = baseElement(shape, 'text');

  return {
    ...element,
    backgroundColor: TRANSPARENT,
    strokeColor: shape.fill || shape.stroke || DEFAULT_STROKE,
    fillStyle: 'solid',
    roughness: 0,
    roundness: null,
    text,
    originalText: text,
    fontSize,
    fontFamily: 1,
    textAlign: 'center',
    verticalAlign: 'middle',
    containerId: shape.parentId ? safeElementId(shape.parentId) : null,
    lineHeight: 1.25,
    baseline: Math.round(fontSize * 0.8),
  };
}

function toExcalidrawElement(shape: Shape): ExcalidrawElement | null {
  switch (shape.type) {
    case 'rectangle':
      return baseElement(shape, 'rectangle');
    case 'circle':
      return baseElement(shape, 'ellipse');
    case 'text':
      return textElement(shape);
    case 'line': {
      const points = linePoints(shape);
      const dimensions = lineDimensions(points);
      return {
        ...baseElement(shape, 'line'),
        width: dimensions.width,
        height: dimensions.height,
        backgroundColor: TRANSPARENT,
        points,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
      };
    }
    case 'arrow': {
      const points = linePoints(shape);
      const dimensions = lineDimensions(points);
      return {
        ...baseElement(shape, 'arrow'),
        width: dimensions.width,
        height: dimensions.height,
        backgroundColor: TRANSPARENT,
        points,
        lastCommittedPoint: null,
        startBinding: null,
        endBinding: null,
        startArrowhead: shape.arrowStart ? 'arrow' : null,
        endArrowhead: shape.arrowEnd === false ? null : 'arrow',
      };
    }
    case 'triangle':
      return {
        ...baseElement(shape, 'diamond'),
        customData: { nebulaOriginalType: 'triangle', warning: 'Exported as diamond approximation.' },
      };
    case 'star':
      return {
        ...baseElement(shape, 'ellipse'),
        customData: { nebulaOriginalType: 'star', warning: 'Exported as ellipse approximation.' },
      };
    case 'image':
      return {
        ...baseElement(shape, 'rectangle'),
        backgroundColor: TRANSPARENT,
        customData: {
          nebulaOriginalType: 'image',
          src: shape.src,
          originalName: shape.originalName,
          warning: 'Image payloads are not embedded in the MVP Excalidraw export.',
        },
      };
    default:
      return null;
  }
}

function applyTextContainerBindings(elements: ExcalidrawElement[]): ExcalidrawElement[] {
  const byId = new Map(elements.map((element) => [element.id, element]));

  for (const element of elements) {
    if (element.type !== 'text' || !element.containerId) continue;

    const parent = byId.get(element.containerId);
    if (!parent) {
      element.containerId = null;
      continue;
    }

    parent.boundElements = [
      ...(parent.boundElements || []).filter((bound) => bound.id !== element.id),
      { id: element.id, type: 'text' },
    ];
  }

  return elements;
}

export function shapesToExcalidrawScene(shapes: Shape[]): ExcalidrawScene {
  const elements = shapes
    .slice()
    .sort((a, b) => a.zIndex - b.zIndex)
    .map(toExcalidrawElement)
    .filter((element): element is ExcalidrawElement => element !== null);

  return {
    type: 'excalidraw',
    version: 2,
    source: SOURCE,
    elements: applyTextContainerBindings(elements),
    appState: {
      viewBackgroundColor: '#0b1020',
      gridSize: null,
    },
    files: {},
  };
}

export function getExcalidrawExportFilename(boardSlug: string, canvasId: string): string {
  const safeBoard = boardSlug.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'ss-nebula';
  const safeCanvas = canvasId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'main';
  return `${safeBoard}-${safeCanvas}.excalidraw`;
}

export function downloadExcalidrawScene(scene: ExcalidrawScene, filename: string): void {
  const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
