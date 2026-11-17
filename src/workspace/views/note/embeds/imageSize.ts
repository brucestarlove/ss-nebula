/**
 * An image's size in pixels, read from the first bytes of its file, so a
 * note can keep the picture's place before the picture has been drawn
 * (embedBoxes.ts). PNG, GIF, JPEG (with its EXIF turn) and WebP; anything
 * else, an SVG included, is null and the page lets the picture settle as it
 * loads. Pure: bytes in, size out.
 */

export type ImageSize = { width: number; height: number };

/** A JPEG's size is after its EXIF block and any thumbnails, which can run to a few segments of 64 KB. */
export const HEAD_BYTES = 256 * 1024;

const MAX_SIDE = 100_000;

function size(width: number, height: number): ImageSize | null {
  return width > 0 && height > 0 && width <= MAX_SIDE && height <= MAX_SIDE ? { width, height } : null;
}

function ascii(bytes: Uint8Array, at: number, text: string): boolean {
  for (let i = 0; i < text.length; i += 1) if (bytes[at + i] !== text.charCodeAt(i)) return false;
  return true;
}

const u16be = (b: Uint8Array, at: number) => (b[at] << 8) | b[at + 1];
const u16le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8);
const u24le = (b: Uint8Array, at: number) => b[at] | (b[at + 1] << 8) | (b[at + 2] << 16);
const u32be = (b: Uint8Array, at: number) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0;
const u32le = (b: Uint8Array, at: number) => (b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>> 0;

function png(b: Uint8Array): ImageSize | null {
  // The 8-byte signature, then the IHDR chunk: its length, its name, the width and the height.
  if (b.length < 24 || !(b[0] === 0x89 && ascii(b, 1, 'PNG\r\n') && b[6] === 0x1a && b[7] === 0x0a) || !ascii(b, 12, 'IHDR')) return null;
  return size(u32be(b, 16), u32be(b, 20));
}

function gif(b: Uint8Array): ImageSize | null {
  if (b.length < 10 || !ascii(b, 0, 'GIF8')) return null;
  return size(u16le(b, 6), u16le(b, 8));
}

function webp(b: Uint8Array): ImageSize | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Lossy: a frame tag, a start code, then 14 bits each.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return size(u16le(b, 26) & 0x3fff, u16le(b, 28) & 0x3fff);
  }
  if (ascii(b, 12, 'VP8L')) {
    if (b[20] !== 0x2f) return null;
    const bits = u32le(b, 21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (ascii(b, 12, 'VP8X')) return size(u24le(b, 24) + 1, u24le(b, 27) + 1);
  return null;
}

/** The EXIF orientation (1 to 8) of a JPEG's APP1 segment, which starts at `at` (the 'Exif' after the segment's length). */
function exifOrientation(b: Uint8Array, at: number, end: number): number {
  const tiff = at + 6;
  if (!ascii(b, at, 'Exif\0\0') || tiff + 8 > end) return 1;
  const little = b[tiff] === 0x49 && b[tiff + 1] === 0x49;
  if (!little && !(b[tiff] === 0x4d && b[tiff + 1] === 0x4d)) return 1;
  const u16 = (pos: number) => (little ? u16le(b, pos) : u16be(b, pos));
  const u32 = (pos: number) => (little ? u32le(b, pos) : u32be(b, pos));
  const first = tiff + u32(tiff + 4);
  if (first + 2 > end) return 1;
  const count = u16(first);
  for (let i = 0; i < count; i += 1) {
    const entry = first + 2 + i * 12;
    if (entry + 12 > end) return 1;
    if (u16(entry) === 0x0112) {
      const value = u16(entry + 8);
      return value >= 1 && value <= 8 ? value : 1;
    }
  }
  return 1;
}

function jpeg(b: Uint8Array): ImageSize | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let at = 2;
  let orientation = 1;
  while (at + 4 <= b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    // Fill bytes, and markers that stand alone (no length).
    if (marker === 0xff) {
      at += 1;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      at += 2;
      continue;
    }
    // The picture itself begins: no size was given before it.
    if (marker === 0xda || marker === 0xd9) return null;
    const length = u16be(b, at + 2);
    if (length < 2) return null;
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b, at + 4, Math.min(b.length, at + 2 + length));
    const isFrame = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      if (at + 9 > b.length) return null;
      const height = u16be(b, at + 5);
      const width = u16be(b, at + 7);
      // Orientations 5 to 8 turn the picture a quarter: browsers draw it that way up.
      return orientation >= 5 ? size(height, width) : size(width, height);
    }
    at += 2 + length;
  }
  return null;
}

/** The size the first bytes of an image file give, or null (not an image of these kinds, or the size isn't in the bytes given). */
export function imageSize(bytes: Uint8Array): ImageSize | null {
  try {
    return png(bytes) ?? gif(bytes) ?? jpeg(bytes) ?? webp(bytes);
  } catch {
    return null;
  }
}

/** The size of an image blob, from its head only (a large file isn't read whole for it); null if it can't be told. */
export async function readImageSize(blob: Blob): Promise<ImageSize | null> {
  try {
    return imageSize(new Uint8Array(await blob.slice(0, HEAD_BYTES).arrayBuffer()));
  } catch {
    return null;
  }
}
