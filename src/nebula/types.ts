/**
 * Orbit-native Nebula document schema.
 *
 * Nebula is the internal, AI-readable canvas format. It intentionally avoids
 * Firebase persistence details and Excalidraw-specific concepts so it can serve
 * as the small source-of-truth model for canvas data.
 */

export type NebulaSchema = 'nebula.document';
export type NebulaDocumentVersion = 1;

export type NebulaElementType =
  | 'rectangle'
  | 'ellipse'
  | 'text'
  | 'line'
  | 'arrow'
  | 'image'
  | 'custom';

export type NebulaKnownCustomElementKind = 'star' | 'triangle';
export type NebulaCustomElementKind = NebulaKnownCustomElementKind | (string & {});
export type NebulaArrowHead = 'none' | 'filled' | 'stroked';

export interface NebulaPoint {
  x: number;
  y: number;
}

export interface NebulaCanvas {
  width?: number;
  height?: number;
  background?: string;
}

export interface NebulaViewport {
  x: number;
  y: number;
  scale: number;
}

export interface NebulaDocumentMetadata {
  createdBy?: string;
  updatedBy?: string;
  createdAt?: number;
  updatedAt?: number;
  source?: string;
  [key: string]: unknown;
}

export interface NebulaStyle {
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  opacity?: number;
}

export interface NebulaTextStyle extends NebulaStyle {
  fontSize?: number;
  fontFamily?: string;
}

export interface NebulaArrowStyle extends NebulaStyle {
  startHead?: NebulaArrowHead;
  endHead?: NebulaArrowHead;
}

export interface NebulaElementBase {
  id: string;
  type: NebulaElementType;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
  zIndex?: number;
  style?: NebulaStyle;
  createdBy?: string;
  updatedBy?: string;
  updatedAt?: number;
  parentId?: string;
  groupId?: string;
  snapToGrid?: boolean;
}

export interface NebulaRectangleElement extends NebulaElementBase {
  type: 'rectangle';
}

export interface NebulaEllipseElement extends NebulaElementBase {
  type: 'ellipse';
}

export interface NebulaTextElement extends NebulaElementBase {
  type: 'text';
  text: string;
  style?: NebulaTextStyle;
}

export interface NebulaLineElement extends NebulaElementBase {
  type: 'line';
  points: NebulaPoint[];
}

export interface NebulaArrowElement extends NebulaElementBase {
  type: 'arrow';
  points: NebulaPoint[];
  style?: NebulaArrowStyle;
}

export interface NebulaImageElement extends NebulaElementBase {
  type: 'image';
  src: string;
  originalName?: string;
}

export interface NebulaCustomElement extends NebulaElementBase {
  type: 'custom';
  customType: NebulaCustomElementKind;
  data?: Record<string, unknown>;
}

export type NebulaElement =
  | NebulaRectangleElement
  | NebulaEllipseElement
  | NebulaTextElement
  | NebulaLineElement
  | NebulaArrowElement
  | NebulaImageElement
  | NebulaCustomElement;

export interface NebulaDocument {
  schema: NebulaSchema;
  version: NebulaDocumentVersion;
  /** Stable Orbit board id or slug that owns this canvas. */
  boardId: string;
  /** Board-local canvas id. MVP defaults to `main`. */
  canvasId: string;
  /** Human-readable canvas name. */
  name: string;
  /** ISO timestamp for sync/versioning and AI-readable recency. */
  updatedAt: string;
  canvas?: NebulaCanvas;
  viewport?: NebulaViewport;
  elements: NebulaElement[];
  metadata?: NebulaDocumentMetadata;
}
