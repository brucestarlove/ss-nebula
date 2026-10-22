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

/** Whether `blob` holds exactly `text` as UTF-8 (round 5, a write's
 * `ifUnchanged`): the size first, then every byte. */
export async function holdsText(blob: Blob, text: string): Promise<boolean> {
  const expected = encoder.encode(text);
  if (blob.size !== expected.length) return false;
  const bytes = await blobToBytes(blob);
  for (let index = 0; index < expected.length; index += 1) if (bytes[index] !== expected[index]) return false;
  return true;
}
