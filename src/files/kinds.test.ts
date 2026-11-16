import { describe, expect, it } from 'vitest';
import { isObsidianExcalidrawFile, isObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { kindFromContent, kindFromName, kindOf } from './kinds';
import { MemoryFileStore } from './memoryStore';
import sampleCanvas from './sample/Winter hexagon.excalidraw.md?raw';
import gardenPlan from './fixtures/obsidian/Edraw - Garden plan.md?raw';
import recipeCards from './fixtures/obsidian/Edraw - Recipe cards.md?raw';
import busTimetable from './fixtures/obsidian/Edraw - Bus timetable.md?raw';
import type { FileStore } from './types';

describe('kindFromName', () => {
  it('opens Excalidraw files as canvases, Obsidian-style names included', () => {
    expect(kindFromName('Winter hexagon.excalidraw.md')).toBe('canvas');
    expect(kindFromName('Telescope setup.excalidraw')).toBe('canvas');
  });

  it('opens other markdown as notes', () => {
    expect(kindFromName('Observing plan.md')).toBe('note');
    expect(kindFromName('notes.markdown')).toBe('note');
  });

  it('ignores the case of the extension', () => {
    expect(kindFromName('PLEIADES.PNG')).toBe('image');
    expect(kindFromName('Sketch.Excalidraw.MD')).toBe('canvas');
  });

  it('recognises images, PDFs, audio and video', () => {
    for (const name of ['a.png', 'a.jpg', 'a.jpeg', 'a.gif', 'a.webp', 'a.avif', 'a.svg']) expect(kindFromName(name)).toBe('image');
    expect(kindFromName('Star chart.pdf')).toBe('pdf');
    for (const name of ['a.mp3', 'a.m4a', 'a.wav', 'a.ogg', 'a.flac', 'a.opus']) expect(kindFromName(name)).toBe('audio');
    for (const name of ['a.mp4', 'a.webm', 'a.mov', 'a.m4v']) expect(kindFromName(name)).toBe('video');
  });

  it('opens code, data and well-known extensionless files as text', () => {
    for (const name of ['a.txt', 'a.json', 'a.yaml', 'a.yml', 'a.toml', 'a.csv', 'a.ts', 'a.tsx', 'a.js', 'a.py', 'a.css', 'a.html', 'a.canvas']) {
      expect(kindFromName(name)).toBe('text');
    }
    for (const name of ['README', 'LICENSE', 'Makefile', 'Dockerfile', '.gitignore']) expect(kindFromName(name)).toBe('text');
  });

  it('falls back to other for anything it does not know', () => {
    expect(kindFromName('archive.zip')).toBe('other');
    expect(kindFromName('model.blend')).toBe('other');
    expect(kindFromName('noextension')).toBe('other');
  });

  it('reads only the last path segment', () => {
    expect(kindFromName('Guides.md/inside.png')).toBe('image');
  });
});

describe('the content check for markdown', () => {
  const drawing = toObsidianExcalidrawMarkdown({ elements: [{ id: 'a', type: 'rectangle', x: 0, y: 0, width: 1, height: 1 }] });
  const uncompressed = toObsidianExcalidrawMarkdown({ elements: [] }, { compressed: false });
  // Notes that talk about drawings, or quote one: still notes.
  const notes = [
    '# Observing plan\n\nSaturday, after moonset.',
    '# Excalidraw Data\n\n## Drawing\n```json\n{"elements":[]}\n```',
    'Some prose about the excalidraw plugin.',
    'To make a drawing, add `excalidraw-plugin: parsed` to the frontmatter.',
    'excalidraw-plugin: parsed\n\nnot in a frontmatter block',
    '```compressed-json\nabc\n```',
    '---\ntitle: Notes\n---\n\nexcalidraw-plugin: parsed',
    '\n---\nexcalidraw-plugin: parsed\n---\n',
    '---\nexcalidraw-plugin:\n---\n',
    '---\nexcalidraw-plugin: false\n---\n',
    '---\nexcalidraw-plugin: parsed\n',
    '',
  ];
  const drawings = [
    drawing,
    uncompressed,
    sampleCanvas,
    gardenPlan,
    recipeCards,
    busTimetable,
    '---\nexcalidraw-plugin: raw\n---\n',
    '---\r\n\r\nexcalidraw-plugin: parsed\r\ntags: [excalidraw]\r\n\r\n---\r\n# Back of the card',
    '\uFEFF---\naliases: [Plan]\nexcalidraw-plugin: "parsed"\n---\n',
  ];

  it('opens a plain .md as a canvas only when its leading frontmatter has the excalidraw-plugin key', () => {
    for (const text of drawings) expect(kindFromContent('Edraw - Plan.md', text), JSON.stringify(text.slice(0, 60))).toBe('canvas');
    for (const text of notes) expect(kindFromContent('Plan.md', text), JSON.stringify(text.slice(0, 60))).toBe('note');
  });

  it('opens real Obsidian Excalidraw files from a vault as canvases', () => {
    expect(kindFromContent('Edraw - Garden plan.md', gardenPlan)).toBe('canvas');
    expect(kindFromContent('Edraw - Recipe cards.md', recipeCards)).toBe('canvas');
    expect(kindFromContent('Edraw - Bus timetable.md', busTimetable)).toBe('canvas');
  });

  it('agrees with isObsidianExcalidrawFile, the strict check that saves and loads canvases', () => {
    for (const text of [...drawings, ...notes]) {
      expect(kindFromContent('x.md', text) === 'canvas', JSON.stringify(text.slice(0, 40))).toBe(isObsidianExcalidrawFile(text));
    }
  });

  it('leaves the lenient check for the explicit Import, which takes what the user picked', () => {
    expect(isObsidianExcalidrawMarkdown('# Excalidraw Data\n\n## Drawing\n```json\n{"elements":[]}\n```')).toBe(true);
    expect(isObsidianExcalidrawFile('# Excalidraw Data\n\n## Drawing\n```json\n{"elements":[]}\n```')).toBe(false);
  });

  it('leaves every other kind to the name', () => {
    expect(kindFromContent('Sketch.excalidraw.md', '# not a drawing')).toBe('canvas');
    expect(kindFromContent('a.txt', drawing)).toBe('text');
    expect(kindFromContent('photo.png', '')).toBe('image');
  });

  it('reads a .md from the store to decide, and nothing else', async () => {
    const store = new MemoryFileStore();
    await store.write('Edraw - Plan.md', drawing);
    await store.write('Notes/Plan.md', '# Plan');
    await store.write('photo.png', new Blob([new Uint8Array([1])]));
    let reads = 0;
    const counting = { ...store, list: () => store.list(), stat: (path: string) => store.stat(path), readText: (path: string) => { reads += 1; return store.readText(path); } } as unknown as FileStore;

    expect(await kindOf(counting, 'Edraw - Plan.md')).toBe('canvas');
    expect(await kindOf(counting, 'Notes/Plan.md')).toBe('note');
    expect(await kindOf(counting, 'photo.png')).toBe('image');
    expect(reads).toBe(2);
  });
});
