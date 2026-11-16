/** Blob helpers that also work on jsdom's Blob, which has no arrayBuffer()
 * or text(): other lanes test with MemoryFileStore under jsdom. */

export async function blobToBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') return new Uint8Array(await blob.arrayBuffer());
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the blob'));
    reader.readAsArrayBuffer(blob);
  });
}

/** UTF-8, keeping a leading byte-order mark so text round-trips exactly. */
export async function blobToText(blob: Blob): Promise<string> {
  return new TextDecoder('utf-8', { ignoreBOM: true }).decode(await blobToBytes(blob));
}

const encoder = new TextEncoder();
const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/**
 * Whether `blob` holds exactly `text` as UTF-8 (round 5, a write's
 * `ifUnchanged`), checked under the file's exclusive lock on every save, so
 * its cost matters:
 *
 * - a size no UTF-8 encoding of the text can have (1 to 3 bytes per UTF-16
 *   unit) is false at once, without reading;
 * - otherwise the file is decoded strictly and compared with ===. Strict
 *   (fatal) decoding never maps two byte sequences to one string, and fails
 *   on bytes that aren't UTF-8, so this is exact; the BOM is kept.
 *
 * Measured in Node 24 at 16 MB: 67 ms against 118 ms for encoding the text
 * and comparing byte by byte. Counting the text's UTF-8 length in script
 * first cost more than encoding it (V8's encoder is native), so it isn't
 * done. A text with a lone surrogate (rare: it is written as U+FFFD) is
 * compared as the bytes TextEncoder makes of it.
 */
export async function holdsText(blob: Blob, text: string): Promise<boolean> {
  if (blob.size < text.length || blob.size > 3 * text.length) return false;
  const bytes = await blobToBytes(blob);
  if (!isWellFormed(text)) {
    const expected = encoder.encode(text);
    if (expected.length !== bytes.length) return false;
    for (let index = 0; index < expected.length; index += 1) if (bytes[index] !== expected[index]) return false;
    return true;
  }
  try {
    return strictUtf8.decode(bytes) === text;
  } catch {
    return false;
  }
}

const loneSurrogate = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** String.prototype.isWellFormed where there is one (every current engine). */
function isWellFormed(text: string): boolean {
  const native = (text as { isWellFormed?: () => boolean }).isWellFormed;
  return typeof native === 'function' ? native.call(text) : !loneSurrogate.test(text);
}

/** Compared in slices of this size (S9): never two whole copies in memory. */
const COMPARE_SLICE = 8 * 1024 * 1024;

export async function sameBlobs(a: Blob, b: Blob): Promise<boolean> {
  if (a.size !== b.size) return false;
  for (let offset = 0; offset < a.size || offset === 0; offset += COMPARE_SLICE) {
    const [left, right] = await Promise.all([blobToBytes(a.slice(offset, offset + COMPARE_SLICE)), blobToBytes(b.slice(offset, offset + COMPARE_SLICE))]);
    if (!sameBytes(left, right)) return false;
    if (a.size === 0) break;
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false;
  return true;
}
