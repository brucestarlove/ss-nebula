import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../../../files/types';
import { linkHeading, makesNote, markdownPath, parseWikilink, planNewNote, resolveLink, resolveMarkdownPath, shortestTarget, wikilinkLabel } from './links';

const file = (path: string): FileEntry => ({ path, name: path.split('/').pop()!, type: 'file' });
const files = [
  'README.md',
  'Guides/Orion.md',
  'Guides/Observing plan.md',
  'Guides/Moon phases.md',
  'Sketches/Winter hexagon.excalidraw.md',
  'Photos/Winter hexagon.png',
  'Charts/Star chart — October.pdf',
  'Archive/Orion.md',
  'Archive/2025/Orion.md',
].map(file);

describe('parseWikilink', () => {
  it('reads a plain target', () => {
    expect(parseWikilink('Orion')).toMatchObject({ target: 'Orion', heading: null, block: null, alias: null, embed: false, size: null });
  });
  it('splits the heading, the block and the alias', () => {
    expect(parseWikilink('Orion#M42|the nebula')).toMatchObject({ target: 'Orion', heading: 'M42', alias: 'the nebula' });
    expect(parseWikilink('Orion#^abc123')).toMatchObject({ target: 'Orion', heading: null, block: 'abc123' });
    expect(parseWikilink('#Targets')).toMatchObject({ target: '', heading: 'Targets' });
  });
  it('takes a number after the bar on an embed as its width, or width x height', () => {
    expect(parseWikilink('Photos/Winter hexagon.png|300', true)).toMatchObject({ embed: true, alias: null, size: { width: 300 } });
    expect(parseWikilink('a.png|300x200', true)).toMatchObject({ size: { width: 300, height: 200 } });
    expect(parseWikilink('a.png|a caption', true)).toMatchObject({ alias: 'a caption', size: null });
  });
  it('trims, and keeps the raw text', () => {
    expect(parseWikilink('  Orion | Hunter ')).toMatchObject({ raw: '  Orion | Hunter ', target: 'Orion', alias: 'Hunter' });
  });
});

describe('wikilinkLabel', () => {
  it('shows the alias, else the target with its heading', () => {
    expect(wikilinkLabel(parseWikilink('Orion|Hunter'))).toBe('Hunter');
    expect(wikilinkLabel(parseWikilink('Orion#M42'))).toBe('Orion > M42');
    expect(wikilinkLabel(parseWikilink('#Targets'))).toBe('Targets');
    expect(wikilinkLabel(parseWikilink('Guides/Orion'))).toBe('Guides/Orion');
  });
});

describe('resolveLink', () => {
  it('finds a note by name, without its extension, in any case', () => {
    expect(resolveLink('moon phases', 'README.md', files)?.path).toBe('Guides/Moon phases.md');
  });
  it('finds a file by its full name with an extension', () => {
    expect(resolveLink('Winter hexagon.png', 'README.md', files)?.path).toBe('Photos/Winter hexagon.png');
    expect(resolveLink('Star chart — October.pdf', 'README.md', files)?.path).toBe('Charts/Star chart — October.pdf');
  });
  it('finds a canvas by name, since a canvas is `.excalidraw.md`', () => {
    expect(resolveLink('Winter hexagon.excalidraw', 'Guides/Orion.md', files)?.path).toBe('Sketches/Winter hexagon.excalidraw.md');
  });
  it('lets a bare name mean a note: an image or a canvas needs its extension', () => {
    expect(resolveLink('Winter hexagon', 'README.md', files)).toBeNull();
    expect(resolveLink('Orion', 'README.md', [...files, file('Photos/Orion.png')])?.path).not.toBe('Photos/Orion.png');
  });
  it('prefers the file beside the link, then the nearest, then the shortest path', () => {
    expect(resolveLink('Orion', 'Guides/Observing plan.md', files)?.path).toBe('Guides/Orion.md');
    expect(resolveLink('Orion', 'Archive/2025/Old.md', files)?.path).toBe('Archive/2025/Orion.md');
    expect(resolveLink('Orion', 'README.md', files)?.path).toBe('Archive/Orion.md');
  });
  it('takes a path as a suffix of the file’s path', () => {
    expect(resolveLink('Archive/Orion', 'README.md', files)?.path).toBe('Archive/Orion.md');
    expect(resolveLink('2025/Orion', 'README.md', files)?.path).toBe('Archive/2025/Orion.md');
    expect(resolveLink('/Guides/Orion', 'README.md', files)?.path).toBe('Guides/Orion.md');
  });
  it('is null for nothing, an empty target and folders', () => {
    expect(resolveLink('Nope', 'README.md', files)).toBeNull();
    expect(resolveLink('', 'README.md', files)).toBeNull();
    expect(resolveLink('Guides', 'README.md', [...files, { path: 'Guides', name: 'Guides', type: 'dir' }])).toBeNull();
  });
});

describe('makesNote', () => {
  it('lets a missing name become a note, and keeps other file types from being made as notes', () => {
    expect(makesNote('Nebula')).toBe(true);
    expect(makesNote('Guides/Nebula')).toBe(true);
    expect(makesNote('Orion v2.1')).toBe(true);
    expect(makesNote('Nebula.md')).toBe(true);
    expect(makesNote('Sketch.excalidraw')).toBe(false);
    expect(makesNote('Photos/chart.PNG')).toBe(false);
    expect(makesNote('Star chart.pdf')).toBe(false);
    expect(makesNote('notes.txt')).toBe(false);
  });
});

describe('planNewNote', () => {
  it('puts the note in the folder of the note that links to it', () => {
    expect(planNewNote('Nebula', 'Guides/Orion.md')).toEqual({ path: 'Guides/Nebula.md' });
    expect(planNewNote('Nebula', 'README.md')).toEqual({ path: 'Nebula.md' });
  });
  it('keeps a folder in the link, and starts at the top for a leading slash', () => {
    expect(planNewNote('Deep sky/Nebula', 'Guides/Orion.md')).toEqual({ path: 'Guides/Deep sky/Nebula.md' });
    expect(planNewNote('/Nebula', 'Guides/Orion.md')).toEqual({ path: 'Nebula.md' });
  });
  it('does not add .md twice, and trims', () => {
    expect(planNewNote('  Nebula.md ', 'a/b.md')).toEqual({ path: 'a/Nebula.md' });
  });
  it('refuses a name Nebula refuses, with its message', () => {
    expect(planNewNote('What: now?', 'README.md')).toEqual({ problem: expect.stringContaining('Windows') });
    expect(planNewNote('CON', 'README.md')).toEqual({ problem: expect.stringContaining('reserved') });
    expect(planNewNote('Nebula.', 'README.md')).toEqual({ problem: expect.stringContaining('dot or a space') });
    expect(planNewNote('..', 'README.md')).toHaveProperty('problem');
    expect(planNewNote('.nebula/project', 'README.md')).toEqual({ problem: expect.stringContaining('.nebula') });
    expect(planNewNote('   ', 'README.md')).toEqual({ problem: 'Give the note a name.' });
    expect(planNewNote('a'.repeat(300), 'README.md')).toHaveProperty('problem');
  });
  it('makes a path that resolves back to the note', () => {
    const made = planNewNote('Deep sky/Nebula', 'Guides/Orion.md');
    if (!('path' in made)) throw new Error('expected a path');
    expect(resolveLink('Deep sky/Nebula', 'Guides/Orion.md', [file(made.path)])?.path).toBe(made.path);
  });
});

describe('linkHeading', () => {
  it('is the last of nested headings', () => {
    expect(linkHeading(parseWikilink('Orion#Stars#Rigel'))).toBe('Rigel');
    expect(linkHeading(parseWikilink('Orion#Stars'))).toBe('Stars');
    expect(linkHeading(parseWikilink('Orion'))).toBeUndefined();
  });
});

describe('markdownPath and resolveMarkdownPath', () => {
  it('reads an address relative to the note holding it', () => {
    expect(markdownPath('Photos/x.png', 'Guides/Orion.md')).toBe('Guides/Photos/x.png');
    expect(markdownPath('../Photos/x.png', 'Guides/Orion.md')).toBe('Photos/x.png');
    expect(markdownPath('./x.png', 'README.md')).toBe('x.png');
  });
  it('starts at the top of the project with a leading slash', () => {
    expect(markdownPath('/Photos/x.png', 'Guides/Orion.md')).toBe('Photos/x.png');
  });
  it('decodes %20, drops ?query and #fragment, and takes backslashes as slashes', () => {
    expect(markdownPath('../Photos/my%20image.png?raw=1#top', 'Guides/Orion.md')).toBe('Photos/my image.png');
    expect(markdownPath('..\\Photos\\x.png', 'Guides/Orion.md')).toBe('Photos/x.png');
    expect(markdownPath('100%.png', 'a.md')).toBe('100%.png');
  });
  it('is null for the web, an empty address, and a way out of the project', () => {
    expect(markdownPath('https://example.com/x.png', 'a.md')).toBeNull();
    expect(markdownPath('mailto:a@b.c', 'a.md')).toBeNull();
    expect(markdownPath('//cdn.example/x.png', 'a.md')).toBeNull();
    expect(markdownPath('', 'a.md')).toBeNull();
    expect(markdownPath('#heading', 'a.md')).toBeNull();
    expect(markdownPath('../../x.png', 'Guides/Orion.md')).toBeNull();
  });
  it('finds the file, exactly or by case, and never a folder', () => {
    expect(resolveMarkdownPath('../Photos/winter%20hexagon.PNG', 'Guides/Orion.md', files)?.path).toBe('Photos/Winter hexagon.png');
    expect(resolveMarkdownPath('../Photos/Nope.png', 'Guides/Orion.md', files)).toBeNull();
    expect(resolveMarkdownPath('Guides', 'README.md', [...files, { path: 'Guides', name: 'Guides', type: 'dir' }])).toBeNull();
  });
});

describe('shortestTarget', () => {
  it('writes a note by its bare name while that names it alone, without .md', () => {
    expect(shortestTarget('Guides/Moon phases.md', files)).toBe('Moon phases');
    expect(shortestTarget('README.md', files)).toBe('README');
  });
  it('keeps the extension of anything that isn’t a note, and a canvas is Name.excalidraw', () => {
    expect(shortestTarget('Photos/Winter hexagon.png', files)).toBe('Winter hexagon.png');
    expect(shortestTarget('Sketches/Winter hexagon.excalidraw.md', files)).toBe('Winter hexagon.excalidraw');
    expect(shortestTarget('Charts/Star chart — October.pdf', files)).toBe('Star chart — October.pdf');
  });
  it('adds folders, from the nearest up, only while the name is shared, and a full path when nothing shorter is alone', () => {
    expect(shortestTarget('Guides/Orion.md', files)).toBe('Guides/Orion');
    expect(shortestTarget('Archive/2025/Orion.md', files)).toBe('2025/Orion');
    // 'Archive/Orion' also ends 'Archive/2025/Orion'? No: it ends at a folder boundary, so it names one file.
    expect(shortestTarget('Archive/Orion.md', files)).toBe('Archive/Orion');
    const clash = [...files, file('Orion.md')];
    expect(shortestTarget('Orion.md', clash)).toBe('/Orion');
  });
  it('agrees with resolveLink: what it writes resolves to the file from anywhere', () => {
    for (const entry of files) {
      const written = shortestTarget(entry.path, files);
      for (const from of ['README.md', 'Guides/Orion.md', 'Archive/2025/Orion.md']) expect(resolveLink(written, from, files)?.path, `${written} from ${from}`).toBe(entry.path);
    }
  });
});
