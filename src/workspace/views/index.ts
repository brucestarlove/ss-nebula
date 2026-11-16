import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import type { FileKind, FileViewProps } from '../../files/types';
import { withFallback } from './shared/withFallback';

export type FileView = ComponentType<FileViewProps>;
export { withFallback };

type ViewModule = { default: FileView };

// One loader per kind, so a phone that only reads notes never downloads
// Excalidraw, and reading a note never downloads CodeMirror.
const LOADERS: Record<FileKind, () => Promise<ViewModule>> = {
  note: () => import('./note/NoteView'),
  canvas: () => import('./canvas/CanvasView'),
  image: () => import('./image/ImageView'),
  pdf: () => import('./pdf/PdfView'),
  audio: () => import('./audio/AudioView'),
  video: () => import('./video/VideoView'),
  text: () => import('./text/TextView'),
  other: () => import('./other/OtherView'),
};

const VIEWS = new Map<FileKind, LazyExoticComponent<FileView>>();

/** The view for a kind of file: a lazy component, the same one on every call.
 * Render it inside a Suspense boundary. A view that crashes shows the info
 * card instead (withFallback). */
export function viewFor(kind: FileKind): LazyExoticComponent<FileView> {
  let view = VIEWS.get(kind);
  if (!view) {
    const load = LOADERS[kind] ?? LOADERS.other;
    view = lazy(() => load().then((module) => ({ default: withFallback(module.default) })));
    VIEWS.set(kind, view);
  }
  return view;
}
