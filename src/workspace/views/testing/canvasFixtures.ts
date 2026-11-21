/** Test fixtures for canvases that hold images: synthetic bytes, never anyone's pictures. */
import { toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';

/** A `data:` URL holding exactly `bytes`. */
export function dataURLOf(bytes: ArrayLike<number>, mimeType = 'image/png'): string {
  return `data:${mimeType};base64,${btoa(String.fromCharCode(...Array.from(bytes)))}`;
}

export type FixtureImage = { id: string; bytes: number[]; mimeType?: string; created?: number; /** The element that uses it is deleted. */ deleted?: boolean; /** Held in the drawing's files map without an element. */ unused?: boolean };

/** Excalidraw's `files` entry and the image element that names it. */
export function imageParts(image: FixtureImage): { element: ExcalidrawElementLike | null; file: Record<string, unknown> } {
  const mimeType = image.mimeType ?? 'image/png';
  return {
    element: image.unused ? null : { id: `el-${image.id}`, type: 'image', fileId: image.id, x: 0, y: 0, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1, isDeleted: image.deleted ?? false } as ExcalidrawElementLike,
    file: { id: image.id, mimeType, dataURL: dataURLOf(image.bytes, mimeType), ...(image.created === undefined ? {} : { created: image.created }) },
  };
}

/** A scene with a rectangle and these images. */
export function sceneWith(images: FixtureImage[]): ExcalidrawScene {
  const parts = images.map(imageParts);
  return {
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [{ id: 'rect', type: 'rectangle', x: 5, y: 5, width: 50, height: 50, angle: 0, version: 1, versionNonce: 1, isDeleted: false } as ExcalidrawElementLike, ...parts.flatMap((part) => (part.element ? [part.element] : []))],
    appState: { viewBackgroundColor: '#ffffff' },
    files: Object.fromEntries(parts.map((part) => [part.file.id as string, part.file])),
  };
}

/** An Obsidian drawing's text with these images held inside it. */
export function canvasHolding(images: FixtureImage[], options: { compressed?: boolean } = {}): string {
  return toObsidianExcalidrawMarkdown(sceneWith(images), { compressed: options.compressed ?? true });
}
