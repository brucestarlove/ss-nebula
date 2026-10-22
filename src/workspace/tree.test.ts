import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../files/types';
import { buildTree, visibleNodes } from './tree';

function file(path: string, size = 10): FileEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file', size };
}

function dir(path: string): FileEntry {
  return { path, name: path.slice(path.lastIndexOf('/') + 1), type: 'dir' };
}

const names = (nodes: { name: string }[]) => nodes.map((node) => node.name);

describe('buildTree', () => {
  it('nests files under their folders', () => {
    const tree = buildTree([dir('Guides'), file('Guides/Orion.md'), file('README.md')]);
    expect(names(tree)).toEqual(['Guides', 'README.md']);
    expect(names(tree[0].children)).toEqual(['Orion.md']);
    expect(tree[0].children[0].path).toBe('Guides/Orion.md');
  });

  it('puts folders before files at every level', () => {
    const tree = buildTree([
      file('a.md'),
      dir('z'),
      file('z/a.md'),
      dir('z/b'),
      file('z/b/c.md'),
    ]);
    expect(names(tree)).toEqual(['z', 'a.md']);
    expect(names(tree[0].children)).toEqual(['b', 'a.md']);
  });

  it('sorts A to Z without regard to case, and numbers by their value', () => {
    const tree = buildTree([file('banana.md'), file('Apple.md'), file('Note 10.md'), file('Note 2.md'), file('cherry.md')]);
    expect(names(tree)).toEqual(['Apple.md', 'banana.md', 'cherry.md', 'Note 2.md', 'Note 10.md']);
  });

  it('sorts by the name the tree shows, so a note comes before its longer namesakes', () => {
    const tree = buildTree([file('Orion Nebula.jpg'), file('Orion.md')]);
    expect(names(tree)).toEqual(['Orion.md', 'Orion Nebula.jpg']);
  });

  it('labels files the way the rail shows them', () => {
    const tree = buildTree([file('Winter hexagon.excalidraw.md'), file('Pleiades.png')]);
    expect(tree.find((node) => node.name === 'Pleiades.png')).toMatchObject({ label: 'Pleiades', tag: 'png' });
    expect(tree.find((node) => node.name === 'Winter hexagon.excalidraw.md')).toMatchObject({ label: 'Winter hexagon', tag: '' });
  });

  it('counts the files inside each folder, however deep', () => {
    const tree = buildTree([dir('Media'), dir('Media/Audio'), file('Media/Audio/a.m4a'), file('Media/Audio/b.m4a'), file('Media/c.png')]);
    expect(tree[0].fileCount).toBe(3);
    expect(tree[0].children[0].fileCount).toBe(2);
  });

  it('makes up a folder for files whose folder was not listed', () => {
    const tree = buildTree([file('Charts/Star chart.pdf')]);
    expect(tree[0]).toMatchObject({ path: 'Charts', type: 'dir', fileCount: 1 });
    expect(names(tree[0].children)).toEqual(['Star chart.pdf']);
  });
});

describe('visibleNodes', () => {
  const tree = buildTree([
    dir('Guides'),
    file('Guides/Orion.md'),
    dir('Guides/Deep'),
    file('Guides/Deep/M42.md'),
    dir('Photos'),
    file('Photos/Pleiades.png'),
    file('README.md'),
  ]);

  it('lists the rows on screen, top to bottom, with their depth', () => {
    const rows = visibleNodes(tree, new Set(['Guides']));
    expect(rows.map((row) => [row.node.path, row.level])).toEqual([
      ['Guides', 1],
      ['Guides/Deep', 2],
      ['Guides/Orion.md', 2],
      ['Photos', 1],
      ['README.md', 1],
    ]);
  });

  it('hides the inside of a folder whose parent is folded', () => {
    const rows = visibleNodes(tree, new Set(['Guides/Deep']));
    expect(rows.map((row) => row.node.path)).toEqual(['Guides', 'Photos', 'README.md']);
  });
});
