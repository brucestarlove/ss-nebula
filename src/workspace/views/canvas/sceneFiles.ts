import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';

export type SceneFiles = NonNullable<ExcalidrawScene['files']>;

/** Whether an image's data is in the file itself: a `data:` URL. */
function inline(file: unknown): boolean {
  const dataURL = (file as { dataURL?: unknown } | null)?.dataURL;
  return typeof dataURL === 'string' && /^data:/i.test(dataURL);
}

/**
 * The scene as it may reach Excalidraw (re-review R2): only images whose
 * data is a `data:` URL. Excalidraw loads any other `dataURL` as soon as the
 * canvas opens (an `https:` one from a third party, say, which the site's
 * CSP allows for notes' click-to-load). Elements all stay, so an image
 * without its data shows as a missing image.
 *
 * `held` is what was taken out, so a save can put it back: the file keeps
 * what it had, and nothing of it is lost by opening it here.
 *
 * Every path that hands a scene read from a file to Excalidraw goes through
 * this: the canvas store's parse (open, a change taken from elsewhere,
 * Reload, any "open as canvas").
 */
export function withoutRemoteFiles(scene: ExcalidrawScene): { scene: ExcalidrawScene; held: SceneFiles } {
  const kept: SceneFiles = {};
  const held: SceneFiles = {};
  for (const [id, file] of Object.entries(scene.files ?? {})) {
    if (inline(file)) kept[id] = file;
    else held[id] = file;
  }
  if (Object.keys(held).length === 0) return { scene, held };
  return { scene: { ...scene, files: kept }, held };
}
