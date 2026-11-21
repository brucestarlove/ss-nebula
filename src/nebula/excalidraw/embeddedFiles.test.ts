import { describe, expect, it } from 'vitest';
import gardenPlan from '../../files/fixtures/obsidian/Edraw - Garden plan.md?raw';
import { editEmbeddedFiles, embeddedFiles, embeddedTarget, rewriteEmbeddedLinks } from './embeddedFiles';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown, updateObsidianExcalidrawMarkdown } from './obsidianMarkdown';
import type { ExcalidrawScene } from './scene';

// The `## Embedded Files` section of an Obsidian drawing: where a canvas's images live as files beside it.
// Drawings written by the plugin must read, and must come back byte for byte when nothing changed.

/** A drawing's text with `body` as its Embedded Files section, in the plugin's layout. */
function drawing(body: string, { notes = '', eol = '\n' }: { notes?: string; eol?: string } = {}): string {
  const text = ['---', 'excalidraw-plugin: parsed', '---', notes, '# Excalidraw Data', '', '## Text Elements', 'Hello ^abcd1234', '', '## Embedded Files', body, '%%', '## Drawing', '```json', '{}', '```', '%%'].join('\n');
  return eol === '\n' ? text : text.replace(/\n/g, eol);
}

const lines = (text: string) => embeddedFiles(text).map(({ id, target }) => [id, target]);

describe('reading Embedded Files lines', () => {
  it('reads each of the plugin’s forms of a reference: a name, a path, a size, a page, a colour map', () => {
    const text = drawing(
      [
        'a1: [[Name.png]]',
        '',
        'a2: [[Photos/Name.png]]',
        '',
        'a3: [[Sky.png|100%]]',
        '',
        'a4: [[Paper.pdf#page=2]]',
        '',
        'a5: [[Logo.svg]] {"#000":"#fff"}',
        '',
        'a6: [[Both.pdf#page=2|50]]',
        '',
      ].join('\n'),
    );
    expect(lines(text)).toEqual([
      ['a1', 'Name.png'],
      ['a2', 'Photos/Name.png'],
      ['a3', 'Sky.png'],
      ['a4', 'Paper.pdf'],
      ['a5', 'Logo.svg'],
      ['a6', 'Both.pdf'],
    ]);
    // The link keeps its alias and fragment: a rename must write them back.
    expect(embeddedFiles(text)[2].link).toBe('Sky.png|100%');
    expect(embeddedFiles(text)[3].link).toBe('Paper.pdf#page=2');
  });

  it('reads a CRLF section: no carriage return in an id or a link', () => {
    const found = embeddedFiles(drawing('a1: [[Name.png]]\n\na2: [[Sky.png|100%]]\n', { eol: '\r\n' }));
    expect(found.map(({ id, link }) => [id, link])).toEqual([
      ['a1', 'Name.png'],
      ['a2', 'Sky.png|100%'],
    ]);
  });

  it('does not take a hyperlink or an equation for a file', () => {
    const text = drawing(['h1: https://example.com/[[not-a-file]]', '', 'e1: $$x^2 + [[y]]$$', '', 'f1: [[Real.png]]', ''].join('\n'));
    expect(lines(text)).toEqual([['f1', 'Real.png']]);
  });

  it('reads the section after `# Excalidraw Data`, not a heading in the back-of-card notes above it', () => {
    const text = drawing('real: [[Mine.png]]\n', { notes: '## Embedded Files\nfake: [[Theirs.png]]\n' });
    expect(lines(text)).toEqual([['real', 'Mine.png']]);
  });

  it('reads the Garden plan, 62 images, each id once and in order', () => {
    const found = embeddedFiles(gardenPlan);
    expect(found).toHaveLength(62);
    expect(new Set(found.map((file) => file.id)).size).toBe(62);
    expect(found[0]).toMatchObject({ id: 'aa2f352e86b54631af2eaf990f8b41c2f2e21570', target: 'Garden photo 01.png' });
    // Where the link is in the text is where it is.
    for (const file of found) expect(gardenPlan.slice(file.linkStart, file.linkEnd)).toBe(file.link);
  });

  it('names the target as the part before `#` or `|`, trimmed', () => {
    expect(embeddedTarget('Sky.png')).toBe('Sky.png');
    expect(embeddedTarget('Sky.png|100%')).toBe('Sky.png');
    expect(embeddedTarget('Paper.pdf#page=2')).toBe('Paper.pdf');
    expect(embeddedTarget(' Sky.png |100%')).toBe('Sky.png');
  });
});

describe('editEmbeddedFiles', () => {
  it('gives the text back byte for byte when nothing changes', () => {
    const compact = drawing('a1: [[One.png]]\na2: [[Two.png]]\n');
    for (const text of [gardenPlan, compact, drawing('a1: [[One.png]]\n\n', { eol: '\r\n' }), drawing('')]) {
      expect(editEmbeddedFiles(text, {})).toBe(text);
      // Lines already there, and ids with no line to drop, change nothing either.
      const first = embeddedFiles(text)[0];
      expect(editEmbeddedFiles(text, { add: first ? [[first.id, 'Other.png']] : [], drop: new Set(['nobody']) })).toBe(text);
    }
    // A file with no section and nothing to add stays as it is.
    const bare = toObsidianExcalidrawMarkdown({ type: 'excalidraw', version: 2, source: 't', elements: [], appState: {}, files: {} });
    expect(editEmbeddedFiles(bare, { drop: new Set(['x']) })).toBe(bare);
  });

  it('keeps the link a line has when it is asked to add the same id again', () => {
    const text = drawing('a1: [[Renamed.png]]\n\n');
    expect(editEmbeddedFiles(text, { add: [['a1', 'Old name.png']] })).toBe(text);
  });

  it('adds a line at the end of a section the plugin spaced, with a blank line between', () => {
    const text = drawing('a1: [[One.png]]\n\na2: [[Two.png]]\n\n');
    const next = editEmbeddedFiles(text, { add: [['a3', 'Three.png']] });
    expect(next).toBe(drawing('a1: [[One.png]]\n\na2: [[Two.png]]\n\na3: [[Three.png]]\n\n'));
    expect(lines(next).map(([id]) => id)).toEqual(['a1', 'a2', 'a3']);
  });

  it('adds a line to a compact section without blank lines between', () => {
    const text = drawing('a1: [[One.png]]\na2: [[Two.png]]\n');
    expect(editEmbeddedFiles(text, { add: [['a3', 'Three.png']] })).toBe(drawing('a1: [[One.png]]\na2: [[Two.png]]\na3: [[Three.png]]\n'));
  });

  it('fills an empty section, and adds several lines in the order given', () => {
    const next = editEmbeddedFiles(drawing(''), { add: [['x1', 'A.png'], ['x2', 'B.png']] });
    expect(lines(next)).toEqual([['x1', 'A.png'], ['x2', 'B.png']]);
    expect(editEmbeddedFiles(drawing('a1: [[One.png]]\n\n'), { add: [['x1', 'A.png'], ['x2', 'B.png']] })).toContain('a1: [[One.png]]\n\nx1: [[A.png]]\n\nx2: [[B.png]]\n');
  });

  it('drops a line with the blank line after it, and every other line stays', () => {
    const text = drawing('a1: [[One.png]]\n\na2: [[Two.png]]\n\na3: [[Three.png]]\n\n');
    expect(editEmbeddedFiles(text, { drop: new Set(['a2']) })).toBe(drawing('a1: [[One.png]]\n\na3: [[Three.png]]\n\n'));
    expect(editEmbeddedFiles(drawing('a1: [[One.png]]\n\n'), { drop: new Set(['a1']) })).toBe(drawing(''));
  });

  it('drops only file references: a hyperlink or an equation with the id stays', () => {
    const text = drawing('h1: https://example.com\n\ne1: $$x$$\n\n');
    expect(editEmbeddedFiles(text, { drop: new Set(['h1', 'e1']) })).toBe(text);
  });

  it('makes the section before the `%%` that opens the drawing when there is none', () => {
    const scene: ExcalidrawScene = { type: 'excalidraw', version: 2, source: 't', elements: [], appState: {}, files: {} };
    const bare = toObsidianExcalidrawMarkdown(scene);
    expect(embeddedFiles(bare)).toEqual([]);
    const next = editEmbeddedFiles(bare, { add: [['a1', 'One.png']] });
    expect(lines(next)).toEqual([['a1', 'One.png']]);
    expect(next.indexOf('## Embedded Files')).toBeLessThan(next.indexOf('%%\n## Drawing'));
    // Taking the line away again leaves a drawing that still reads.
    expect(readObsidianExcalidrawMarkdown(next).elements).toEqual([]);
  });

  it('keeps CRLF through updateObsidianExcalidrawMarkdown, lines it adds included', () => {
    const scene: ExcalidrawScene = { type: 'excalidraw', version: 2, source: 't', elements: [{ id: 'r1', type: 'rectangle', x: 0, y: 0, width: 5, height: 5 }], appState: {}, files: {} };
    const crlf = toObsidianExcalidrawMarkdown(scene, { embedded: { add: [['a1', 'One.png']] } }).replace(/\n/g, '\r\n');
    const next = updateObsidianExcalidrawMarkdown(crlf, scene, { embedded: { add: [['a2', 'Two.png']] } });
    expect(next).not.toMatch(/(^|[^\r])\n/);
    expect(lines(next)).toEqual([['a1', 'One.png'], ['a2', 'Two.png']]);
  });
});

describe('rewriteEmbeddedLinks', () => {
  it('changes only the links asked for, every other byte, CRLF included, as it was', () => {
    const text = drawing('a1: [[Old.png]]\r\n\r\na2: [[Keep.png|50]]\r\n\r\n'.replace(/\r\n/g, '\n'), { eol: '\r\n' });
    const { text: next, count } = rewriteEmbeddedLinks(text, (link) => (link === 'Old.png' ? 'Photos/Old.png' : null));
    expect(count).toBe(1);
    expect(next).toBe(text.replace('[[Old.png]]', '[[Photos/Old.png]]'));
  });

  it('returns the same text and no count when nothing is rewritten', () => {
    const { text, count } = rewriteEmbeddedLinks(gardenPlan, () => null);
    expect(count).toBe(0);
    expect(text).toBe(gardenPlan);
  });
});
