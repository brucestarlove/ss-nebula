import { describe, expect, it } from 'vitest';
import type { FileEntry, ProjectRecord } from '../files/types';
import { matchText, quickOpenFiles, quickOpenProjects, splitHighlights } from './quickOpen';

const file = (path: string): FileEntry => ({ path, name: path.slice(path.lastIndexOf('/') + 1), type: 'file' });
const project = (id: string, name: string): ProjectRecord => ({
  id,
  name,
  color: '#7c8cff',
  created: '2026-10-22T00:00:00.000Z',
  createdBy: 'nebula',
  tier: 'browser',
});

const FILES: FileEntry[] = [
  { path: 'Guides', name: 'Guides', type: 'dir' },
  file('Guides/Orion.md'),
  file('Guides/Observing plan.md'),
  file('Photos/Orion Nebula.jpg'),
  file('Sketches/Winter hexagon.excalidraw.md'),
  file('Charts/Meteor showers 2026.csv'),
  file('README.md'),
];

describe('matchText', () => {
  it('finds the query anywhere in the text, ignoring case', () => {
    expect(matchText('Orion Nebula.jpg', 'NEB')).toEqual([[6, 9]]);
  });

  it('says no when the text lacks the query, and yes to an empty query', () => {
    expect(matchText('Pleiades', 'or')).toBeNull();
    expect(matchText('Pleiades', '')).toEqual([]);
  });
});

describe('quickOpenFiles', () => {
  it('matches file names, never folders, and says where each file lives', () => {
    const results = quickOpenFiles(FILES, 'or');
    expect(results.map((result) => result.path)).toEqual(['Guides/Orion.md', 'Photos/Orion Nebula.jpg', 'Charts/Meteor showers 2026.csv']);
    expect(results[0]).toMatchObject({ title: 'Orion', folder: 'Guides', ranges: [[0, 2]] });
  });

  it('shows notes and canvases by name, and other files with their extension', () => {
    const titles = quickOpenFiles(FILES, '').map((result) => result.title);
    expect(titles).toContain('Winter hexagon');
    expect(titles).toContain('Orion Nebula.jpg');
    expect(titles).not.toContain('Guides');
  });

  it('puts names that start with the query first, then shorter names', () => {
    const results = quickOpenFiles(
      [file('A/The planet.md'), file('Planets.md'), file('Planet.md'), file('Dwarf planet list.md')],
      'planet',
    );
    expect(results.map((result) => result.title)).toEqual(['Planet', 'Planets', 'The planet', 'Dwarf planet list']);
  });

  it('lists every file A to Z for an empty query, up to the limit', () => {
    const results = quickOpenFiles(FILES, '', 3);
    expect(results.map((result) => result.title)).toEqual(['Meteor showers 2026.csv', 'Observing plan', 'Orion']);
  });
});

describe('quickOpenProjects', () => {
  const projects = [project('a', 'Night Sky'), project('b', 'Orbit'), project('c', 'Earth Village')];

  it('matches the other projects by name', () => {
    const results = quickOpenProjects(projects, 'a', 'or');
    expect(results.map((result) => result.project.name)).toEqual(['Orbit']);
    expect(results[0].ranges).toEqual([[0, 2]]);
  });

  it('never offers the project you are in', () => {
    expect(quickOpenProjects(projects, 'a', 'night')).toEqual([]);
  });
});

describe('splitHighlights', () => {
  it('cuts text into plain and marked runs', () => {
    expect(splitHighlights('Orion Nebula', [[0, 2], [6, 9]])).toEqual([
      { text: 'Or', mark: true },
      { text: 'ion ', mark: false },
      { text: 'Neb', mark: true },
      { text: 'ula', mark: false },
    ]);
  });
});
