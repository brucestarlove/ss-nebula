import { describe, expect, it } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../e2e/harness/views-store';
import { embeddedFiles } from '../nebula/excalidraw/embeddedFiles';
import { toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { linkRunMessage, MAX_LINK_NOTE_CHARS, updateLinksAfterMove, updateLinksAfterMoves, type LinkRun } from './updateLinksRun';

// What happens to the project's notes after a rename or a move, against a store:
// which are written, which are left, and what is said about it.

const PLAN = 'Guides/Observing plan.md';
const sample = (): Record<string, string | Blob> => ({
  'README.md': 'Start with the [[Observing plan]] and [[Orion]].',
  [PLAN]: ['---', 'tags: [a]', '---', 'Notes in [[Orion]] and [[Orion#Stars|the stars]].', '', '![[Winter hexagon.excalidraw]]', '', '`[[Orion]]` stays.'].join('\n'),
  'Guides/Orion.md': 'Back to the [[Observing plan]]. I am [[Orion]].',
  'Guides/Moon phases.md': 'Nothing about the hunter. [[Observing plan]]',
  'Sketches/Winter hexagon.excalidraw.md': '---\nexcalidraw-plugin: parsed\n---\n[[Orion]] is a text element here, not a link.',
  'Sketches/Plain drawing.md': '---\nexcalidraw-plugin: parsed\n---\n# Excalidraw Data\n\n[[Orion]]',
  'Sketches/Old.excalidraw': '{"type":"excalidraw","elements":[],"note":"[[Orion]]"}',
  'Photos/Winter hexagon.png': new Blob([new Uint8Array([1, 2, 3])]),
});

const NONE: LinkRun = { links: 0, notes: 0, unsaved: 0, changed: 0, long: 0, failed: 0 };

async function renamed(store: MemoryFileStore, from: string, to: string, unsaved: (path: string) => boolean = () => false) {
  await store.rename(from, to);
  store.writes.length = 0;
  return updateLinksAfterMove(store, { from, to, unsaved });
}

describe('updateLinksAfterMove', () => {
  it('rewrites the links to a renamed note in every note that has them, and says how many', async () => {
    const store = createMemoryFileStore(sample());
    const run = await renamed(store, 'Guides/Orion.md', 'Guides/Orion, the hunter.md');
    expect(run).toEqual({ ...NONE, links: 4, notes: 3 });
    expect(store.peek('README.md')).toBe('Start with the [[Observing plan]] and [[Orion, the hunter]].');
    expect(store.peek(PLAN)).toBe(['---', 'tags: [a]', '---', 'Notes in [[Orion, the hunter]] and [[Orion, the hunter#Stars|the stars]].', '', '![[Winter hexagon.excalidraw]]', '', '`[[Orion]]` stays.'].join('\n'));
    expect(store.peek('Guides/Orion, the hunter.md')).toBe('Back to the [[Observing plan]]. I am [[Orion, the hunter]].');
    expect(linkRunMessage(run)).toBe('Updated 4 links in 3 notes.');
    // Only those three were written: not the note without a link to it, not a drawing, not a picture.
    expect(store.writes.map((write) => write.path).sort()).toEqual(['Guides/Observing plan.md', 'Guides/Orion, the hunter.md', 'README.md']);
  });

  it('never touches a canvas: not an .excalidraw.md, not a plain .md that is a drawing, not an .excalidraw', async () => {
    const store = createMemoryFileStore(sample());
    await renamed(store, 'Guides/Orion.md', 'Guides/Hunter.md');
    expect(store.peek('Sketches/Winter hexagon.excalidraw.md')).toBe(sample()['Sketches/Winter hexagon.excalidraw.md']);
    expect(store.peek('Sketches/Plain drawing.md')).toBe(sample()['Sketches/Plain drawing.md']);
    expect(store.peek('Sketches/Old.excalidraw')).toBe(sample()['Sketches/Old.excalidraw']);
  });

  it('follows a renamed canvas and a renamed folder', async () => {
    const store = createMemoryFileStore(sample());
    let run = await renamed(store, 'Sketches/Winter hexagon.excalidraw.md', 'Sketches/Hexagon.excalidraw.md');
    expect(run).toEqual({ ...NONE, links: 1, notes: 1 });
    expect(store.peek(PLAN)).toContain('![[Hexagon.excalidraw]]');
    store.writes.length = 0;
    await store.write('README.md', 'See [[Guides/Orion]] and [[Orion]].');
    run = await renamed(store, 'Guides', 'Notes');
    expect(store.peek('README.md')).toBe('See [[Notes/Orion]] and [[Orion]].');
    expect(run.notes).toBe(1);
  });

  it('writes nothing when a move changes what no link says', async () => {
    const store = createMemoryFileStore(sample());
    const run = await renamed(store, 'Photos/Winter hexagon.png', 'Gallery/Winter hexagon.png');
    expect(run).toEqual(NONE);
    expect(store.writes).toEqual([]);
    expect(linkRunMessage(run)).toBeNull();
  });

  it('leaves a note with unsaved changes open in a tab, and counts it', async () => {
    const store = createMemoryFileStore(sample());
    const run = await renamed(store, 'Guides/Orion.md', 'Guides/Hunter.md', (path) => path === 'README.md');
    expect(run).toEqual({ ...NONE, links: 3, notes: 2, unsaved: 1 });
    expect(store.peek('README.md')).toBe(sample()['README.md']);
    expect(linkRunMessage(run)).toBe('Updated 3 links in 2 notes. Left 1 note as it was: it has unsaved changes.');
    expect(linkRunMessage({ ...NONE, unsaved: 2 })).toBe('Left 2 notes as they were: they have unsaved changes.');
  });

  it('never writes over a note that changed while it was being read', async () => {
    const store = createMemoryFileStore(sample());
    await store.rename('Guides/Orion.md', 'Guides/Hunter.md');
    store.writes.length = 0;
    const read = store.readText.bind(store);
    store.readText = async (path) => {
      const text = await read(path);
      // Another tab saves the README just after this read.
      if (path === 'README.md') await store.write('README.md', 'Rewritten elsewhere. [[Orion]]');
      return text;
    };
    const run = await updateLinksAfterMove(store, { from: 'Guides/Orion.md', to: 'Guides/Hunter.md', unsaved: () => false });
    expect(run).toMatchObject({ changed: 1, notes: 2 });
    expect(store.peek('README.md')).toBe('Rewritten elsewhere. [[Orion]]');
    expect(linkRunMessage(run)).toContain('Left 1 note as it was: it changed meanwhile.');
  });

  it('goes on past a note that can’t be read or written, and says so', async () => {
    const store = createMemoryFileStore(sample());
    await store.rename('Guides/Orion.md', 'Guides/Hunter.md');
    store.unreadable.add('README.md');
    const write = store.write.bind(store);
    store.write = async (path, data, options) => {
      if (path === PLAN) throw new Error('disk full');
      return write(path, data, options);
    };
    const run = await updateLinksAfterMove(store, { from: 'Guides/Orion.md', to: 'Guides/Hunter.md', unsaved: () => false });
    expect(run).toEqual({ ...NONE, links: 1, notes: 1, failed: 2 });
    expect(store.peek('Guides/Hunter.md')).toBe('Back to the [[Observing plan]]. I am [[Hunter]].');
    expect(linkRunMessage(run)).toBe('Updated 1 link in 1 note. Couldn’t update 2 notes.');
  });

  it('skips a note over 200,000 characters, and says so', async () => {
    const files = sample();
    files['Long log.md'] = `${'Seeing was steady. '.repeat(11_000)}See [[Orion]].`;
    expect((files['Long log.md'] as string).length).toBeGreaterThan(MAX_LINK_NOTE_CHARS);
    files['Long quiet.md'] = `${'No links to it. '.repeat(14_000)}See [[Elsewhere]].`;
    const store = createMemoryFileStore(files);
    const run = await renamed(store, 'Guides/Orion.md', 'Guides/Hunter.md');
    expect(run.long).toBe(1);
    expect(store.peek('Long log.md')).toBe(files['Long log.md']);
    expect(linkRunMessage(run)).toContain('Left 1 note as it was: it is over 200,000 characters.');
  });

  it('never rewrites a file that is not UTF-8 text', async () => {
    const files = sample();
    const bytes = new Uint8Array([...new TextEncoder().encode('[[Orion]] caf'), 0xe9]);
    files['Latin one.md'] = new Blob([bytes]);
    const store = createMemoryFileStore(files);
    await renamed(store, 'Guides/Orion.md', 'Guides/Hunter.md');
    expect(store.writes.map((write) => write.path)).not.toContain('Latin one.md');
  });

  it('keeps a moved note’s own relative links right, and the line ends of every note', async () => {
    const files = { 'Guides/Plan.md': 'See ![](../Photos/x.png)\r\nand [[Plan]].\r\n', 'Photos/x.png': new Blob([new Uint8Array([1])]) };
    const store = createMemoryFileStore(files);
    const run = await renamed(store, 'Guides/Plan.md', 'Plan.md');
    expect(store.peek('Plan.md')).toBe('See ![](Photos/x.png)\r\nand [[Plan]].\r\n');
    expect(run).toMatchObject({ links: 1, notes: 1 });
  });

  it('only reaches for a project it can list', async () => {
    const store = createMemoryFileStore(sample());
    store.list = async () => {
      throw new Error('The folder isn’t open');
    };
    await expect(updateLinksAfterMove(store, { from: 'a.md', to: 'b.md', unsaved: () => false })).rejects.toThrow('The folder isn’t open');
  });
});

describe('linkRunMessage', () => {
  it('says each thing once, in plain words', () => {
    expect(linkRunMessage({ links: 1, notes: 1, unsaved: 0, changed: 0, long: 0, failed: 0 })).toBe('Updated 1 link in 1 note.');
    expect(linkRunMessage({ links: 5, notes: 2, unsaved: 1, changed: 2, long: 1, failed: 1 })).toBe(
      'Updated 5 links in 2 notes. Left 1 note as it was: it has unsaved changes. Left 2 notes as they were: they changed meanwhile. Left 1 note as it was: it is over 200,000 characters. Couldn’t update 1 note.',
    );
  });
});

describe('the images a canvas names (2.0.4)', () => {
  const SKY = new Blob([new Uint8Array([1, 2, 3])]);
  /** An Obsidian drawing with these Embedded Files lines, and a text element that says [[Sky]] (the drawing's own). */
  const canvasText = (...lines: string[]) =>
    toObsidianExcalidrawMarkdown(
      { type: 'excalidraw', version: 2, source: 't', elements: [{ id: 'abcd1234', type: 'text', x: 0, y: 0, width: 5, height: 5, text: 'Sky', originalText: 'Sky', link: '[[Sky.png]]' }], appState: {}, files: {} },
      { embedded: { add: lines.map((line, at) => [`id${at + 1}`, line] as const) } },
    );
  const world = (): Record<string, string | Blob> => ({
    'Photos/Sky.png': SKY,
    'Sketches/Map.excalidraw.md': canvasText('Sky.png|100%'),
    'Sketches/Other.excalidraw.md': canvasText('Sky.png'),
    'Notes/Plan.md': 'The sky: ![[Sky.png]]',
  });
  const linesOf = (text: string | undefined) => embeddedFiles(text ?? '').map((line) => line.link);

  it('rewrites the lines of every canvas that names a renamed image, and counts them apart from the notes', async () => {
    const store = createMemoryFileStore(world());
    const run = await renamed(store, 'Photos/Sky.png', 'Photos/Clouds.png');
    expect(run).toEqual({ ...NONE, links: 3, notes: 1, canvases: 2 });
    expect(linesOf(store.peek('Sketches/Map.excalidraw.md'))).toEqual(['Clouds.png|100%']);
    expect(linesOf(store.peek('Sketches/Other.excalidraw.md'))).toEqual(['Clouds.png']);
    expect(store.peek('Notes/Plan.md')).toBe('The sky: ![[Clouds.png]]');
  });

  it('writes each canvas only over the text it read, and writes nothing for a canvas it has nothing to change in', async () => {
    const memory = createMemoryFileStore(world());
    await memory.rename('Photos/Sky.png', 'Photos/Clouds.png');
    memory.writes.length = 0;
    const seen: Array<[string, unknown]> = [];
    const store = { ...memory, write: (path: string, data: string | Blob, options?: Parameters<typeof memory.write>[2]) => (seen.push([path, options]), memory.write(path, data, options)) };
    await updateLinksAfterMove(store, { from: 'Photos/Sky.png', to: 'Photos/Clouds.png', unsaved: () => false });
    const canvasWrite = seen.find(([path]) => path === 'Sketches/Map.excalidraw.md')!;
    expect(canvasWrite[1]).toEqual({ ifUnchanged: { text: canvasText('Sky.png|100%') } });
    // An image that moves without changing what its name reaches costs no write.
    const quiet = createMemoryFileStore(world());
    expect(await renamed(quiet, 'Photos/Sky.png', 'Gallery/Sky.png')).toEqual(NONE);
    expect(quiet.writes).toEqual([]);
  });

  it('has no `canvases` and no `canvasesLeft` in a run that touched none', async () => {
    const run = await renamed(createMemoryFileStore(sample()), 'Guides/Orion.md', 'Guides/Hunter.md');
    expect(run).not.toHaveProperty('canvases');
    expect(run).not.toHaveProperty('canvasesLeft');
  });

  it('leaves a canvas with unsaved changes as it was, and counts it as a canvas left', async () => {
    const store = createMemoryFileStore(world());
    const run = await renamed(store, 'Photos/Sky.png', 'Photos/Clouds.png', (path) => path === 'Sketches/Map.excalidraw.md');
    expect(run).toEqual({ ...NONE, links: 2, notes: 1, canvases: 1, unsaved: 1, canvasesLeft: 1 });
    expect(store.peek('Sketches/Map.excalidraw.md')).toBe(world()['Sketches/Map.excalidraw.md']);
    expect(linesOf(store.peek('Sketches/Other.excalidraw.md'))).toEqual(['Clouds.png']);
  });

  it('leaves a canvas that changed while it was being read, never writing over the change', async () => {
    const store = createMemoryFileStore(world());
    await store.rename('Photos/Sky.png', 'Photos/Clouds.png');
    store.writes.length = 0;
    const read = store.readText.bind(store);
    const elsewhere = `${canvasText('Sky.png|100%')}\n\nEdited in another tab.`;
    store.readText = async (path) => {
      const text = await read(path);
      if (path === 'Sketches/Map.excalidraw.md') await store.write(path, elsewhere);
      return text;
    };
    const run = await updateLinksAfterMove(store, { from: 'Photos/Sky.png', to: 'Photos/Clouds.png', unsaved: () => false });
    expect(run).toMatchObject({ changed: 1, canvasesLeft: 1, canvases: 1, notes: 1 });
    expect(store.peek('Sketches/Map.excalidraw.md')).toBe(elsewhere);
  });

  it('counts a note left apart from a canvas left', async () => {
    const store = createMemoryFileStore(world());
    const run = await renamed(store, 'Photos/Sky.png', 'Photos/Clouds.png', (path) => path === 'Notes/Plan.md' || path === 'Sketches/Map.excalidraw.md');
    expect(run).toMatchObject({ unsaved: 2, canvasesLeft: 1 });
  });

  it('updates a canvas of over 200,000 characters: its lines are a few, however big its drawing is', async () => {
    const big = canvasText('Sky.png').replace('%%\n## Drawing', `${'Back of the card. '.repeat(13_000)}\n%%\n## Drawing`);
    expect(big.length).toBeGreaterThan(MAX_LINK_NOTE_CHARS);
    const store = createMemoryFileStore({ ...world(), 'Sketches/Big.excalidraw.md': big });
    const run = await renamed(store, 'Photos/Sky.png', 'Photos/Clouds.png');
    expect(run.long).toBe(0);
    expect(linesOf(store.peek('Sketches/Big.excalidraw.md'))).toEqual(['Clouds.png']);
  });

  it('follows a batch of images replaced by others (Convert images) in the canvases that named them', async () => {
    const store = createMemoryFileStore({ ...world(), 'Photos/Clouds.webp': SKY });
    await store.remove('Photos/Sky.png');
    store.writes.length = 0;
    const run = await updateLinksAfterMoves(store, [{ from: 'Photos/Sky.png', to: 'Photos/Clouds.webp' }], { unsaved: () => false });
    expect(run).toMatchObject({ canvases: 2, notes: 1, links: 3 });
    expect(linesOf(store.peek('Sketches/Map.excalidraw.md'))).toEqual(['Clouds.webp|100%']);
  });
});
