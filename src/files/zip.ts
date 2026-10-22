/**
 * Download a project as a .zip (PLAN §7: browser-tier files belong to one
 * browser, so Nebula always offers a copy). Every file and folder goes in, and
 * so does `.nebula/project.json`, so the project keeps its name and colour
 * when it is opened again. The workspace state (open tabs) belongs to this
 * browser and stays behind.
 */
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';
import { blobToBytes } from './bytes';
import { errorName } from './errors';
import { ancestors, basename, comparePaths, dirname, portableName, uniqueName } from './paths';
import type { FileStore } from './types';

export type ZipOptions = {
  /** Put every entry in this folder: the project's name, usually. */
  folder?: string;
};

/** The `.nebula/` files that travel with a project. list() hides `.nebula/`,
 * so they are named here; workspace.json is left out on purpose. */
const TRAVELLING_SETTINGS = ['.nebula/project.json', '.nebula/legacy-metadata.json'];

// Already compressed: store them as they are rather than deflate again.
const STORED_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'pdf', 'zip', 'mp3', 'm4a', 'ogg', 'oga', 'opus', 'flac', 'aac', 'mp4', 'webm', 'mov', 'm4v', 'ogv', 'woff', 'woff2']);
const EARLIEST_ZIP_TIME = Date.UTC(1980, 0, 2);
/** How much of a file is read at once. */
const SLICE_BYTES = 1024 * 1024;
/** How much of the archive gathers before it's handed to a Blob, which the
 * browser can keep out of the page's memory. */
const PART_BYTES = 8 * 1024 * 1024;

function level(path: string): 0 | 6 {
  const dot = path.lastIndexOf('.');
  return dot > path.lastIndexOf('/') && STORED_EXTENSIONS.has(path.slice(dot + 1).toLowerCase()) ? 0 : 6;
}

/** The archive as it's made, in Blob parts of a few megabytes. */
class BlobParts {
  private readonly parts: Blob[] = [];
  private chunks: Uint8Array[] = [];
  private size = 0;

  add(chunk: Uint8Array): void {
    this.chunks.push(chunk);
    this.size += chunk.length;
    if (this.size >= PART_BYTES) this.flush();
  }

  blob(type: string): Blob {
    this.flush();
    return new Blob(this.parts, { type });
  }

  private flush(): void {
    if (this.chunks.length === 0) return;
    this.parts.push(new Blob(this.chunks as Uint8Array<ArrayBuffer>[]));
    this.chunks = [];
    this.size = 0;
  }
}

/** Where each path goes in the archive: names that wouldn't unpack on
 * Windows or macOS mapped (portableName), and names that would land on one
 * another there (case, Unicode composition, or the mapping) kept apart, as
 * 'Name 2.ext'. Folders map once, for everything inside them (review
 * finding 22). */
function archivePaths(paths: string[]): Map<string, string> {
  const mapped = new Map<string, string>([['', '']]);
  const taken = new Map<string, string[]>();
  const place = (path: string): string => {
    const known = mapped.get(path);
    if (known !== undefined) return known;
    const parent = place(dirname(path));
    const siblings = taken.get(parent) ?? [];
    const name = uniqueName(siblings, portableName(basename(path)));
    siblings.push(name);
    taken.set(parent, siblings);
    const result = parent ? `${parent}/${name}` : name;
    mapped.set(path, result);
    return result;
  };
  for (const path of [...paths].sort(comparePaths)) place(path);
  return mapped;
}

/**
 * The project as a .zip Blob. Each file is read a slice at a time and
 * streamed through fflate's Zip into Blob parts, so a project of big videos
 * never sits whole in memory (review finding 25). The archive holds what
 * zipSync's would: the same entries, bytes, methods, UTF-8 flags and times;
 * only the sizes come after each entry's data, as in any streamed zip.
 */
export async function projectToZip(store: FileStore, options: ZipOptions = {}): Promise<Blob> {
  const prefix = options.folder ? `${zipFolderName(options.folder)}/` : '';
  const items = await store.list();
  const paths = archivePaths(items.map((item) => item.path));
  // Folders with something in them come with their contents; an empty folder
  // needs an entry of its own to survive.
  const filled = new Set(items.flatMap((item) => ancestors(item.path)));

  const parts = new BlobParts();
  let failure: unknown = null;
  let finish: () => void = () => {};
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const zip = new Zip((error, chunk, final) => {
    if (error) {
      failure = error;
      finish();
      return;
    }
    parts.add(chunk);
    if (final) finish();
  });
  const check = () => {
    if (failure !== null) throw failure;
  };

  for (const item of items) {
    const name = `${prefix}${paths.get(item.path) ?? item.path}`;
    if (item.type === 'dir') {
      if (!filled.has(item.path)) addEmptyFolder(zip, `${name}/`);
    } else {
      await addFile(zip, name, await store.readBlob(item.path), item.path, item.modified);
    }
    check();
  }
  for (const path of TRAVELLING_SETTINGS) {
    let blob: Blob;
    let modified: number | undefined;
    try {
      const stat = await store.stat(path);
      if (stat?.type !== 'file') continue;
      modified = stat.modified;
      blob = await store.readBlob(path);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') continue;
      throw error;
    }
    await addFile(zip, `${prefix}${path}`, blob, path, modified);
    check();
  }
  zip.end();
  await finished;
  check();
  return parts.blob('application/zip');
}

function addEmptyFolder(zip: Zip, name: string): void {
  const entry = new ZipPassThrough(name);
  zip.add(entry);
  entry.push(new Uint8Array(0), true);
}

async function addFile(zip: Zip, name: string, blob: Blob, path: string, modified: number | undefined): Promise<void> {
  const entry = level(path) === 0 ? new ZipPassThrough(name) : new ZipDeflate(name, { level: 6 });
  if (modified && modified >= EARLIEST_ZIP_TIME) entry.mtime = new Date(modified);
  zip.add(entry);
  if (blob.size === 0) {
    entry.push(new Uint8Array(0), true);
    return;
  }
  for (let start = 0; start < blob.size; start += SLICE_BYTES) {
    const end = Math.min(blob.size, start + SLICE_BYTES);
    entry.push(await blobToBytes(blob.slice(start, end)), end === blob.size);
  }
}

function zipFolderName(name: string): string {
  return (
    name
      // eslint-disable-next-line no-control-regex
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
      .replace(/[/\\:*?"<>|]/g, '-')
      .trim()
      .replace(/^\.+/, '')
      .replace(/[. ]+$/, '') || 'Project'
  );
}

/** 'Night Sky.zip': the project's name, made safe for any file system. */
export function zipFileName(projectName: string): string {
  return `${zipFolderName(projectName)}.zip`;
}
