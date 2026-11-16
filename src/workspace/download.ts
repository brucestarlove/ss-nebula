import type { FileEntry, FileStore } from '../files/types';
import { stem } from '../files/paths';
import { OPAQUE_TYPE, typedBlob } from './views/shared/mime';

/** Long enough for any browser to start the download from the URL, a big
 * file in Safari included. */
const REVOKE_AFTER_MS = 60_000;

/** Hands a blob to the browser as a download. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Browsers read the URL after click() returns.
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

/** Saves a file to the device as opaque bytes, so even a 'page.html' or an
 * SVG can't open as a page of this origin where the download attribute is
 * ignored. */
export async function downloadFile(store: FileStore, entry: Pick<FileEntry, 'path' | 'name'>): Promise<void> {
  saveBlob(typedBlob(await store.readBlob(entry.path), entry.name, OPAQUE_TYPE), entry.name);
}

/** Saves text the page holds, such as a change that couldn't be kept as a
 * copy, as a file: opaque bytes, as downloadFile saves. */
export function downloadText(text: string, filename: string): void {
  saveBlob(typedBlob(new Blob([text]), filename, OPAQUE_TYPE), filename);
}

/** 'Winter hexagon.excalidraw.md' → 'Winter hexagon.excalidraw'. */
export function excalidrawFilename(name: string): string {
  return `${stem(name) || 'Untitled'}.excalidraw`;
}

/** A canvas as plain Excalidraw JSON, for excalidraw.com and the desktop
 * apps. An empty file is an empty canvas. */
export async function downloadAsExcalidraw(store: FileStore, entry: Pick<FileEntry, 'path' | 'name'>): Promise<void> {
  const text = await store.readText(entry.path);
  const [{ readObsidianExcalidrawMarkdown, isObsidianExcalidrawMarkdown }, { createEmptyExcalidrawScene }] = await Promise.all([
    import('../nebula/excalidraw/obsidianMarkdown'),
    import('../nebula/excalidraw/scene'),
  ]);
  let scene: unknown;
  if (!text.trim()) scene = createEmptyExcalidrawScene();
  else if (isObsidianExcalidrawMarkdown(text)) scene = readObsidianExcalidrawMarkdown(text);
  else scene = JSON.parse(text);
  const blob = new Blob([JSON.stringify(scene, null, 2)], { type: 'application/json' });
  saveBlob(blob, excalidrawFilename(entry.name));
}
