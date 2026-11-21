/**
 * A canvas's images as files beside it, the Obsidian Excalidraw way (2.0.4):
 * a drawing names each image in its `## Embedded Files` section,
 * `<file id>: [[Pasted image 20261121013000.png]]`, and the bytes live in that
 * file. This module reads those files for Excalidraw (which only ever sees a
 * `data:` URL in memory) and writes an image added on the canvas as a file of
 * its own.
 *
 * Images are read only from the project, by Nebula's link rules
 * (links.ts), and only those the drawing's elements use. Nothing here
 * fetches a URL, so the CSP stays as it is.
 *
 * What a note's editor shares with the canvas (an image's name, its
 * create-only write, its link) lives in ../../attachments.ts, which holds no
 * drawing code.
 */
import type { FileEntry, FileStore } from '../../../files/types';
import { embeddedFiles } from '../../../nebula/excalidraw/embeddedFiles';
import type { ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { blobBytes, imageMime, ownImageName } from '../../attachments';
import { resolveLink } from '../note/links';
import type { SceneFiles } from './sceneFiles';

/** One image as Excalidraw keeps it in its `files` map. */
export type ImageFile = { id: string; mimeType: string; dataURL: string; created: number };

/** Whether a scene's file holds its image in itself: a `data:` URL. */
export function inlineData(file: unknown): string | null {
  const dataURL = (file as { dataURL?: unknown } | null)?.dataURL;
  return typeof dataURL === 'string' && /^data:/i.test(dataURL) ? dataURL : null;
}

/** The file ids the drawing's live elements use. */
export function usedFileIds(scene: Pick<ExcalidrawScene, 'elements'>): Set<string> {
  const used = new Set<string>();
  for (const element of scene.elements) {
    if (!element.isDeleted && typeof element.fileId === 'string') used.add(element.fileId);
  }
  return used;
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let at = 0; at < bytes.length; at += 0x8000) binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(binary);
}

/** A blob as a `data:` URL of the given type. */
export async function blobToDataURL(blob: Blob, mimeType: string): Promise<string> {
  return `data:${mimeType};base64,${base64(await blobBytes(blob))}`;
}

/** The bytes and type a `data:` URL holds; null when it isn't one. */
export function dataURLBytes(dataURL: string): { mimeType: string; bytes: Uint8Array } | null {
  const match = /^data:([^;,]*)((?:;[^;,]*)*),/i.exec(dataURL);
  if (!match) return null;
  const mimeType = (match[1] || 'text/plain').toLowerCase();
  const payload = dataURL.slice(match[0].length);
  try {
    if (/;base64/i.test(match[2])) {
      const binary = atob(payload.replace(/\s/g, ''));
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
      return { mimeType, bytes };
    }
    return { mimeType, bytes: new TextEncoder().encode(decodeURIComponent(payload)) };
  } catch {
    return null;
  }
}

/* ---- reading -------------------------------------------------------- */

type Loaded = { dataURL: string; mimeType: string };

/**
 * The images a canvas session has read, by path, so each is read once per
 * open: a drawing taken again from elsewhere, or Reload, reads none twice.
 * A change to one of those files (heard through the store) drops it.
 */
export type ImageCache = {
  read(store: FileStore, entry: FileEntry): Promise<Loaded | null>;
  /** Forgets what was read at `path`, or anywhere under it. */
  forget(path: string): void;
};

export function createImageCache(): ImageCache {
  const known = new Map<string, Promise<Loaded | null>>();
  return {
    read(store, entry) {
      let found = known.get(entry.path);
      if (!found) {
        const mimeType = imageMime(entry.name);
        found = mimeType
          ? store
              .readBlob(entry.path)
              .then(async (blob) => ({ dataURL: await blobToDataURL(blob, mimeType), mimeType }))
              .catch(() => null)
          : Promise.resolve(null);
        // A read that failed is tried again by the next open.
        void found.then((loaded) => loaded === null && known.get(entry.path) === found && known.delete(entry.path));
        known.set(entry.path, found);
      }
      return found;
    },
    forget(path) {
      for (const key of [...known.keys()]) if (key === path || key.startsWith(`${path}/`)) known.delete(key);
    },
  };
}

export type ReferencedImages = {
  /** For Excalidraw: each image read, by file id. */
  files: Record<string, ImageFile>;
  /** File id → the link its line has, for each image read: these stay out
   * of the drawing when it's saved. */
  links: Map<string, string>;
};

const NONE: ReferencedImages = { files: {}, links: new Map() };

/** How many images are read at once. */
const READ_AT_ONCE = 4;

/**
 * The images a drawing names in its Embedded Files section, read from the
 * project: each line whose id an element uses and whose link (resolved from
 * the canvas's path by Nebula's rules, as Obsidian resolves it) is an image
 * file. A line naming a file that isn't there, or that isn't an image (the
 * plugin also embeds notes and PDFs), gives nothing: its element shows as
 * a missing image, and the line stays in the file. An id the drawing holds
 * itself (`present`) is left to the drawing. Never rejects.
 */
export async function readReferencedImages(
  store: FileStore,
  canvasPath: string,
  text: string,
  scene: Pick<ExcalidrawScene, 'elements'>,
  options: { present?: ReadonlySet<string>; cache?: ImageCache; files?: readonly FileEntry[] } = {},
): Promise<ReferencedImages> {
  const used = usedFileIds(scene);
  const wanted = embeddedFiles(text).filter((line) => used.has(line.id) && !options.present?.has(line.id) && imageMime(line.target) !== null);
  if (wanted.length === 0) return NONE;
  let files: readonly FileEntry[];
  try {
    files = options.files ?? (await store.list());
  } catch {
    return NONE;
  }
  const cache = options.cache ?? createImageCache();
  const found: ReferencedImages = { files: {}, links: new Map() };
  // An id named on two lines takes its first line that reads, as the plugin does. One worker takes
  // all of an id's lines in order, so the reads running at once never race for the same id.
  const byId = new Map<string, typeof wanted>();
  for (const line of wanted) byId.set(line.id, [...(byId.get(line.id) ?? []), line]);
  const queue = [...byId.values()];
  const worker = async () => {
    for (let lines = queue.shift(); lines; lines = queue.shift()) {
      for (const line of lines) {
        const entry = resolveLink(line.target, canvasPath, files);
        if (!entry || !imageMime(entry.name)) continue;
        const loaded = await cache.read(store, entry).catch(() => null);
        if (!loaded) continue;
        found.files[line.id] = { id: line.id, mimeType: loaded.mimeType, dataURL: loaded.dataURL, created: entry.modified ?? Date.now() };
        found.links.set(line.id, line.link);
        break;
      }
    }
  };
  await Promise.all(Array.from({ length: READ_AT_ONCE }, worker));
  return found;
}

/** The scene with the images read put in its `files`, beside its own. */
export function withImages<S extends ExcalidrawScene>(scene: S, images: ReferencedImages): S {
  if (Object.keys(images.files).length === 0) return scene;
  return { ...scene, files: { ...(images.files as SceneFiles), ...scene.files } };
}

/* ---- the names of images added -------------------------------------- */

/** A dropped or picked file's name, by the file id Excalidraw gave it, so
 * the image's file can keep it. Ids are the image's hash, so one map serves
 * every canvas. */
const ownNames = new Map<string, string>();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Excalidraw's `generateIdForFile`: the id it makes itself (the SHA-1 of the
 * file, so Obsidian and Nebula give one image one id), remembering the
 * file's name on the way.
 */
export async function fileIdFor(file: File): Promise<string> {
  let id: string;
  try {
    id = hex(new Uint8Array(await crypto.subtle.digest('SHA-1', (await blobBytes(file)) as BufferSource)));
  } catch {
    id = hex(crypto.getRandomValues(new Uint8Array(20)));
  }
  const own = ownImageName(file);
  if (own) ownNames.set(id, own);
  return id;
}

/** The name an added image's file came with, if it had one. */
export function ownNameOf(id: string): string | undefined {
  return ownNames.get(id);
}
