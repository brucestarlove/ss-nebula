/**
 * Shape type definitions for CollabCanvas
 */

export interface Shape {
  id: string;
  type: 'rectangle' | 'circle' | 'text' | 'line' | 'star' | 'triangle' | 'image' | 'arrow';
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number; // Rotation in degrees
  fill: string;
  zIndex: number; // Layer order - higher values are on top
  createdBy: string;
  updatedBy?: string;
  updatedAt: number;
  parentId?: string; // For text: ID of parent shape it's attached to
  groupId?: string; // For grouping: ID shared by all shapes in the group
  snapToGrid?: boolean; // Whether shape should snap to grid when dragging
  // Line-specific properties
  points?: number[]; // For line: [x1, y1, x2, y2]
  stroke?: string;
  strokeWidth?: number;
  // Arrow-specific properties
  arrowStart?: boolean; // Show arrowhead at start
  arrowEnd?: boolean; // Show arrowhead at end
  arrowStyle?: 'filled' | 'stroked'; // Arrow head style
  // Image-specific properties
  src?: string; // Image URL or data URL
  originalName?: string; // Original filename if uploaded
}

export interface Rectangle extends Shape {
  type: 'rectangle';
}

export interface Circle extends Shape {
  type: 'circle';
  radius: number;
}

export interface TextShape extends Shape {
  type: 'text';
  text: string;
  fontSize?: number;
  fontFamily?: string; // Font family for the text
  parentId?: string; // ID of parent shape this text is attached to
}

export interface Line extends Shape {
  type: 'line';
  points: number[];
  stroke: string;
  strokeWidth: number;
}

export interface Star extends Shape {
  type: 'star';
}

export interface Triangle extends Shape {
  type: 'triangle';
}

export interface ImageShape extends Shape {
  type: 'image';
  src: string;
  originalName?: string;
}

export interface Arrow extends Shape {
  type: 'arrow';
  points: number[];
  stroke: string;
  strokeWidth: number;
  arrowStart?: boolean;
  arrowEnd?: boolean;
  arrowStyle?: 'filled' | 'stroked';
}

export type ShapeType = Rectangle | Circle | TextShape | Line | Star | Triangle | ImageShape | Arrow;

