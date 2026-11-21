import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../files/types';
import { toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { canvasRecord, LinkResolver, makeIndex, noteRecord, resolveRecord } from './indexBuild';
import { canvasWords } from './indexCanvas';
import { sceneWith } from './views/testing/canvasFixtures';

// The index counts each Embedded Files line as an embed link from the canvas, so “Linked from” on an
// image lists the canvases that use it, and deleting the image can say so.

const file = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' });

function canvasText(lines: Record<string, string>, { elements = true, compressed = true }: { elements?: boolean; compressed?: boolean } = {}): string {
  const scene = { ...sceneWith(Object.keys(lines).map((id) => ({ id, bytes: [0] }))), files: {} };
  if (!elements) scene.elements = [];
  return toObsidianExcalidrawMarkdown(scene, { compressed, embedded: { add: Object.entries(lines) } });
}

describe('canvasWords: an image a canvas holds as a file is an embed link from it', () => {
  it('counts a line as an embed, in the target as written', () => {
    const { links } = canvasWords(canvasText({ a: 'Sky.png', b: 'Photos/Moon.jpg|100%' }), 'Sketches/Map.excalidraw.md');
    expect(links.map((link) => [link.target, link.embed])).toEqual([['Sky.png', true], ['Photos/Moon.jpg', true]]);
  });

  it('counts it even when the drawing has nothing on it', () => {
    const { links, lines } = canvasWords(canvasText({ a: 'Sky.png' }, { elements: false }), 'Map.excalidraw.md');
    expect(lines).toEqual([]);
    expect(links.map((link) => link.target)).toEqual(['Sky.png']);
  });

  it('counts it even when the drawing does not decode, so deleting the image still warns', () => {
    const broken = canvasText({ a: 'Sky.png' }).replace(/```compressed-json\n[\s\S]*?\n```/, '```compressed-json\n!!!!\n```');
    const { links, lines } = canvasWords(broken, 'Map.excalidraw.md');
    expect(lines).toEqual([]);
    expect(links.map((link) => link.target)).toEqual(['Sky.png']);
  });

  it('counts none for a plain .excalidraw, which has no such section', () => {
    const text = JSON.stringify({ type: 'excalidraw', version: 2, elements: [{ id: 't', type: 'text', text: 'Embedded Files\na: [[Sky.png]]', originalText: 'Embedded Files', x: 0, y: 0, width: 1, height: 1 }], appState: {}, files: {} });
    expect(canvasWords(text, 'Old.excalidraw').links).toEqual([]);
  });

  it('puts the canvas in an image’s Linked from, beside the notes that embed it', () => {
    const files = [file('Photos/Sky.png'), file('Sketches/Map.excalidraw.md'), file('Notes/Plan.md')];
    const resolver = new LinkResolver(files);
    const canvas = canvasWords(canvasText({ a: 'Sky.png' }), 'Sketches/Map.excalidraw.md');
    const records = [
      resolveRecord(canvasRecord('Sketches/Map.excalidraw.md', canvas.lines, canvas.links), resolver, 1),
      resolveRecord(noteRecord('Notes/Plan.md', 'The sky: ![[Sky.png]]'), resolver, 1),
    ];
    const index = makeIndex(records, true);
    const from = index.backlinks('Photos/Sky.png');
    expect(from.map((link) => link.from)).toEqual(['Notes/Plan.md', 'Sketches/Map.excalidraw.md']);
    expect(from.every((link) => link.embed)).toBe(true);
    expect(index.docs.get('Sketches/Map.excalidraw.md')?.kind).toBe('canvas');
  });
});
