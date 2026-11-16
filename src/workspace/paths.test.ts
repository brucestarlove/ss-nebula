import { describe, expect, it } from 'vitest';
import { describeName, movePath, renameTarget, validateName } from './paths';

// basename, dirname, joinPath, isInside and uniqueName are src/files/paths.ts,
// tested in src/files/paths.test.ts.

describe('movePath', () => {
  it('moves a path that lies inside a renamed folder, and leaves others alone', () => {
    expect(movePath('Guides/Orion.md', 'Guides', 'Notes')).toBe('Notes/Orion.md');
    expect(movePath('Guides', 'Guides', 'Notes')).toBe('Notes');
    expect(movePath('Guides2/Orion.md', 'Guides', 'Notes')).toBe('Guides2/Orion.md');
  });
});

describe('describeName', () => {
  it('drops the extension of notes and canvases, which the tree marks by type', () => {
    expect(describeName('Observing plan.md')).toEqual({ label: 'Observing plan', tag: '' });
    expect(describeName('Winter hexagon.excalidraw.md')).toEqual({ label: 'Winter hexagon', tag: '' });
    expect(describeName('scene.excalidraw')).toEqual({ label: 'scene', tag: '' });
    expect(describeName('Shouting.MD')).toEqual({ label: 'Shouting', tag: '' });
  });

  it('shows any other extension as a tag', () => {
    expect(describeName('Orion Nebula.jpg')).toEqual({ label: 'Orion Nebula', tag: 'jpg' });
    expect(describeName('Meteor showers 2026.csv')).toEqual({ label: 'Meteor showers 2026', tag: 'csv' });
  });

  it('tags only the last of two extensions', () => {
    expect(describeName('Sketch.excalidraw.png')).toEqual({ label: 'Sketch.excalidraw', tag: 'png' });
    expect(describeName('archive.tar.gz')).toEqual({ label: 'archive.tar', tag: 'gz' });
  });

  it('leaves names without an extension, and dotfiles, as they are', () => {
    expect(describeName('README')).toEqual({ label: 'README', tag: '' });
    expect(describeName('.gitignore')).toEqual({ label: '.gitignore', tag: '' });
  });
});

describe('validateName', () => {
  it('accepts an ordinary name', () => {
    expect(validateName('Orion.md')).toBeNull();
  });

  it('refuses empty names, separators and the dot names', () => {
    expect(validateName('')).toMatch(/name/i);
    expect(validateName('   ')).toMatch(/name/i);
    expect(validateName('a/b.md')).toMatch(/\//);
    expect(validateName('a\\b.md')).toMatch(/\\/);
    expect(validateName('.')).not.toBeNull();
    expect(validateName('..')).not.toBeNull();
  });

  it('refuses names that won’t work on Windows, or that hide what they are', () => {
    expect(validateName('CON.txt')).toBe('CON is reserved on Windows.');
    expect(validateName('a:b')).toBe('A name can’t contain :, which Windows reserves.');
    expect(validateName('report\u202Efdp.exe')).toBe('A name can’t contain invisible text-direction characters.');
    expect(validateName('draft. ')).toBe('A name can’t end with a dot or a space.');
  });

  it('keeps .nebula for the project settings', () => {
    expect(validateName('.nebula')).not.toBeNull();
  });
});

describe('renameTarget', () => {
  it('keeps a file’s extension when the name is typed without it', () => {
    expect(renameTarget('Observing plan.md', 'Field plan', false)).toBe('Field plan.md');
    expect(renameTarget('Winter hexagon.excalidraw.md', 'Summer triangle', false)).toBe('Summer triangle.excalidraw.md');
    expect(renameTarget('Orion Nebula.jpg', 'Orion', false)).toBe('Orion.jpg');
  });

  it('doesn’t double an extension that was typed, in any case', () => {
    expect(renameTarget('Orion Nebula.jpg', 'Orion.jpg', false)).toBe('Orion.jpg');
    expect(renameTarget('Orion Nebula.jpg', 'Orion.JPG', false)).toBe('Orion.JPG');
  });

  it('renames folders and extensionless files as typed, trimmed', () => {
    expect(renameTarget('Guides', '  Field guides ', true)).toBe('Field guides');
    expect(renameTarget('README', 'Read me', false)).toBe('Read me');
    expect(renameTarget('a.md', '  b  ', false)).toBe('b.md');
  });
});
