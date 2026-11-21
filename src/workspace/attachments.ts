/**
 * Images kept as files in the project, written the way Obsidian writes them
 * (2.0.4): a pasted or dropped image becomes a file of its own in
 * `Attachments/`, named as Obsidian names a pasted one (`Pasted image
 * 20261121013000.png`) or by the dropped file's own name, written create-only
 * so nothing is ever overwritten, and referenced by the shortest link that
 * names it alone.
 *
 * A canvas (views/canvas/canvasImages.ts) and a note's editor
 * (views/note/editor/imageFiles.ts) both use this, so it holds no drawing and
 * no editor code: the note editor's chunk must not pull Excalidraw in.
 */
import { errorName } from '../files/errors';
import { basename, dirname, extension, joinPath, stem, uniqueName } from '../files/paths';
import type { FileEntry, FileStore } from '../files/types';
import { shortestTarget } from './views/note/links';
import { uploadName } from './upload';

/** Where an image pasted or dropped goes, as Obsidian's "Attachments" folder. */
export const ATTACHMENTS = 'Attachments';

/** The image types Nebula keeps from a paste or drop (and Excalidraw draws), by extension. */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jfif: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
};

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
};

/** The MIME type of an image Nebula keeps, by its name; null for any other file. */
export function imageMime(name: string): string | null {
  return MIME_BY_EXTENSION[extension(name).toLowerCase()] ?? null;
}

/** Whether a MIME type is one an image can be kept as. */
export function isKeptImageType(mimeType: string): boolean {
  return mimeType in EXTENSION_BY_MIME;
}

/** A blob's bytes (through FileReader where a Blob can't give them itself, as in jsdom). */
export async function blobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('The image couldn’t be read.'));
    reader.readAsArrayBuffer(blob);
  });
}

/** A clipboard image's name says nothing (`image.png`): it's named as pasted. */
const CLIPBOARD_NAME = /^(image|blob|pasted graphic)(\.\w+)?$/i;

/** The name a dropped or picked file brings, or undefined when it has none worth
 * keeping (a clipboard image's `image.png`), so the file is named as pasted. */
export function ownImageName(file: { name: string }): string | undefined {
  return file.name && !CLIPBOARD_NAME.test(file.name) ? file.name : undefined;
}

const pad = (value: number) => String(value).padStart(2, '0');

/** Obsidian's name for a pasted image: `Pasted image 20261121013000.png`, in local time. */
export function pastedImageName(now: Date, ext: string): string {
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `Pasted image ${stamp}.${ext}`;
}

/** The name an image takes: its own (a dropped or picked file's), made safe
 * and given its real extension; else Obsidian's pasted-image name. */
export function imageFileName(mimeType: string, now: Date, own?: string): string {
  const ext = EXTENSION_BY_MIME[mimeType];
  if (!ext) throw new Error('This image’s type can’t be kept as a file.');
  if (own) {
    // `#`, `|`, `^` and brackets would break the `[[…]]` that names the file, in a note and in a
    // canvas's Embedded Files alike, so each becomes `_`.
    const safe = uploadName(own.replace(/[#|^[\]]/g, '_'));
    if ('name' in safe) return imageMime(safe.name) === mimeType ? safe.name : `${stem(safe.name) || 'Image'}.${ext}`;
  }
  return pastedImageName(now, ext);
}

/** How many names a create-only write tries before it gives up. */
const NAME_ATTEMPTS = 20;

/**
 * Writes an image as a new file in `folder` (Attachments/ by default, made
 * when needed) and gives back its path. Create-only: a free name among the
 * folder's (`Sky 2.png` when `Sky.png` is taken), and the next one when
 * another writer takes it first, so nothing is ever written over.
 */
export async function writeImageFile(
  store: FileStore,
  bytes: { mimeType: string; bytes: Uint8Array },
  options: { name: string; folder?: string; files: readonly FileEntry[] },
): Promise<string> {
  const folder = options.folder ?? ATTACHMENTS;
  const taken = options.files.filter((entry) => dirname(entry.path) === folder).map((entry) => basename(entry.path));
  const blob = new Blob([bytes.bytes as BlobPart], { type: bytes.mimeType });
  for (let attempt = 1; ; attempt += 1) {
    const path = joinPath(folder, uniqueName(taken, options.name));
    try {
      await store.write(path, blob, { exclusive: true });
      return path;
    } catch (error: unknown) {
      if (errorName(error) !== 'FileExistsError' || attempt >= NAME_ATTEMPTS) throw error;
      taken.push(basename(path));
    }
  }
}

/** The link a reference writes for `path`, in a note's `![[ ]]` or a canvas's
 * Embedded Files line: the shortest that names it alone among `files`, as
 * Obsidian's own are. `files` must include the file itself. */
export function imageLink(path: string, files: readonly FileEntry[]): string {
  return shortestTarget(path, files);
}
