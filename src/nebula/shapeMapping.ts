import type { Shape, ShapeType } from '../types/shapes';
import type {
  NebulaArrowElement,
  NebulaArrowHead,
  NebulaCanvas,
  NebulaDocument,
  NebulaDocumentMetadata,
  NebulaElement,
  NebulaElementBase,
  NebulaLineElement,
  NebulaPoint,
  NebulaViewport,
} from './types';

export interface ShapeToNebulaDocumentOptions {
  boardId: string;
  canvasId: string;
  name?: string;
  updatedAt?: string;
  canvas?: NebulaCanvas;
  viewport?: NebulaViewport;
  metadata?: NebulaDocumentMetadata;
}

export interface NebulaToShapeOptions {
  createdBy?: string;
  updatedBy?: string;
  updatedAt?: number;
  zIndex?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
}

const DEFAULT_FILL = '#ffffff';
const DEFAULT_STROKE = '#000000';
const DEFAULT_STROKE_WIDTH = 4;
const DEFAULT_CREATED_BY = 'nebula';

type NebulaElementScaffold = Omit<NebulaElementBase, 'type'>;
type ShapeScaffold = Omit<Shape, 'type'>;

function definedEntries<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter((entry) => entry[1] !== undefined)
  ) as Partial<T>;
}

function optionalStyle<T extends object>(style: T): Partial<T> | undefined {
  const cleanStyle = Object.fromEntries(
    Object.entries(style as Record<string, unknown>).filter((entry) => entry[1] !== undefined)
  ) as Partial<T>;
  return Object.keys(cleanStyle).length > 0 ? cleanStyle : undefined;
}

function numberPairsToPoints(points?: number[]): NebulaPoint[] {
  if (!points || points.length < 2) {
    return [];
  }

  const result: NebulaPoint[] = [];
  for (let index = 0; index < points.length - 1; index += 2) {
    result.push({ x: points[index], y: points[index + 1] });
  }
  return result;
}

function pointsToNumberPairs(points?: NebulaPoint[]): number[] {
  return (points ?? []).flatMap((point) => [point.x, point.y]);
}

function arrowHeadToNebula(enabled?: boolean, style?: 'filled' | 'stroked'): NebulaArrowHead {
  if (!enabled) {
    return 'none';
  }

  return style ?? 'filled';
}

function nebulaArrowHeadToShape(head?: NebulaArrowHead): boolean {
  return head === 'filled' || head === 'stroked';
}

function getBaseElement(shape: Shape): NebulaElementScaffold {
  return definedEntries({
    id: shape.id,
    x: shape.x,
    y: shape.y,
    width: shape.width,
    height: shape.height,
    rotation: shape.rotation,
    zIndex: shape.zIndex,
    style: optionalStyle({
      fill: shape.fill,
      stroke: shape.stroke,
      strokeWidth: shape.strokeWidth,
    }),
    createdBy: shape.createdBy,
    updatedBy: shape.updatedBy,
    updatedAt: shape.updatedAt,
    parentId: shape.parentId,
    groupId: shape.groupId,
    snapToGrid: shape.snapToGrid,
  }) as NebulaElementScaffold;
}

export function shapeToNebulaElement(shape: ShapeType): NebulaElement {
  const base = getBaseElement(shape);

  switch (shape.type) {
    case 'rectangle':
      return { ...base, type: 'rectangle' };
    case 'circle':
      return { ...base, type: 'ellipse' };
    case 'text':
      return {
        ...base,
        type: 'text',
        text: shape.text,
        style: optionalStyle({
          ...base.style,
          fontSize: shape.fontSize,
          fontFamily: shape.fontFamily,
        }),
      };
    case 'line':
      return {
        ...base,
        type: 'line',
        points: numberPairsToPoints(shape.points),
      };
    case 'arrow':
      return {
        ...base,
        type: 'arrow',
        points: numberPairsToPoints(shape.points),
        style: optionalStyle({
          ...base.style,
          startHead: arrowHeadToNebula(shape.arrowStart, shape.arrowStyle),
          endHead: arrowHeadToNebula(shape.arrowEnd ?? true, shape.arrowStyle),
        }),
      };
    case 'image':
      return definedEntries({
        ...base,
        type: 'image',
        src: shape.src,
        originalName: shape.originalName,
      }) as NebulaElement;
    case 'star':
      return {
        ...base,
        type: 'custom',
        customType: 'star',
      };
    case 'triangle':
      return {
        ...base,
        type: 'custom',
        customType: 'triangle',
      };
  }
}

export function shapesToNebulaDocument(
  shapes: ShapeType[],
  options: ShapeToNebulaDocumentOptions
): NebulaDocument {
  return definedEntries({
    schema: 'nebula.document',
    version: 1,
    boardId: options.boardId,
    canvasId: options.canvasId,
    name: options.name ?? options.canvasId,
    updatedAt: options.updatedAt ?? new Date().toISOString(),
    canvas: options.canvas,
    viewport: options.viewport,
    elements: shapes.map(shapeToNebulaElement),
    metadata: options.metadata,
  }) as NebulaDocument;
}

function getBaseShape(element: NebulaElement, options: NebulaToShapeOptions): ShapeScaffold {
  return definedEntries({
    id: element.id,
    x: element.x,
    y: element.y,
    width: element.width,
    height: element.height,
    rotation: element.rotation,
    fill: element.style?.fill ?? options.fill ?? DEFAULT_FILL,
    zIndex: element.zIndex ?? options.zIndex ?? 0,
    createdBy: element.createdBy ?? options.createdBy ?? DEFAULT_CREATED_BY,
    updatedBy: element.updatedBy ?? options.updatedBy,
    updatedAt: element.updatedAt ?? options.updatedAt ?? Date.now(),
    parentId: element.parentId,
    groupId: element.groupId,
    snapToGrid: element.snapToGrid,
    stroke: element.style?.stroke ?? options.stroke,
    strokeWidth: element.style?.strokeWidth ?? options.strokeWidth,
  }) as ShapeScaffold;
}

function lineDefaults(element: NebulaLineElement | NebulaArrowElement, options: NebulaToShapeOptions) {
  return {
    points: pointsToNumberPairs(element.points),
    stroke: element.style?.stroke ?? options.stroke ?? element.style?.fill ?? DEFAULT_STROKE,
    strokeWidth: element.style?.strokeWidth ?? options.strokeWidth ?? DEFAULT_STROKE_WIDTH,
  };
}

export function nebulaElementToShape(
  element: NebulaElement,
  options: NebulaToShapeOptions = {}
): ShapeType | undefined {
  const base = getBaseShape(element, options);

  switch (element.type) {
    case 'rectangle':
      return { ...base, type: 'rectangle' };
    case 'ellipse':
      return {
        ...base,
        type: 'circle',
        radius: Math.min(element.width, element.height) / 2,
      };
    case 'text':
      return definedEntries({
        ...base,
        type: 'text',
        text: element.text,
        fontSize: element.style?.fontSize,
        fontFamily: element.style?.fontFamily,
      }) as ShapeType;
    case 'line':
      return {
        ...base,
        type: 'line',
        ...lineDefaults(element, options),
      };
    case 'arrow': {
      const startHead = element.style?.startHead;
      const endHead = element.style?.endHead;
      return definedEntries({
        ...base,
        type: 'arrow',
        ...lineDefaults(element, options),
        arrowStart: nebulaArrowHeadToShape(startHead),
        arrowEnd: endHead === undefined ? true : nebulaArrowHeadToShape(endHead),
        arrowStyle: startHead === 'stroked' || endHead === 'stroked' ? 'stroked' : 'filled',
      }) as ShapeType;
    }
    case 'image':
      return definedEntries({
        ...base,
        type: 'image',
        src: element.src,
        originalName: element.originalName,
      }) as ShapeType;
    case 'custom':
      if (element.customType === 'star') {
        return { ...base, type: 'star' };
      }
      if (element.customType === 'triangle') {
        return { ...base, type: 'triangle' };
      }
      return undefined;
  }
}

export function nebulaDocumentToShapes(
  document: NebulaDocument,
  options: NebulaToShapeOptions = {}
): ShapeType[] {
  return document.elements.flatMap((element) => {
    const shape = nebulaElementToShape(element, options);
    return shape ? [shape] : [];
  });
}
