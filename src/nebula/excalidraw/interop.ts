import { isNebulaExcalidrawDocument, type NebulaExcalidrawDocument } from '../storage/types';
import { isObsidianExcalidrawMarkdown, readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from './obsidianMarkdown';
import { isExcalidrawScene, normalizeExcalidrawScene, type ExcalidrawScene } from './scene';

function safeInteropStem(boardSlug: string | undefined, boardId: string, canvasId: string): string {
  const safeBoard = (boardSlug || boardId)
    .replace(/[^a-zA-Z0-9_-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'ss-nebula';
  const safeCanvas = canvasId.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'main';
  return `${safeBoard}-${safeCanvas}`;
}

export function getExcalidrawInteropFilename(boardSlug: string | undefined, boardId: string, canvasId: string): string {
  return `${safeInteropStem(boardSlug, boardId, canvasId)}.excalidraw`;
}

export function getNebulaDocumentInteropFilename(boardSlug: string | undefined, boardId: string, canvasId: string): string {
  return `${safeInteropStem(boardSlug, boardId, canvasId)}.nebula.json`;
}

export function downloadExcalidrawScene(scene: ExcalidrawScene, filename: string): void {
  downloadTextFile(JSON.stringify(normalizeExcalidrawScene(scene), null, 2), filename, 'application/json');
}

export function downloadNebulaExcalidrawDocument(document: NebulaExcalidrawDocument, filename: string): void {
  downloadTextFile(JSON.stringify(document, null, 2), filename, 'application/json');
}

export function downloadObsidianExcalidrawMarkdown(scene: ExcalidrawScene, filename: string): void {
  downloadTextFile(toObsidianExcalidrawMarkdown(scene), filename, 'text/markdown');
}

function downloadTextFile(contents: string, filename: string, type: string): void {
  if (typeof document === 'undefined') {
    throw new Error('Excalidraw scene downloads require a browser document.');
  }

  const blob = new Blob([contents], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

export function readExcalidrawSceneFile(file: File): Promise<ExcalidrawScene> {
  if (typeof FileReader === 'undefined') {
    return Promise.reject(new Error('Excalidraw scene file import requires browser FileReader support.'));
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsedText = String(reader.result || '');
        if (isObsidianExcalidrawMarkdown(parsedText)) {
          resolve(readObsidianExcalidrawMarkdown(parsedText));
          return;
        }

        const parsed: unknown = JSON.parse(parsedText);
        if (isNebulaExcalidrawDocument(parsed)) {
          resolve(normalizeExcalidrawScene(parsed.scene));
          return;
        }
        if (!isExcalidrawScene(parsed)) {
          reject(new Error('Selected file is not a valid Excalidraw scene.'));
          return;
        }
        resolve(normalizeExcalidrawScene({ ...parsed, source: parsed.source || 'imported.excalidraw' }));
      } catch (error) {
        reject(error instanceof Error ? error : new Error('Could not parse Excalidraw scene.'));
      }
    };
    reader.onerror = () => reject(new Error('Could not read Excalidraw scene file.'));
    reader.readAsText(file);
  });
}
