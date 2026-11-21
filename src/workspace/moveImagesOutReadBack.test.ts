import { describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import { blobBytes } from './attachments';
import { moveImagesOut } from './moveImagesOut';
import { canvasHolding } from './views/testing/canvasFixtures';

// Move images to files reads the text it is about to write back before it writes it. A writer that
// loses something must leave the canvas as it was. The real writer never does, so this one is made to.

const broken = vi.hoisted(() => ({ on: false }));

vi.mock('../nebula/excalidraw/obsidianMarkdown', async (importOriginal) => {
  const real = await importOriginal<typeof import('../nebula/excalidraw/obsidianMarkdown')>();
  return {
    ...real,
    // The faulty writer drops the first element, as a bug in the drawing's writer might.
    updateObsidianExcalidrawMarkdown: (...[original, scene, options]: Parameters<typeof real.updateObsidianExcalidrawMarkdown>) =>
      real.updateObsidianExcalidrawMarkdown(original, broken.on ? { ...scene, elements: scene.elements.slice(1) } : scene, options),
  };
});

describe('the read-back before a canvas is rewritten', () => {
  const holding = () => canvasHolding([{ id: 'a', bytes: [1, 2, 3], created: 1_800_000_000_000 }]);

  it('moves the canvas when the text reads back as the same drawing (control)', async () => {
    broken.on = false;
    const store = createMemoryFileStore({ 'Map.excalidraw.md': holding() });
    expect(await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: () => false })).toMatchObject({ images: 1, canvases: 1, skipped: [] });
  });

  it('leaves the canvas as it was when the new text lost an element, and keeps the image it copied', async () => {
    broken.on = true;
    try {
      const text = holding();
      const store = createMemoryFileStore({ 'Map.excalidraw.md': text });
      const run = await moveImagesOut(store, ['Map.excalidraw.md'], { unsaved: () => false });
      expect(run).toMatchObject({ images: 0, canvases: 0, written: 1, skipped: [{ path: 'Map.excalidraw.md', why: 'failed' }] });
      expect(store.peek('Map.excalidraw.md')).toBe(text);
      const files = (await store.list()).filter((entry) => entry.path.startsWith('Attachments/') && entry.type === 'file');
      expect(files).toHaveLength(1);
      expect(Array.from(await blobBytes(await store.readBlob(files[0].path)))).toEqual([1, 2, 3]);
    } finally {
      broken.on = false;
    }
  });
});
