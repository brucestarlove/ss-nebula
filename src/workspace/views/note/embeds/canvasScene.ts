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
