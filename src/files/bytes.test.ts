import { describe, expect, it } from 'vitest';
import { blobToBytes, holdsText } from './bytes';

/** Round 6, H8: the precondition's cost is proportional, and stays exact. */

const samples = ['', 'plain ascii', 'é ü ß', '✦ 星 — “quotes”', '🜂🌌 astral', '\uFEFFwith a BOM', 'line\r\nends', 'lone \uD800 high', 'lone \uDC00 low', 'pair at end \uD83C', '\uDBFF\uDFFF max'];

describe('holdsText', () => {
  it('holds exactly the text, BOM and line ends included', async () => {
    for (const text of samples) expect(await holdsText(new Blob([text]), text), JSON.stringify(text)).toBe(true);
    expect(await holdsText(new Blob(['\uFEFFtext']), 'text')).toBe(false);
    expect(await holdsText(new Blob(['a\r\nb']), 'a\nb')).toBe(false);
  });

  it('tells apart two texts of one size that differ in one byte in the middle', async () => {
    const half = 'x'.repeat(50_000);
    const text = `${half}1${half}`;
    expect(await holdsText(new Blob([text]), `${half}2${half}`)).toBe(false);
    expect(await holdsText(new Blob([text]), text)).toBe(true);
    // One character for another of the same UTF-8 length, in the middle.
    expect(await holdsText(new Blob([`${half}é${half}`]), `${half}ü${half}`)).toBe(false);
  });

  it('is false for a size that differs, and for bytes that are not UTF-8', async () => {
    expect(await holdsText(new Blob(['abc']), 'abcd')).toBe(false);
    expect(await holdsText(new Blob(['abcd']), 'abc')).toBe(false);
    // 0xC3 0x28 is not UTF-8; 'é' is 0xC3 0xA9.
    expect(await holdsText(new Blob([new Uint8Array([0xc3, 0x28])]), 'é')).toBe(false);
    expect(await holdsText(new Blob([new Uint8Array([0xff])]), '\uFFFD')).toBe(false);
  });

  it('takes a lone surrogate as the replacement character the file holds for it', async () => {
    // A text with a lone surrogate is written as U+FFFD (EF BF BD).
    expect(await holdsText(new Blob(['a\uD800b']), 'a\uD800b')).toBe(true);
    expect(await holdsText(new Blob(['a\uFFFDb']), 'a\uD800b')).toBe(true);
    expect(await holdsText(new Blob(['a\uFFFDc']), 'a\uD800b')).toBe(false);
  });

  it('does not read the file when its size cannot be the text’s', async () => {
    let reads = 0;
    const blob = new Blob(['abcdef']);
    const counted = {
      size: blob.size,
      arrayBuffer: async () => {
        reads += 1;
        const bytes = await blobToBytes(blob);
        return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
      },
    } as unknown as Blob;
    // 6 bytes: not 7 characters, nor 1 (at most 3 bytes each).
    expect(await holdsText(counted, 'abcdefg')).toBe(false);
    expect(await holdsText(counted, 'a')).toBe(false);
    expect(reads).toBe(0);
    expect(await holdsText(counted, 'abcdef')).toBe(true);
    expect(reads).toBe(1);
  });

  // The sixth review's probes (h8.test.ts), the ones not covered above.
  it('rejects bytes that only look like the text in another encoding: overlong, CESU-8 surrogates, Latin-1', async () => {
    const bytes = (...values: number[]) => new Blob([new Uint8Array(values)]);
    // An overlong '/' (C0 AF).
    expect(await holdsText(bytes(0xc0, 0xaf), '/')).toBe(false);
    // A surrogate encoded on its own, as CESU-8 does (ED A0 80).
    expect(await holdsText(bytes(0xed, 0xa0, 0x80), '\uD800')).toBe(false);
    // Latin-1 'é' (E9).
    expect(await holdsText(bytes(0xe9), 'é')).toBe(false);
  });

  it('is exact at the edges: empty, NUL, the 3-byte maximum and astral characters', async () => {
    expect(await holdsText(new Blob([]), '')).toBe(true);
    expect(await holdsText(new Blob([]), 'a')).toBe(false);
    expect(await holdsText(new Blob([new Uint8Array([0])]), '\0')).toBe(true);
    expect(await holdsText(new Blob(['\uFFFF'.repeat(3)]), '\uFFFF'.repeat(3))).toBe(true);
    expect(await holdsText(new Blob(['😀']), '😀')).toBe(true);
    expect(await holdsText(new Blob(['😁']), '😀')).toBe(false);
  });
});
