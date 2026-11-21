import { exportToSvg } from '@excalidraw/excalidraw';
import type { FileStore } from '../../../../files/types';
import { drawableSceneWithImages, EXPORT_PADDING } from './canvasScene';
import { firstFamily, fontFaceCss } from './canvasFonts';

/**
 * A canvas file as a picture, for a note that embeds it. This module is the
 * only place the reading view touches Excalidraw, and it is imported only
 * when an embed is on screen (CanvasEmbed's `import()`), so a note without
 * one never downloads the library.
 *
 * The result is SVG text in a Blob, shown through an <img> by the caller:
 * an image never runs a script, loads a resource of its own, or reaches the
 * page.
 */
export type CanvasTheme = 'light' | 'dark';

/** The drawing at `path` as an SVG image, transparent, for the night or day theme; null for a drawing with nothing on it. `text` is the file's text when the caller has read it already. */
export async function renderCanvasSvg(store: FileStore, path: string, theme: CanvasTheme, text?: string): Promise<Blob | null> {
  // With the images it keeps as files beside it (2.0.4).
  const drawing = await drawableSceneWithImages(store, text ?? (await store.readText(path)), path);
  if (!drawing) return null;
  const svg = await exportToSvg({
    elements: drawing.elements as unknown as Parameters<typeof exportToSvg>[0]['elements'],
    appState: { exportBackground: false, exportWithDarkMode: theme === 'dark', exportEmbedScene: false, viewBackgroundColor: 'transparent' },
    files: drawing.files as unknown as Parameters<typeof exportToSvg>[0]['files'],
    exportPadding: EXPORT_PADDING,
    // Excalidraw's own font embedding needs eval, which the site's policy refuses (canvasFonts.ts).
    skipInliningFonts: true,
  });
  const families = [...svg.querySelectorAll('text')].map((text) => firstFamily(text.getAttribute('font-family') ?? ''));
  const assetPath = (window as Window & { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH ?? '/';
  const css = await fontFaceCss(families, assetPath);
  if (css) {
    const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
    style.textContent = css;
    (svg.querySelector('defs') ?? svg).prepend(style);
  }
  return new Blob([new XMLSerializer().serializeToString(svg)], { type: 'image/svg+xml' });
}
