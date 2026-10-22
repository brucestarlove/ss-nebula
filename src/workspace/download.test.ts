import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import { downloadFile } from './download';

describe('Download from the file menu', () => {
  const created: Blob[] = [];
  const revoked: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
    created.length = 0;
    revoked.length = 0;
    URL.createObjectURL = (blob: Blob) => {
      created.push(blob);
      return `blob:nebula/${created.length}`;
    };
    URL.revokeObjectURL = (url: string) => {
      revoked.push(url);
    };
    HTMLAnchorElement.prototype.click = () => {};
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('hands out opaque bytes, so a page or an SVG can’t open as a page of this origin', async () => {
    const store = createMemoryFileStore({
      'page.html': new Blob(['<script>alert(1)</script>'], { type: 'text/html' }),
      'pic.svg': new Blob(['<svg xmlns="http://www.w3.org/2000/svg"/>'], { type: 'image/svg+xml' }),
    });
    await downloadFile(store, { path: 'page.html', name: 'page.html' });
    await downloadFile(store, { path: 'pic.svg', name: 'pic.svg' });
    expect(created.map((blob) => blob.type)).toEqual(['application/octet-stream', 'application/octet-stream']);
  });

  it('keeps the link alive for a minute, long enough for a big file to start', async () => {
    const store = createMemoryFileStore({ 'big.mov': new Blob(['x']) });
    await downloadFile(store, { path: 'big.mov', name: 'big.mov' });
    await vi.advanceTimersByTimeAsync(59_000);
    expect(revoked).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(revoked).toEqual(['blob:nebula/1']);
  });
});
