import type { FileStore } from '../../../../files/types';
import { readObsidianExcalidrawMarkdown } from '../../../../nebula/excalidraw/obsidianMarkdown';
import { isExcalidrawScene, normalizeExcalidrawScene, type ExcalidrawElementLike, type ExcalidrawScene } from '../../../../nebula/excalidraw/scene';
import { isNebulaExcalidrawDocument } from '../../../../nebula/storage/types';
import { withoutRemoteFiles, type SceneFiles } from '../../canvas/sceneFiles';

/**
 * What of a canvas file is drawn in a note: its live elements, and the
 * images whose data is in the file itself (a `data:` URL), as in the canvas
 * view (re-review R2). Pure, so it is tested without Excalidraw.
 */
function readScene(text: string, path: string): ExcalidrawScene | null {
  if (!text.trim()) return null;
  if (!path.toLowerCase().endsWith('.excalidraw')) return readObsidianExcalidrawMarkdown(text);
  const parsed: unknown = JSON.parse(text);
  if (isNebulaExcalidrawDocument(parsed)) return normalizeExcalidrawScene(parsed.scene);
  if (!isExcalidrawScene(parsed)) throw new Error('This file is not an Excalidraw drawing.');
  return normalizeExcalidrawScene(parsed);
}

/** The elements and images to draw, or null for a drawing with nothing on it; throws for a file that isn't a drawing. */
export function drawableScene(text: string, path: string): { elements: ExcalidrawElementLike[]; files: SceneFiles } | null {
  const scene = readScene(text, path);
  if (!scene) return null;
  const { scene: safe } = withoutRemoteFiles(scene);
  const elements = safe.elements.filter((element) => !element.isDeleted);
  return elements.length === 0 ? null : { elements, files: safe.files ?? {} };
}

/**
 * drawableScene, with the images an Obsidian drawing keeps as files beside
 * it (its `## Embedded Files`) read from the project, as the canvas view
 * reads them (canvasImages.ts): a note shows a canvas's images too. A
 * reference that can't be read is a missing image, as on the canvas.
 */
export async function drawableSceneWithImages(store: FileStore, text: string, path: string): Promise<ReturnType<typeof drawableScene>> {
  const drawing = drawableScene(text, path);
  if (!drawing || path.toLowerCase().endsWith('.excalidraw')) return drawing;
  // Loaded here, not with the index, which reads canvases through this module too.
  const { readReferencedImages } = await import('../../canvas/canvasImages');
  const images = await readReferencedImages(store, path, text, drawing, { present: new Set(Object.keys(drawing.files)) });
  return Object.keys(images.files).length === 0 ? drawing : { ...drawing, files: { ...(images.files as SceneFiles), ...drawing.files } };
}

/** The picture exportToSvg makes of a scene is its bounds plus this much on every side (canvasSvg.ts). */
export const EXPORT_PADDING = 12;

/** A picture's size in pixels. */
export type SceneBox = { width: number; height: number };

/**
 * The size of the picture a canvas file is drawn as (its elements' bounds
 * and the export's padding), from the file's text alone, so a note can keep
 * the drawing's place before Excalidraw has been fetched. Rotated elements
 * count by their turned corners; a curve's swell isn't counted, so it can be
 * a few pixels short (the page lets the picture fit the box). Null for a
 * drawing with nothing on it; throws for a file that isn't a drawing, as
 * drawableScene does.
 */
export function sceneBox(text: string, path: string): SceneBox | null {
  const drawing = drawableScene(text, path);
  if (!drawing) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const element of drawing.elements) {
    const { x, y, width, height } = element;
    if (![x, y, width, height].every(Number.isFinite)) continue;
    const angle = typeof element.angle === 'number' && Number.isFinite(element.angle) ? element.angle : 0;
    const cos = Math.abs(Math.cos(angle));
    const sin = Math.abs(Math.sin(angle));
    const centreX = x + width / 2;
    const centreY = y + height / 2;
    const halfWidth = (Math.abs(width) * cos + Math.abs(height) * sin) / 2;
    const halfHeight = (Math.abs(width) * sin + Math.abs(height) * cos) / 2;
    minX = Math.min(minX, centreX - halfWidth);
    maxX = Math.max(maxX, centreX + halfWidth);
    minY = Math.min(minY, centreY - halfHeight);
    maxY = Math.max(maxY, centreY + halfHeight);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { width: Math.max(1, Math.round(maxX - minX + 2 * EXPORT_PADDING)), height: Math.max(1, Math.round(maxY - minY + 2 * EXPORT_PADDING)) };
}
