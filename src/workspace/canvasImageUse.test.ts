import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../files/types';
import { canvasesUsing, filesLinking, movableCanvas, REFERENCES_SHOWN, referencesTo } from './canvasImageUse';
import type { IndexedDoc, IndexedLink, ProjectIndex } from './projectIndex';

// What the delete dialog lists under “Referenced by”, from a stub index: the files outside what's
// deleted that link to, embed or (a canvas) use something at or under it.

const file = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' });
const dir = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'dir' });

type Written = { from: string; to: string; embed?: boolean };

/** An index where each `from` links to `to`, and each path's kind is as named. */
function indexOf(links: Written[], canvases: string[] = []): ProjectIndex {
  const docs = new Map<string, IndexedDoc>();
  for (const { from } of links) {
    docs.set(from, { path: from, kind: canvases.includes(from) ? 'canvas' : 'note', text: '', headings: [], tags: [], links: [] });
  }
  return {
    ready: true,
    docs,
    backlinks: (path) =>
      links
        .filter((link) => link.to === path)
        .map((link): IndexedLink => ({ from: link.from, target: link.to, resolved: link.to, embed: link.embed ?? false, context: '' }))
        .sort((a, b) => (a.from < b.from ? -1 : 1)),
    tags: () => new Map(),
    search: () => [],
  };
}

const FILES = [file('Notes/Orion.md'), file('Photos/Sky.png'), dir('Photos'), file('Notes/Moon.md'), file('Sketches/Map.excalidraw.md')];
const paths = (found: { path: string }[]) => found.map((reference) => reference.path);

describe('referencesTo', () => {
  it('lists nothing when nothing refers to the file', () => {
    expect(referencesTo(indexOf([]), 'Notes/Orion.md', FILES)).toEqual({ shown: [], more: 0 });
  });

  it('lists the notes and canvases that refer to it, sorted by path, a canvas marked', () => {
    const index = indexOf(
      [
        { from: 'Sketches/Map.excalidraw.md', to: 'Photos/Sky.png', embed: true },
        { from: 'Notes/Orion.md', to: 'Photos/Sky.png', embed: true },
        { from: 'Notes/Moon.md', to: 'Photos/Sky.png' },
      ],
      ['Sketches/Map.excalidraw.md'],
    );
    expect(referencesTo(index, 'Photos/Sky.png', FILES)).toEqual({
      shown: [
        { path: 'Notes/Moon.md', canvas: false },
        { path: 'Notes/Orion.md', canvas: false },
        { path: 'Sketches/Map.excalidraw.md', canvas: true },
      ],
      more: 0,
    });
  });

  it('lists a file once however many links it has to it', () => {
    const index = indexOf([
      { from: 'Notes/Moon.md', to: 'Notes/Orion.md' },
      { from: 'Notes/Moon.md', to: 'Notes/Orion.md', embed: true },
    ]);
    expect(paths(referencesTo(index, 'Notes/Orion.md', FILES).shown)).toEqual(['Notes/Moon.md']);
  });

  const many = (count: number) => Array.from({ length: count }, (_, at) => file(`Refs/Note ${String(at + 1).padStart(2, '0')}.md`));
  const linking = (count: number): { index: ProjectIndex; files: FileEntry[] } => {
    const refs = many(count);
    return { index: indexOf(refs.map((ref) => ({ from: ref.path, to: 'Notes/Orion.md' }))), files: [...FILES, ...refs] };
  };

  it('shows all six when six refer to it', () => {
    const { index, files } = linking(REFERENCES_SHOWN);
    const found = referencesTo(index, 'Notes/Orion.md', files);
    expect(found.shown).toHaveLength(6);
    expect(found.more).toBe(0);
  });

  it('shows the first five and counts the rest when seven refer to it, so the list never grows', () => {
    const { index, files } = linking(7);
    const found = referencesTo(index, 'Notes/Orion.md', files);
    expect(paths(found.shown)).toEqual(['Note 01', 'Note 02', 'Note 03', 'Note 04', 'Note 05'].map((name) => `Refs/${name}.md`));
    expect(found.more).toBe(2);
    expect(found.shown.length + found.more).toBe(7);
    const hundred = linking(100);
    const big = referencesTo(hundred.index, 'Notes/Orion.md', hundred.files);
    expect(big.shown).toHaveLength(5);
    expect(big.more).toBe(95);
  });

  it('counts links to anything in a folder when the folder is deleted', () => {
    const index = indexOf([
      { from: 'Notes/Orion.md', to: 'Photos/Sky.png', embed: true },
      { from: 'Notes/Moon.md', to: 'Photos/Sky.png' },
    ]);
    expect(paths(referencesTo(index, 'Photos', FILES).shown)).toEqual(['Notes/Moon.md', 'Notes/Orion.md']);
  });

  it('does not count a link from inside the folder being deleted', () => {
    const inside = [...FILES, file('Photos/About.md'), file('Photos/Sub/Deeper.md'), file('Photos/Sub/Pic.png')];
    const index = indexOf(
      [
        { from: 'Photos/About.md', to: 'Photos/Sky.png' },
        { from: 'Photos/Sub/Deeper.md', to: 'Photos/Sub/Pic.png', embed: true },
        { from: 'Photos/Sub/Deeper.md', to: 'Photos/Sky.png' },
        { from: 'Notes/Moon.md', to: 'Photos/Sub/Pic.png' },
      ],
    );
    // Control: a note outside does count.
    expect(paths(referencesTo(index, 'Photos', inside).shown)).toEqual(['Notes/Moon.md']);
  });

  it('does not count a file’s link to itself', () => {
    const index = indexOf([{ from: 'Notes/Orion.md', to: 'Notes/Orion.md' }]);
    expect(referencesTo(index, 'Notes/Orion.md', FILES).shown).toEqual([]);
  });
});

describe('a folder with canvases', () => {
  const FOLDER = [file('Photos/Sky.png'), file('Photos/Inner.excalidraw.md'), file('Sketches/Map.excalidraw.md')];

  it('names a canvas outside that uses an image in the folder, and not a canvas inside the folder', () => {
    const index = indexOf(
      [
        { from: 'Sketches/Map.excalidraw.md', to: 'Photos/Sky.png', embed: true },
        { from: 'Photos/Inner.excalidraw.md', to: 'Photos/Sky.png', embed: true },
      ],
      ['Sketches/Map.excalidraw.md', 'Photos/Inner.excalidraw.md'],
    );
    expect(referencesTo(index, 'Photos', FOLDER)).toEqual({ shown: [{ path: 'Sketches/Map.excalidraw.md', canvas: true }], more: 0 });
    // Deleting the one image names both canvases that use it.
    expect(paths(referencesTo(index, 'Photos/Sky.png', FOLDER).shown)).toEqual(['Photos/Inner.excalidraw.md', 'Sketches/Map.excalidraw.md']);
  });
});

describe('canvasesUsing and filesLinking', () => {
  it('names a canvas that embeds the image, not a note that embeds it, nor a canvas that only links', () => {
    const index = indexOf(
      [
        { from: 'Sketches/Map.excalidraw.md', to: 'Photos/Sky.png', embed: true },
        { from: 'Notes/Orion.md', to: 'Photos/Sky.png', embed: true },
        { from: 'Sketches/Other.excalidraw.md', to: 'Photos/Sky.png', embed: false },
      ],
      ['Sketches/Map.excalidraw.md', 'Sketches/Other.excalidraw.md'],
    );
    const files = [...FILES, file('Sketches/Other.excalidraw.md')];
    expect(canvasesUsing(index, 'Photos/Sky.png', files)).toEqual(['Sketches/Map.excalidraw.md']);
    // The other writers are listed apart, and the canvas already named isn't again.
    expect(filesLinking(index, 'Photos/Sky.png', files, ['Sketches/Map.excalidraw.md'])).toEqual(['Notes/Orion.md', 'Sketches/Other.excalidraw.md']);
  });
});

describe('movableCanvas', () => {
  it('is true for a markdown drawing and false for Excalidraw’s own JSON', () => {
    expect(movableCanvas('Sketches/Map.excalidraw.md')).toBe(true);
    expect(movableCanvas('Edraw - Plan.md')).toBe(true);
    expect(movableCanvas('Sketches/Old.excalidraw')).toBe(false);
  });
});
