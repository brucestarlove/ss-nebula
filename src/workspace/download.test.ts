import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import { toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { downloadAsExcalidraw, downloadFile } from './download';
import { canvasHolding, dataURLOf, sceneWith } from './views/testing/canvasFixtures';

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

describe('Download as .excalidraw from a canvas that keeps its images as files', () => {
  const made: Array<{ blob: Blob; name: string }> = [];
  let names: string[] = [];
  const SKY = [1, 2, 3, 4];
  const MOON = [5, 6, 7];

  beforeEach(() => {
    made.length = 0;
    names = [];
    URL.createObjectURL = (blob: Blob) => {
      made.push({ blob, name: '' });
      return `blob:nebula/${made.length}`;
    };
    URL.revokeObjectURL = () => {};
    HTMLAnchorElement.prototype.click = function (this: HTMLAnchorElement) {
      names.push(this.download);
    };
  });

  const referencing = (lines: Record<string, string>) => toObsidianExcalidrawMarkdown({ ...sceneWith(Object.keys(lines).map((id) => ({ id, bytes: [0] }))), files: {} }, { embedded: { add: Object.entries(lines) } });
  const blobText = (blob: Blob) =>
    new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsText(blob);
    });
  const downloaded = async () => JSON.parse(await blobText(made.at(-1)!.blob)) as { type: string; elements: Array<{ id: string; fileId?: string }>; files: Record<string, { id: string; mimeType: string; dataURL: string; created: number }> };

  it('puts every referenced image back inside the JSON, keyed by the ids its elements name', async () => {
    const store = createMemoryFileStore({
      'Sketches/Map.excalidraw.md': referencing({ s: 'Sky.png', m: 'Moon.jpg' }),
      'Attachments/Sky.png': new Blob([new Uint8Array(SKY)]),
      'Attachments/Moon.jpg': new Blob([new Uint8Array(MOON)]),
    });
    await downloadAsExcalidraw(store, { path: 'Sketches/Map.excalidraw.md', name: 'Map.excalidraw.md' });
    const json = await downloaded();
    expect(json.type).toBe('excalidraw');
    expect(Object.keys(json.files).sort()).toEqual(['m', 's']);
    expect(json.files.s).toEqual({ id: 's', mimeType: 'image/png', dataURL: dataURLOf(SKY), created: expect.any(Number) });
    expect(json.files.m).toMatchObject({ mimeType: 'image/jpeg', dataURL: dataURLOf(MOON, 'image/jpeg') });
    expect(json.elements.filter((element) => element.fileId).map((element) => element.fileId).sort()).toEqual(['m', 's']);
    expect(names).toEqual(['Map.excalidraw']);
  });

  it('leaves a missing image missing, and an image already inside wins over a line for the same id', async () => {
    const inside = canvasHolding([{ id: 'own', bytes: [9, 9] }]).replace('%%\n## Drawing', '## Embedded Files\nown: [[Sky.png]]\n\ngone: [[Gone.png]]\n\n%%\n## Drawing');
    const store = createMemoryFileStore({ 'Map.excalidraw.md': inside, 'Attachments/Sky.png': new Blob([new Uint8Array(SKY)]) });
    await downloadAsExcalidraw(store, { path: 'Map.excalidraw.md', name: 'Map.excalidraw.md' });
    const json = await downloaded();
    expect(Object.keys(json.files)).toEqual(['own']);
    expect(json.files.own.dataURL).toBe(dataURLOf([9, 9]));
  });

  it('downloads a plain .excalidraw as it is', async () => {
    const text = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 'r', type: 'rectangle' }], appState: {}, files: { a: { id: 'a', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', created: 1 } } });
    const store = createMemoryFileStore({ 'Old.excalidraw': text });
    await downloadAsExcalidraw(store, { path: 'Old.excalidraw', name: 'Old.excalidraw' });
    expect(await downloaded()).toMatchObject(JSON.parse(text));
  });
});
