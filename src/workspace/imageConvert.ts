import { blobToBytes } from '../files/bytes';
import { errorName } from '../files/errors';
import { formatBytes } from '../files/persist';
import { basename, dirname, extension, joinPath, stem, uniqueName } from '../files/paths';
import type { FileStore } from '../files/types';

/**
 * Image conversion, built in (Bruce, 2026-10-25: Obsidian's Image Converter
 * plugin, "which i mostly used to change format to webp and maybe change
 * image resolution"). Right-click an image, or a folder of them, in the file
 * tree. It all happens on this device: the browser decodes the image, draws
 * it at the size asked for, and encodes it again. Encoding again also leaves
 * out what the file carried besides its pixels, such as where a photo was
 * taken (EXIF).
 */

export type ImageFormat = 'webp' | 'jpeg' | 'png';

export type ConvertChoice = {
  format: ImageFormat;
  /** 0 to 1, for WebP and JPEG; PNG is lossless. */
  quality: number;
  /** The longest side in pixels, or null for the image's own size. */
  side: number | null;
  /** 'replace' writes the new file, then removes the original. */
  then: 'keep' | 'replace';
};

export const FORMATS: ReadonlyArray<{ value: ImageFormat; label: string; type: string }> = [
  { value: 'webp', label: 'WebP', type: 'image/webp' },
  { value: 'jpeg', label: 'JPEG', type: 'image/jpeg' },
  { value: 'png', label: 'PNG', type: 'image/png' },
];

/** The longest-side choices the dialog offers, besides the image's own size. */
export const SIDES = [2560, 1920, 1280, 800] as const;

export const DEFAULT_CHOICE: ConvertChoice = { format: 'webp', quality: 0.8, side: null, then: 'keep' };

const SOURCE_FORMATS: Record<string, string> = { png: 'PNG', jpg: 'JPEG', jpeg: 'JPEG', webp: 'WebP', avif: 'AVIF', gif: 'GIF' };
const SAME_FORMAT: Record<ImageFormat, string[]> = { webp: ['webp'], jpeg: ['jpg', 'jpeg'], png: ['png'] };
const NEW_EXTENSION: Record<ImageFormat, string> = { webp: 'webp', jpeg: 'jpg', png: 'png' };

/** Images a browser decodes. Not SVG: it has no pixels to convert. */
export function isConvertible(name: string): boolean {
  return extension(name).toLowerCase() in SOURCE_FORMATS;
}

/** 'PNG', 'JPEG', …; '' for what isn't convertible. */
export function sourceFormat(name: string): string {
  return SOURCE_FORMATS[extension(name).toLowerCase()] ?? '';
}

function labelOf(format: ImageFormat): string {
  return FORMATS.find((option) => option.value === format)!.label;
}

export function typeOf(format: ImageFormat): string {
  return FORMATS.find((option) => option.value === format)!.type;
}

function inFormat(name: string, format: ImageFormat): boolean {
  return SAME_FORMAT[format].includes(extension(name).toLowerCase());
}

/** The name in the new format: the same name, as written, when the format stays. */
export function targetName(name: string, format: ImageFormat): string {
  return inFormat(name, format) ? name : `${stem(name)}.${NEW_EXTENSION[format]}`;
}

export type Size = { width: number; height: number };

/** The size for a longest side, keeping the shape; never bigger than the image. */
export function outputSize(size: Size, side: number | null): Size {
  const long = Math.max(size.width, size.height);
  if (side === null || !(side < long)) return { width: size.width, height: size.height };
  const scale = side / long;
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) };
}

/* ---- images that move ---------------------------------------------- */

const text = (bytes: Uint8Array, start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));

function pngMoves(bytes: Uint8Array): boolean {
  // An animated PNG has an acTL chunk before its first IDAT.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 8; at + 8 <= bytes.length; ) {
    const type = text(bytes, at + 4, 4);
    if (type === 'acTL') return true;
    if (type === 'IDAT') return false;
    at += 12 + view.getUint32(at);
  }
  return false;
}

function skipSubBlocks(bytes: Uint8Array, at: number): number {
  while (at < bytes.length) {
    const length = bytes[at];
    at += 1;
    if (length === 0) break;
    at += length;
  }
  return at;
}

function gifMoves(bytes: Uint8Array): boolean {
  let at = 13;
  if (bytes[10] & 0x80) at += 3 * (1 << ((bytes[10] & 0x07) + 1));
  let frames = 0;
  while (at < bytes.length) {
    const block = bytes[at];
    if (block === 0x21) {
      at = skipSubBlocks(bytes, at + 2);
    } else if (block === 0x2c) {
      frames += 1;
      if (frames > 1) return true;
      const packed = bytes[at + 9];
      at += 10;
      if (packed & 0x80) at += 3 * (1 << ((packed & 0x07) + 1));
      at = skipSubBlocks(bytes, at + 1);
    } else {
      break;
    }
  }
  return false;
}

/** Whether the image is animated: a GIF with more than one frame, an animated
 * PNG, WebP or AVIF. Converting to a still format would keep only the first
 * frame, so those are left as they are. */
export function imageMoves(bytes: Uint8Array): boolean {
  if (bytes.length >= 8 && bytes[0] === 0x89 && text(bytes, 1, 3) === 'PNG') return pngMoves(bytes);
  if (bytes.length >= 13 && text(bytes, 0, 3) === 'GIF') return gifMoves(bytes);
  if (bytes.length >= 21 && text(bytes, 0, 4) === 'RIFF' && text(bytes, 8, 4) === 'WEBP') return text(bytes, 12, 4) === 'VP8X' && (bytes[20] & 0x02) !== 0;
  if (bytes.length >= 12 && text(bytes, 4, 4) === 'ftyp') {
    const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
    const brands = text(bytes, 8, Math.min(size, bytes.length) - 8);
    for (let at = 0; at + 4 <= brands.length; at += 4) if (brands.slice(at, at + 4) === 'avis') return true;
  }
  return false;
}

/* ---- the browser's part ---------------------------------------------- */

export type BitmapLike = { width: number; height: number; close(): void };

/** The browser's image work, replaceable in tests (jsdom has none of it). */
export type ImageTools = {
  decode(blob: Blob): Promise<BitmapLike>;
  /** The image at width × height in `type`; over `fill` when it is set. Null when the browser can't. */
  encode(bitmap: BitmapLike, width: number, height: number, type: string, quality: number | undefined, fill: string | null): Promise<Blob | null>;
  canEncode(type: string): Promise<boolean>;
};

function canvasOf(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

const encodable = new Map<string, Promise<boolean>>();

export const browserImageTools: ImageTools = {
  // Upright as the camera meant it (EXIF orientation), as browsers do by default.
  decode: (blob) => createImageBitmap(blob),
  async encode(bitmap, width, height, type, quality, fill) {
    // Halving first keeps detail when shrinking a lot, in browsers whose
    // single-step smoothing is rough.
    let source: CanvasImageSource = bitmap as unknown as ImageBitmap;
    let from = { width: bitmap.width, height: bitmap.height };
    while (from.width / 2 >= width && from.height / 2 >= height) {
      const half = { width: Math.round(from.width / 2), height: Math.round(from.height / 2) };
      const step = canvasOf(half.width, half.height);
      const context = step.getContext('2d');
      if (!context) return null;
      context.imageSmoothingQuality = 'high';
      context.drawImage(source, 0, 0, half.width, half.height);
      source = step;
      from = half;
    }
    const canvas = canvasOf(width, height);
    const context = canvas.getContext('2d');
    if (!context) return null;
    if (fill) {
      context.fillStyle = fill;
      context.fillRect(0, 0, width, height);
    }
    context.imageSmoothingQuality = 'high';
    context.drawImage(source, 0, 0, width, height);
    return new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, quality));
  },
  canEncode(type) {
    // A browser that can't write a type writes PNG instead, so ask once and look.
    let known = encodable.get(type);
    if (!known) {
      known = new Promise<boolean>((resolve) => {
        try {
          canvasOf(1, 1).toBlob((blob) => resolve(blob?.type === type), type);
        } catch {
          resolve(false);
        }
      });
      encodable.set(type, known);
    }
    return known;
  },
};

/* ---- converting -------------------------------------------------------- */

export type ConvertOutcome =
  | { path: string; status: 'converted'; to: string; before: number; after: number; replaced: boolean }
  | { path: string; status: 'skipped'; reason: 'moves' | 'not-smaller' | 'already' }
  | { path: string; status: 'failed'; message: string };

export class ImageConvertError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImageConvertError';
  }
}

/** Converts one decoded image. */
export async function encodeImage(bitmap: BitmapLike, choice: ConvertChoice, tools: ImageTools): Promise<Blob> {
  const type = typeOf(choice.format);
  if (!(await tools.canEncode(type))) throw new ImageConvertError(`This browser can’t write ${labelOf(choice.format)} images.`);
  const size = outputSize(bitmap, choice.side);
  // JPEG has no transparency: what was clear turns white rather than black.
  const fill = choice.format === 'jpeg' ? '#ffffff' : null;
  const blob = await tools.encode(bitmap, size.width, size.height, type, choice.format === 'png' ? undefined : choice.quality, fill);
  if (!blob || blob.type !== type) throw new ImageConvertError('This browser couldn’t make it at that size. A smaller one may work.');
  return blob;
}

type ConvertOptions = {
  tools?: ImageTools;
  /** Skip what wouldn't get smaller, and what is already in the format at that size: for whole folders. */
  onlySmaller?: boolean;
  /** Results already made (the dialog's preview), written as they are. */
  prepared?: ReadonlyMap<string, Blob>;
  signal?: AbortSignal;
  /** Before each image: how many are done, of how many, and which is next. */
  onProgress?(done: number, total: number, path: string): void;
  /** When an original is about to go for its new file: after the new file is
   * in, before the original is removed, so the workspace can move its tab,
   * star and place across first (a remove alone would close the tab). */
  onReplace?(from: string, to: string): void;
};

/**
 * Converts the images at `paths`, one at a time. The new file is written
 * under a free name (nothing is ever written over another file); with
 * 'replace' the original is removed only once the new file is in, and when
 * the name stays the same, the file is written over in one step.
 */
export async function convertImages(store: FileStore, paths: readonly string[], choice: ConvertChoice, options: ConvertOptions = {}): Promise<ConvertOutcome[]> {
  const { tools = browserImageTools, onlySmaller = false, prepared, signal, onProgress, onReplace } = options;
  const taken = new Set((await store.list()).map((entry) => entry.path));
  const outcomes: ConvertOutcome[] = [];
  for (const [index, path] of paths.entries()) {
    if (signal?.aborted) break;
    onProgress?.(index, paths.length, path);
    try {
      outcomes.push(await convertOne(path));
    } catch (reason) {
      outcomes.push({ path, status: 'failed', message: reason instanceof ImageConvertError ? reason.message : `Couldn’t convert it: ${reason instanceof Error ? reason.message : String(reason)}` });
    }
  }
  return outcomes;

  async function convertOne(path: string): Promise<ConvertOutcome> {
    const original = await store.readBlob(path);
    if (imageMoves(await blobToBytes(original))) return { path, status: 'skipped', reason: 'moves' };
    let blob = prepared?.get(path);
    if (!blob) {
      let bitmap: BitmapLike;
      try {
        bitmap = await tools.decode(original);
      } catch {
        throw new ImageConvertError('This browser can’t open it.');
      }
      try {
        const size = outputSize(bitmap, choice.side);
        if (onlySmaller && inFormat(path, choice.format) && size.width === bitmap.width && size.height === bitmap.height) return { path, status: 'skipped', reason: 'already' };
        blob = await encodeImage(bitmap, choice, tools);
      } finally {
        bitmap.close();
      }
    }
    if (onlySmaller && blob.size >= original.size) return { path, status: 'skipped', reason: 'not-smaller' };

    const folder = dirname(path);
    const name = targetName(basename(path), choice.format);
    const replace = choice.then === 'replace';
    if (replace && name === basename(path)) {
      await store.write(path, blob);
      return { path, status: 'converted', to: path, before: original.size, after: blob.size, replaced: true };
    }
    const to = await writeFree(folder, name, blob);
    if (replace) {
      onReplace?.(path, to);
      await store.remove(path);
      taken.delete(path);
    }
    return { path, status: 'converted', to, before: original.size, after: blob.size, replaced: replace };
  }

  /** Writes under the name, or the first free numbered one. */
  async function writeFree(folder: string, name: string, blob: Blob): Promise<string> {
    for (let attempt = 0; ; attempt += 1) {
      const siblings = [...taken].filter((other) => dirname(other) === folder).map((other) => basename(other));
      const to = joinPath(folder, uniqueName(siblings, name));
      try {
        await store.write(to, blob, { exclusive: true });
        taken.add(to);
        return to;
      } catch (reason) {
        // Made in the meantime (another tab): count it as taken and try the next.
        if (errorName(reason) !== 'FileExistsError' || attempt >= 3) throw reason;
        taken.add(to);
      }
    }
  }
}

/** The status line's words once a conversion is done. */
export function describeConversions(outcomes: readonly ConvertOutcome[], options: { folder?: boolean } = {}): string {
  const converted = outcomes.filter((outcome) => outcome.status === 'converted');
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped');
  const failed = outcomes.filter((outcome) => outcome.status === 'failed');
  if (!options.folder && outcomes.length === 1) {
    const [only] = outcomes;
    const name = basename(only.path);
    if (only.status === 'skipped') return `“${name}” ${only.reason === 'moves' ? 'moves, so it' : 'wouldn’t get smaller, so it'} stayed as it is.`;
    if (only.status === 'failed') return `Couldn’t convert “${name}”: ${only.message}`;
    const sizes = `${formatBytes(only.before)} → ${formatBytes(only.after)}`;
    if (only.to === only.path) return `Converted “${name}”: ${sizes}.`;
    if (only.replaced) return `Replaced “${name}” with “${basename(only.to)}”: ${sizes}.`;
    return `Saved “${basename(only.to)}” next to “${name}”: ${sizes}.`;
  }
  const said: string[] = [];
  const stayed = skipped.length === 1 ? '1 stayed as it was.' : `${skipped.length} stayed as they were.`;
  if (converted.length > 0) {
    const before = converted.reduce((sum, outcome) => sum + outcome.before, 0);
    const after = converted.reduce((sum, outcome) => sum + outcome.after, 0);
    said.push(`Converted ${converted.length === 1 ? '1 image' : `${converted.length} images`}: ${formatBytes(before)} → ${formatBytes(after)}.`);
    if (skipped.length > 0) said.push(stayed);
  } else {
    said.push(skipped.length > 0 ? `No images were converted: ${stayed}` : 'No images were converted.');
  }
  if (failed.length > 0) said.push(`Couldn’t convert ${failed.length}: ${failed.map((outcome) => basename(outcome.path)).join(', ')}.`);
  return said.join(' ');
}

/* ---- the choices, kept on this device ----------------------------------- */

const CHOICES_KEY = 'nebula:convert-images';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

function localStore(): StorageLike | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readChoices(storage: StorageLike | null = localStore()): ConvertChoice {
  try {
    const raw = JSON.parse(storage?.getItem(CHOICES_KEY) ?? 'null') as Partial<ConvertChoice> | null;
    if (!raw || typeof raw !== 'object') return { ...DEFAULT_CHOICE };
    const format = FORMATS.some((option) => option.value === raw.format) ? (raw.format as ImageFormat) : null;
    const quality = typeof raw.quality === 'number' && raw.quality >= 0.1 && raw.quality <= 1 ? raw.quality : null;
    const side = raw.side === null || (typeof raw.side === 'number' && Number.isInteger(raw.side) && raw.side > 0) ? raw.side : undefined;
    const then = raw.then === 'keep' || raw.then === 'replace' ? raw.then : null;
    if (!format || quality === null || side === undefined || !then) return { ...DEFAULT_CHOICE };
    return { format, quality, side, then };
  } catch {
    return { ...DEFAULT_CHOICE };
  }
}

export function writeChoices(choice: ConvertChoice, storage: StorageLike | null = localStore()): void {
  try {
    storage?.setItem(CHOICES_KEY, JSON.stringify(choice));
  } catch {
    // A full or blocked storage only means the choices aren't remembered.
  }
}
