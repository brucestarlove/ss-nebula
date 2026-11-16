import { mimeFromName } from './views/shared/mime';

/**
 * Readies an image the user picked as a background: a web format, at most MAX_BACKDROP_SIDE on its
 * long side, kept as it is when it already is one; and a tiny JPEG preview
 * that paints at once on the next load. Nothing leaves the browser.
 */
export const MAX_BACKDROP_BYTES = 50 * 1024 * 1024;
export const MAX_BACKDROP_SIDE = 3200;
const PREVIEW_SIDE = 40;

/** Formats every browser Nebula supports opens, kept as they come. */
const WEB_FORMATS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/gif': 'gif',
};

export class BackdropImageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackdropImageError';
  }
}

export type BitmapLike = { width: number; height: number; close(): void };

/** The browser's image work, replaceable in tests (jsdom has none of it). */
export type BackdropTools = {
  decode(file: Blob): Promise<BitmapLike>;
  /** The image at width × height, as a JPEG over `fill`. */
  scale(bitmap: BitmapLike, width: number, height: number, fill: string): Promise<Blob>;
  /** A data: URL of the image at width × height, over `fill`. */
  preview(bitmap: BitmapLike, width: number, height: number, fill: string): string | null;
};

export type PreparedBackdrop = { blob: Blob; ext: string; thumb: string | null };

const CANT_OPEN = 'This browser can’t open that image.';

function draw(bitmap: BitmapLike, width: number, height: number, fill: string): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new BackdropImageError(CANT_OPEN);
  // JPEG has no transparency: what was clear shows the theme's colour.
  context.fillStyle = fill;
  context.fillRect(0, 0, width, height);
  context.imageSmoothingQuality = 'high';
  context.drawImage(bitmap as ImageBitmap, 0, 0, width, height);
  return canvas;
}

const browserTools: BackdropTools = {
  decode: (file) => createImageBitmap(file),
  async scale(bitmap, width, height, fill) {
    const canvas = draw(bitmap, width, height, fill);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.9));
    if (!blob) throw new BackdropImageError(CANT_OPEN);
    return blob;
  },
  preview(bitmap, width, height, fill) {
    return draw(bitmap, width, height, fill).toDataURL('image/jpeg', 0.7);
  },
};

export async function prepareBackdropImage(
  file: File,
  options: { fill: string; maxSide?: number; tools?: BackdropTools },
): Promise<PreparedBackdrop> {
  const { fill, maxSide = MAX_BACKDROP_SIDE, tools = browserTools } = options;
  if (file.size > MAX_BACKDROP_BYTES) throw new BackdropImageError('That image is over 50 MB.');
  const type = (file.type || mimeFromName(file.name)).toLowerCase();
  if (!type.startsWith('image/')) throw new BackdropImageError('That isn’t an image.');
  // An SVG shows as it is: CSS draws it at any size, and runs none of its scripts.
  if (type === 'image/svg+xml') return { blob: file, ext: 'svg', thumb: null };

  let bitmap: BitmapLike;
  try {
    bitmap = await tools.decode(file);
  } catch {
    throw new BackdropImageError(CANT_OPEN);
  }
  try {
    const long = Math.max(bitmap.width, bitmap.height);
    if (!(long > 0)) throw new BackdropImageError(CANT_OPEN);
    const size = (scale: number) => [Math.max(1, Math.round(bitmap.width * scale)), Math.max(1, Math.round(bitmap.height * scale))] as const;
    const fit = Math.min(1, maxSide / long);
    const keep = WEB_FORMATS[type] !== undefined && fit === 1;
    const blob = keep ? file : await tools.scale(bitmap, ...size(fit), fill);
    let thumb: string | null = null;
    try {
      thumb = tools.preview(bitmap, ...size(PREVIEW_SIDE / long), fill);
    } catch {
      // The image still works without its preview; the colour shows first.
    }
    return { blob, ext: keep ? WEB_FORMATS[type] : 'jpg', thumb };
  } finally {
    bitmap.close();
  }
}
