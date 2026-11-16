import { describe, expect, it } from 'vitest';
import { drawableScene } from './canvasScene';

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
