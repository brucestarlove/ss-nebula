/**
 * Move images to files (2.0.4): the images a `.excalidraw.md` drawing holds
 * inside become files in `Attachments/`, and the drawing names them in its
 * `## Embedded Files` section, the Obsidian Excalidraw way. For one canvas
 * (its menu) or every canvas in the project (the project menu).
 *
 * Built to be safe on a real project of hundreds of files:
 *
 *   - it copies first: each image is written create-only, and a canvas is
 *     rewritten only once every file it will name is written and its new
 *     text has been read back and checked;
 *   - the rewrite is `ifUnchanged` against the text read, so a canvas that
 *     changed meanwhile is left as it is, and named;
 *   - a canvas with unsaved changes open in a tab is left, and named;
 *   - nothing is ever deleted: a canvas skipped after its images were
 *     written leaves those files, and a second run finds them again (same
 *     name, same bytes) rather than writing them twice;
 *   - identical bytes become one file: compared by hash within the run,
 *     and with a file already in `Attachments/` under the name it would take;
 *   - one canvas at a time, one image at a time, so memory holds one
 *     drawing.
 */
import { errorName } from '../files/errors';
import { basename, dirname, joinPath, uniqueName } from '../files/paths';
import type { FileEntry, FileStore } from '../files/types';
import { embeddedFiles } from '../nebula/excalidraw/embeddedFiles';
import { readObsidianExcalidrawMarkdown, updateObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawScene } from '../nebula/excalidraw/scene';
import { ATTACHMENTS, blobBytes, imageFileName, imageLink } from './attachments';
import { dataURLBytes, inlineData, usedFileIds } from './views/canvas/canvasImages';
import { resolveLink } from './views/note/links';
import { movableCanvas } from './canvasImageUse';
import { describeName } from './paths';

export type SkipReason = 'unsaved' | 'changed' | 'unreadable' | 'failed';

export type MoveOutRun = {
  /** Images moved out, and the canvases they were in. */
  images: number;
  canvases: number;
  /** New files written (fewer than images when some were the same). */
  written: number;
  /** Canvases left as they were, in the order met, and why. */
  skipped: Array<{ path: string; why: SkipReason }>;
};

export type MoveOutOptions = {
  /** Whether a canvas has changes open in a tab that aren't saved yet. */
  unsaved(path: string): boolean;
  /** Told after each canvas, for a long run's progress. */
  progress?(done: number, total: number): void;
};


function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** FNV-1a, two ways, and the length: for a page without WebCrypto (an
 * address that isn't https or localhost). A match is always checked byte
 * for byte, so a collision only costs a read. */
function plainHash(bytes: Uint8Array): string {
  let a = 0x811c9dc5;
  let b = 0x01000193;
  for (let index = 0; index < bytes.length; index += 1) {
    a = Math.imul(a ^ bytes[index], 0x01000193) >>> 0;
    b = Math.imul(b ^ bytes[bytes.length - 1 - index], 0x811c9dc5) >>> 0;
  }
  return `${bytes.length}-${a.toString(16)}-${b.toString(16)}`;
}

async function hashOf(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle) return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource)));
  return plainHash(bytes);
}

/** Whether the file at `path` holds exactly `bytes`. */
async function holds(store: FileStore, path: string, bytes: Uint8Array): Promise<boolean> {
  return sameBytes(await blobBytes(await store.readBlob(path)), bytes);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

/** How many names one image tries before its canvas is skipped. */
const NAME_ATTEMPTS = 50;

/**
 * The file an image goes to: an existing file in Attachments/ under one of
 * the names it would take (`name`, `name 2`…) that holds exactly its bytes,
 * else a new one, written create-only under the first free name. `files`
 * is the project as listed, and gains what's written.
 */
async function placeImage(store: FileStore, image: { mimeType: string; bytes: Uint8Array }, name: string, files: FileEntry[]): Promise<{ path: string; written: boolean }> {
  const inFolder = () => files.filter((entry) => entry.type === 'file' && dirname(entry.path) === ATTACHMENTS);
  const tried = new Set<string>();
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt += 1) {
    // The next of this image's names: one not looked at yet.
    const candidate = joinPath(ATTACHMENTS, uniqueName(tried, name));
    tried.add(basename(candidate));
    const there = inFolder().find((entry) => entry.path.toLowerCase() === candidate.toLowerCase());
    if (there) {
      if ((there.size === undefined || there.size === image.bytes.length) && (await holds(store, there.path, image.bytes))) return { path: there.path, written: false };
      continue;
    }
    try {
      await store.write(candidate, new Blob([image.bytes as BlobPart], { type: image.mimeType }), { exclusive: true });
      files.push({ path: candidate, name: basename(candidate), type: 'file', size: image.bytes.length });
      return { path: candidate, written: true };
    } catch (error: unknown) {
      if (errorName(error) !== 'FileExistsError') throw error;
      // Taken meanwhile: look at what's there, as for any other.
      const now = await store.stat(candidate).catch(() => null);
      if (now) files.push(now);
      tried.delete(basename(candidate));
    }
  }
  throw new Error('No free name for the image.');
}

/** An image's file name: Obsidian's `Pasted image <time>` from when it was added, else from its id. */
function nameFor(id: string, mimeType: string, created: unknown): string {
  const time = typeof created === 'number' && Number.isFinite(created) && created > 0 ? new Date(created) : null;
  if (time) return imageFileName(mimeType, time);
  const own = imageFileName(mimeType, new Date(0));
  return own.replace(/^Pasted image \d+/, `Image ${id.slice(0, 12)}`);
}

/** Whether the rewritten drawing is the same drawing, with exactly the moved images named instead of held. */
function checks(original: ExcalidrawScene, text: string, path: string, moved: Map<string, string>, files: readonly FileEntry[]): boolean {
  let after: ExcalidrawScene;
  try {
    after = readObsidianExcalidrawMarkdown(text);
  } catch {
    return false;
  }
  const ids = (scene: ExcalidrawScene) => scene.elements.map((element) => String(element.id)).join('\n');
  if (ids(after) !== ids(original)) return false;
  const kept = Object.keys(original.files ?? {}).filter((id) => !moved.has(id)).sort();
  if (Object.keys(after.files ?? {}).sort().join('\n') !== kept.join('\n')) return false;
  for (const id of kept) if ((after.files?.[id] as { dataURL?: unknown }).dataURL !== (original.files?.[id] as { dataURL?: unknown }).dataURL) return false;
  const lines = new Map(embeddedFiles(text).map((line) => [line.id, line.target] as const));
  for (const [id, filePath] of moved) {
    const target = lines.get(id);
    if (!target || resolveLink(target, path, files)?.path !== filePath) return false;
  }
  return true;
}

/** Moves the images inside each canvas out to files. Rejects only when the project can't be listed. */
export async function moveImagesOut(store: FileStore, canvases: readonly string[], { unsaved, progress }: MoveOutOptions): Promise<MoveOutRun> {
  const run: MoveOutRun = { images: 0, canvases: 0, written: 0, skipped: [] };
  const files = (await store.list()).filter((entry) => entry.type === 'file');
  /** Bytes' hash → the file they went to, in this run. */
  const byHash = new Map<string, string>();
  const paths = canvases.filter(movableCanvas);
  let done = 0;
  for (const path of paths) {
    try {
      await moveOne(path);
    } finally {
      done += 1;
      progress?.(done, paths.length);
    }
  }
  return run;

  async function moveOne(path: string) {
    let text: string;
    let scene: ExcalidrawScene;
    try {
      text = await store.readText(path);
      scene = readObsidianExcalidrawMarkdown(text);
    } catch {
      run.skipped.push({ path, why: 'unreadable' });
      return;
    }
    // Images the drawing's elements use, held inside, with no line of their own yet.
    const used = usedFileIds(scene);
    const lined = new Set(embeddedFiles(text).map((line) => line.id));
    const inside = Object.entries(scene.files ?? {}).filter(([id, file]) => used.has(id) && !lined.has(id) && inlineData(file) !== null);
    if (inside.length === 0) return;
    if (unsaved(path)) {
      run.skipped.push({ path, why: 'unsaved' });
      return;
    }
    // Copy first: every file this canvas will name is written before it changes.
    const moved = new Map<string, string>();
    let written = 0;
    try {
      for (const [id, file] of inside) {
        const image = dataURLBytes(inlineData(file)!);
        if (!image) throw new Error('An image’s data couldn’t be read.');
        const hash = await hashOf(image.bytes);
        // The same bytes met earlier in the run, checked against the file itself.
        let target = byHash.get(hash);
        if (target && !(await holds(store, target, image.bytes).catch(() => false))) target = undefined;
        if (!target) {
          const placed = await placeImage(store, image, nameFor(id, image.mimeType, (file as { created?: unknown }).created), files);
          target = placed.path;
          if (placed.written) written += 1;
          byHash.set(hash, target);
        }
        moved.set(id, target);
      }
    } catch {
      run.written += written;
      run.skipped.push({ path, why: 'failed' });
      return;
    }
    run.written += written;
    const drawing = { ...scene, files: Object.fromEntries(Object.entries(scene.files ?? {}).filter(([id]) => !moved.has(id))) };
    const add = [...moved].map(([id, filePath]) => [id, imageLink(filePath, files)] as const);
    const next = updateObsidianExcalidrawMarkdown(text, drawing, { embedded: { add } });
    // Read back before it's written: the same drawing, the moved images named.
    if (!checks(scene, next, path, moved, files)) {
      run.skipped.push({ path, why: 'failed' });
      return;
    }
    if (unsaved(path)) {
      run.skipped.push({ path, why: 'unsaved' });
      return;
    }
    try {
      await store.write(path, next, { ifUnchanged: { text } });
    } catch (error: unknown) {
      run.skipped.push({ path, why: errorName(error) === 'FileChangedError' ? 'changed' : 'failed' });
      return;
    }
    run.images += moved.size;
    run.canvases += 1;
  }
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const WHY: Record<SkipReason, string> = {
  unsaved: 'it has unsaved changes',
  changed: 'changed while moving',
  unreadable: 'couldn’t be read as a drawing',
  failed: 'an image couldn’t be written',
};

/** How many skipped canvases the message names before it counts the rest. */
const NAMED = 5;

/** What the status line says: "Moved 12 images from 4 canvases into Attachments. Skipped 1: “Garden plan” (changed while moving)." */
export function moveOutMessage(run: MoveOutRun): string {
  const said: string[] = [];
  if (run.images > 0) said.push(`Moved ${plural(run.images, 'image', 'images')} from ${plural(run.canvases, 'canvas', 'canvases')} into ${ATTACHMENTS}.`);
  else if (run.skipped.length === 0) said.push('No canvas holds images inside it: there’s nothing to move.');
  if (run.skipped.length > 0) {
    const named = run.skipped.slice(0, NAMED).map(({ path, why }) => `“${describeName(basename(path)).label}” (${WHY[why]})`);
    const more = run.skipped.length - named.length;
    said.push(`Skipped ${run.skipped.length}: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}.`);
  }
  return said.join(' ');
}
