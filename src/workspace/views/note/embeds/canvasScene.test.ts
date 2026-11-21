import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../../../../e2e/harness/views-store';
import { canvasHolding, dataURLOf, sceneWith } from '../../testing/canvasFixtures';
import { toObsidianExcalidrawMarkdown } from '../../../../nebula/excalidraw/obsidianMarkdown';
import { drawableScene, drawableSceneWithImages } from './canvasScene';

const rectangle = { id: 'r1', type: 'rectangle', x: 0, y: 0, width: 120, height: 60, isDeleted: false };
const json = (elements: unknown[], files: unknown = {}) => JSON.stringify({ type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files });

describe('drawableScene', () => {
  it('reads a .excalidraw file, without its deleted elements', () => {
    const drawing = drawableScene(json([rectangle, { ...rectangle, id: 'r2', isDeleted: true }]), 'Sketch.excalidraw');
    expect(drawing?.elements.map((element) => element.id)).toEqual(['r1']);
  });

  it('reads a canvas kept as Obsidian markdown', () => {
    const text = ['---', 'excalidraw-plugin: parsed', '---', '# Excalidraw Data', '', '## Text Elements', '', '%%', '## Drawing', '```json', json([rectangle]), '```', '%%'].join('\n');
    expect(drawableScene(text, 'Sketch.excalidraw.md')?.elements).toHaveLength(1);
  });

  it('leaves out an image whose data is not in the file, and keeps one that is', () => {
    const files = {
      local: { id: 'local', mimeType: 'image/png', dataURL: 'data:image/png;base64,iVBORw0KGgo=', created: 1 },
      remote: { id: 'remote', mimeType: 'image/png', dataURL: 'https://tracker.example/p.png', created: 1 },
    };
    const drawing = drawableScene(json([rectangle], files), 'Pics.excalidraw');
    expect(Object.keys(drawing!.files)).toEqual(['local']);
  });

  it('is null for a drawing with nothing on it, or an empty file', () => {
    expect(drawableScene(json([{ ...rectangle, isDeleted: true }]), 'Empty.excalidraw')).toBeNull();
    expect(drawableScene('', 'Blank.excalidraw')).toBeNull();
    expect(drawableScene('  \n', 'Blank.excalidraw.md')).toBeNull();
  });

  it('fails for a file that is not a drawing, so the note shows the name instead', () => {
    expect(() => drawableScene('{"hello": 1}', 'Bad.excalidraw')).toThrow('not an Excalidraw drawing');
    expect(() => drawableScene('not json', 'Bad.excalidraw')).toThrow();
  });
});

describe('drawableSceneWithImages: the images a canvas keeps as files', () => {
  const SKY = [1, 2, 3, 4];
  const referencing = (id: string, link: string) => toObsidianExcalidrawMarkdown({ ...sceneWith([{ id, bytes: [0] }]), files: {} }, { embedded: { add: [[id, link]] } });

  it('draws an image read from its file, as the canvas does', async () => {
    const store = createMemoryFileStore({ 'Attachments/Sky.png': new Blob([new Uint8Array(SKY)]) });
    const drawing = await drawableSceneWithImages(store, referencing('s', 'Sky.png'), 'Sketches/Map.excalidraw.md');
    expect(drawing?.elements.map((element) => element.id)).toEqual(['rect', 'el-s']);
    expect(drawing?.files.s).toMatchObject({ id: 's', mimeType: 'image/png', dataURL: dataURLOf(SKY) });
  });

  it('draws a missing image as missing: the drawing, with no file for it', async () => {
    const store = createMemoryFileStore({});
    const drawing = await drawableSceneWithImages(store, referencing('s', 'Gone.png'), 'Map.excalidraw.md');
    expect(drawing?.elements).toHaveLength(2);
    expect(drawing?.files).toEqual({});
  });

  it('keeps an image the drawing holds inside, whatever its line says', async () => {
    const store = createMemoryFileStore({ 'Attachments/Sky.png': new Blob([new Uint8Array(SKY)]) });
    const inside = canvasHolding([{ id: 's', bytes: [9, 9] }]).replace('%%\n## Drawing', '## Embedded Files\ns: [[Sky.png]]\n\n%%\n## Drawing');
    const drawing = await drawableSceneWithImages(store, inside, 'Map.excalidraw.md');
    expect(drawing?.files.s).toMatchObject({ dataURL: dataURLOf([9, 9]) });
  });

  it('reads nothing for a plain .excalidraw, which holds its images itself', async () => {
    const text = json([rectangle], { a: { id: 'a', mimeType: 'image/png', dataURL: 'data:image/png;base64,AA==', created: 1 } });
    const store = createMemoryFileStore({});
    const reads: string[] = [];
    store.readBlob = async (path) => (reads.push(path), new Blob([]));
    const drawing = await drawableSceneWithImages(store, text, 'Old.excalidraw');
    expect(Object.keys(drawing?.files ?? {})).toEqual(['a']);
    expect(reads).toEqual([]);
  });
});
