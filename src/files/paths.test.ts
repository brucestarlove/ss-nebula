import { describe, expect, it } from 'vitest';
import { InvalidPathError, ancestors, basename, dirname, extension, isInside, isValidPath, joinPath, newNameProblem, normalizePath, portableName, stem, uniqueName, comparePaths } from './paths';

describe('normalizePath', () => {
  it('accepts relative POSIX paths and returns them unchanged', () => {
    expect(normalizePath('README.md')).toBe('README.md');
    expect(normalizePath('Guides/Observing plan.md')).toBe('Guides/Observing plan.md');
    expect(normalizePath('Charts/Star chart — October.pdf')).toBe('Charts/Star chart — October.pdf');
    expect(normalizePath('.nebula/project.json')).toBe('.nebula/project.json');
    expect(normalizePath('a/b/c/d.txt')).toBe('a/b/c/d.txt');
  });

  it('rejects the empty path and absolute paths', () => {
    expect(() => normalizePath('')).toThrow(InvalidPathError);
    expect(() => normalizePath('/README.md')).toThrow(InvalidPathError);
    expect(() => normalizePath('/')).toThrow(InvalidPathError);
  });

  it("rejects '.' and '..' segments, wherever they appear", () => {
    for (const path of ['.', '..', './a', 'a/.', 'a/./b', '../a', 'a/..', 'a/../b']) {
      expect(() => normalizePath(path), path).toThrow(InvalidPathError);
    }
  });

  it('rejects empty segments, trailing slashes included', () => {
    for (const path of ['a//b', 'a/', 'Guides/', '//a']) {
      expect(() => normalizePath(path), path).toThrow(InvalidPathError);
    }
  });

  it('rejects backslashes, NUL and control characters', () => {
    for (const path of ['a\\b', 'C:\\x', 'a\u0000b', 'tab\there', 'line\nbreak', 'bell\u0007', 'del\u007f', 'c1\u0085']) {
      expect(() => normalizePath(path), JSON.stringify(path)).toThrow(InvalidPathError);
    }
  });

  it('rejects a segment longer than 255 bytes of UTF-8, counting bytes rather than characters', () => {
    expect(normalizePath('a'.repeat(255))).toBe('a'.repeat(255));
    expect(() => normalizePath('a'.repeat(256))).toThrow(InvalidPathError);
    expect(normalizePath(`x/${'é'.repeat(127)}`)).toBe(`x/${'é'.repeat(127)}`); // 254 bytes
    expect(() => normalizePath(`x/${'é'.repeat(128)}`)).toThrow(InvalidPathError); // 256 bytes
  });

  it('rejects values that are not strings', () => {
    expect(() => normalizePath(undefined as unknown as string)).toThrow(InvalidPathError);
    expect(() => normalizePath(42 as unknown as string)).toThrow(InvalidPathError);
  });

  it('says which path was wrong', () => {
    expect(() => normalizePath('a//b')).toThrow(/a\/\/b/);
  });
});

describe('isValidPath', () => {
  it('answers without throwing', () => {
    expect(isValidPath('Guides/Orion.md')).toBe(true);
    expect(isValidPath('../etc/passwd')).toBe(false);
    expect(isValidPath('')).toBe(false);
  });
});

describe('joinPath', () => {
  it('joins segments and multi-segment parts with slashes', () => {
    expect(joinPath('Guides', 'Orion.md')).toBe('Guides/Orion.md');
    expect(joinPath('a/b', 'c/d.txt')).toBe('a/b/c/d.txt');
  });

  it("treats '' as the root", () => {
    expect(joinPath('', 'README.md')).toBe('README.md');
    expect(joinPath('Guides', '')).toBe('Guides');
  });

  it('rejects a result that is not a valid path', () => {
    expect(() => joinPath('Guides', '../secret')).toThrow(InvalidPathError);
    expect(() => joinPath('', '')).toThrow(InvalidPathError);
    expect(() => joinPath('a/', 'b')).toThrow(InvalidPathError);
  });
});

describe('dirname and basename', () => {
  it('split a path at its last slash', () => {
    expect(dirname('Guides/Observing plan.md')).toBe('Guides');
    expect(basename('Guides/Observing plan.md')).toBe('Observing plan.md');
    expect(dirname('a/b/c.txt')).toBe('a/b');
  });

  it("give '' as the folder of a top-level entry", () => {
    expect(dirname('README.md')).toBe('');
    expect(basename('README.md')).toBe('README.md');
  });
});

describe('extension and stem', () => {
  it('split off the last extension, keeping its case', () => {
    expect(extension('Guides/Orion.md')).toBe('md');
    expect(stem('Guides/Orion.md')).toBe('Orion');
    expect(extension('PLEIADES.PNG')).toBe('PNG');
    expect(extension('my.notes.txt')).toBe('txt');
    expect(stem('my.notes.txt')).toBe('my.notes');
  });

  it('know the double extensions Nebula meets', () => {
    expect(extension('Sketches/Winter hexagon.excalidraw.md')).toBe('excalidraw.md');
    expect(stem('Sketches/Winter hexagon.excalidraw.md')).toBe('Winter hexagon');
    expect(extension('Sketch.Excalidraw.MD')).toBe('Excalidraw.MD');
    expect(extension('backup.tar.gz')).toBe('tar.gz');
  });

  it('give no extension to dotfiles, names without a dot and names ending in a dot', () => {
    expect(extension('.gitignore')).toBe('');
    expect(stem('.gitignore')).toBe('.gitignore');
    expect(extension('Makefile')).toBe('');
    expect(extension('draft.')).toBe('');
    expect(stem('draft.')).toBe('draft.');
    expect(extension('.env.local')).toBe('local');
    expect(stem('.env.local')).toBe('.env');
  });
});

describe('ancestors and isInside', () => {
  it('lists the folders above a path, outermost first', () => {
    expect(ancestors('a/b/c.txt')).toEqual(['a', 'a/b']);
    expect(ancestors('README.md')).toEqual([]);
  });

  it('tells whether a path is a folder or inside it, by whole segments', () => {
    expect(isInside('Guides/Orion.md', 'Guides')).toBe(true);
    expect(isInside('Guides', 'Guides')).toBe(true);
    expect(isInside('Guides/a/b.md', 'Guides/a')).toBe(true);
    expect(isInside('Guidesbook.md', 'Guides')).toBe(false);
    expect(isInside('Other/Guides', 'Guides')).toBe(false);
  });
});

describe('uniqueName', () => {
  it('keeps the desired name when nothing has it', () => {
    expect(uniqueName(['Orion.md'], 'Moon phases.md')).toBe('Moon phases.md');
    expect(uniqueName([], 'Untitled.md')).toBe('Untitled.md');
  });

  it("adds ' 2', ' 3' before the extension", () => {
    expect(uniqueName(['Untitled.md'], 'Untitled.md')).toBe('Untitled 2.md');
    expect(uniqueName(['Untitled.md', 'Untitled 2.md'], 'Untitled.md')).toBe('Untitled 3.md');
    expect(uniqueName(new Set(['Photos']), 'Photos')).toBe('Photos 2');
  });

  it('keeps a double extension together', () => {
    expect(uniqueName(['Sketch.excalidraw.md'], 'Sketch.excalidraw.md')).toBe('Sketch 2.excalidraw.md');
    expect(uniqueName(['archive.tar.gz'], 'archive.tar.gz')).toBe('archive 2.tar.gz');
  });

  it('adds the number after a dotfile name', () => {
    expect(uniqueName(['.gitignore'], '.gitignore')).toBe('.gitignore 2');
  });

  it('treats names differing only in case or Unicode composition as taken, so exports stay portable', () => {
    expect(uniqueName(['readme.md'], 'README.md')).toBe('README 2.md');
    expect(uniqueName(['Cafe\u0301.md'], 'Caf\u00e9.md')).toBe('Caf\u00e9 2.md');
  });

  it('shortens the stem rather than return a name over 255 bytes', () => {
    const long = `${'a'.repeat(252)}.md`;
    const result = uniqueName([long], long);
    expect(new TextEncoder().encode(result).length).toBeLessThanOrEqual(255);
    expect(result.endsWith(' 2.md')).toBe(true);
    expect(isValidPath(result)).toBe(true);
  });

  it('rejects a desired name that is not a single valid segment', () => {
    expect(() => uniqueName([], 'Guides/Orion.md')).toThrow(InvalidPathError);
    expect(() => uniqueName([], '..')).toThrow(InvalidPathError);
  });
});

describe('comparePaths', () => {
  it('orders by segment, so a folder comes straight before its contents', () => {
    const paths = ['b.md', 'Guides 2/x.md', 'a/b/c.txt', 'Guides/Orion.md', 'Guides 2', 'a', 'Guides', 'a/b', 'Guides/Moon phases.md', 'Empty'];
    expect([...paths].sort(comparePaths)).toEqual([
      'Empty',
      'Guides',
      'Guides/Moon phases.md',
      'Guides/Orion.md',
      'Guides 2',
      'Guides 2/x.md',
      'a',
      'a/b',
      'a/b/c.txt',
      'b.md',
    ]);
  });

  it('returns 0 only for the same path', () => {
    expect(comparePaths('a/b', 'a/b')).toBe(0);
    expect(comparePaths('a', 'a/b')).toBeLessThan(0);
    expect(comparePaths('a/b', 'a')).toBeGreaterThan(0);
  });
});

describe('newNameProblem, for names people type or upload', () => {
  it('accepts ordinary names in any language, dotfiles and names that only start like reserved ones', () => {
    for (const name of ['Orion.md', 'Été — notes.md', '星図.png', 'خريطة.md', '.gitignore', 'a.b.c', 'CONSOLE.md', 'COM10.txt', 'LPT0.txt', 'con-notes.md', 'Aux plans.md', 'v1.2']) {
      expect(newNameProblem(name), name).toBeNull();
    }
  });

  it('refuses invisible text-direction controls, which can make a name read backwards', () => {
    for (const name of ['report\u202Efdp.exe', '\u202Aa.md', 'a\u202B.md', 'a\u202C.md', 'a\u202D.md', '\u2066a.md', 'a\u2067.md', 'a\u2068.md', 'a\u2069.md']) {
      expect(newNameProblem(name), JSON.stringify(name)).toMatch(/direction/);
    }
  });

  it('refuses line and paragraph separators, and control characters', () => {
    expect(newNameProblem('a\u2028b.md')).toMatch(/line break/);
    expect(newNameProblem('a\u2029b.md')).toMatch(/line break/);
    expect(newNameProblem('a\u0007b.md')).toMatch(/control/);
  });

  it('refuses each character Windows reserves, naming it', () => {
    for (const character of ['<', '>', ':', '"', '|', '?', '*']) expect(newNameProblem(`a${character}b.md`)).toContain(character);
  });

  it('refuses the names Windows reserves, with or without an extension, in any case', () => {
    for (const name of ['CON', 'con', 'Prn.txt', 'AUX.tar.gz', 'nul', 'NUL.md', 'COM1', 'com9.md', 'LPT1', 'lpt9.png', 'CON .txt']) {
      expect(newNameProblem(name), name).toMatch(/reserved/);
    }
  });

  it('refuses a trailing dot or space', () => {
    for (const name of ['notes.', 'notes..', 'notes ', 'notes. ']) expect(newNameProblem(name), JSON.stringify(name)).toMatch(/end with/);
  });
});

describe('portableName, for names that must unpack on Windows and macOS', () => {
  it('leaves an ordinary name exactly as it is', () => {
    for (const name of ['Orion.md', 'Été — notes.md', '星図.png', '.gitignore', 'CONSOLE.md']) expect(portableName(name)).toBe(name);
  });

  it('maps reserved characters, reserved names, trailing dots and spaces, and drops direction controls', () => {
    expect(portableName('Plans: phase 1?.md')).toBe('Plans_ phase 1_.md');
    expect(portableName('a<b>c"d|e*f.md')).toBe('a_b_c_d_e_f.md');
    expect(portableName('CON')).toBe('CON_');
    expect(portableName('con.txt')).toBe('con_.txt');
    expect(portableName('LPT9.tar.gz')).toBe('LPT9_.tar.gz');
    expect(portableName('notes.')).toBe('notes');
    expect(portableName('notes ')).toBe('notes');
    expect(portableName('...')).toBe('_');
    expect(portableName('report\u202Efdp.exe')).toBe('reportfdp.exe');
    expect(portableName('a\u2028b.md')).toBe('a b.md');
  });

  it('always gives a name that newNameProblem accepts', () => {
    for (const name of ['Plans: phase 1?.md', 'CON', 'con .txt', 'notes. ', '...', '\u202E', 'a\u2029', 'AUX.', 'x\u0001y']) {
      expect(newNameProblem(portableName(name)), JSON.stringify(name)).toBeNull();
    }
  });
});
