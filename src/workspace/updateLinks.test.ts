import { describe, expect, it } from 'vitest';
import { embeddedFiles } from '../nebula/excalidraw/embeddedFiles';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../nebula/excalidraw/obsidianMarkdown';
import { linkWorld, mayHaveLinks, updateCanvasLinks, updateLinks, type LinkWorld } from './updateLinks';

/** The project before, a list of moves (a file or a folder, old → new), and what that makes of the files. */
function moveWorld(files: string[], moves: Record<string, string>): { world: LinkWorld; at: (path: string) => string } {
  const moved = new Map<string, string>();
  for (const path of files) {
    for (const [from, to] of Object.entries(moves)) {
      if (path === from) moved.set(path, to);
      else if (path.startsWith(`${from}/`)) moved.set(path, to + path.slice(from.length));
    }
  }
  const after = files.map((path) => moved.get(path) ?? path);
  return { world: linkWorld(files, after, moved), at: (path) => moved.get(path) ?? path };
}

const FILES = ['README.md', 'Guides/Observing plan.md', 'Guides/Orion.md', 'Misc/Orion.md', 'Sketches/Winter hexagon.excalidraw.md', 'Photos/Winter hexagon.png', 'Photos/my image.png', 'Charts/Star chart — October.pdf'];

/** What `updateLinks` makes of `text`, for a note at `note` after `moves`. */
function run(text: string, moves: Record<string, string>, note = 'Guides/Observing plan.md', files = FILES) {
  const { world, at } = moveWorld(files, moves);
  return updateLinks(text, note, at(note), world);
}

const rename = (text: string, moves: Record<string, string>, note?: string, files?: string[]) => run(text, moves, note, files).text;

describe('updateLinks: wikilinks', () => {
  const ORION = { 'Guides/Orion.md': 'Guides/Orion 2.md' };

  it('follows a renamed note by its bare name', () => {
    expect(run('See [[Orion]] now.', ORION)).toEqual({ text: 'See [[Orion 2]] now.', count: 1 });
  });

  it('keeps the alias, the heading, the block id and an embed’s size', () => {
    expect(rename('[[Orion|the hunter]]', ORION)).toBe('[[Orion 2|the hunter]]');
    expect(rename('[[Orion#Stars]]', ORION)).toBe('[[Orion 2#Stars]]');
    expect(rename('[[Orion#^abc123]]', ORION)).toBe('[[Orion 2#^abc123]]');
    expect(rename('[[Orion#Stars#^abc123|x]]', ORION)).toBe('[[Orion 2#Stars#^abc123|x]]');
    expect(rename('![[Orion#Stars]]', ORION)).toBe('![[Orion 2#Stars]]');
    expect(rename('![[Winter hexagon.png|300]]', { 'Photos/Winter hexagon.png': 'Photos/Hexagon.png' })).toBe('![[Hexagon.png|300]]');
    expect(rename('![[Winter hexagon.png|300x200]]', { 'Photos/Winter hexagon.png': 'Photos/Hexagon.png' })).toBe('![[Hexagon.png|300x200]]');
    expect(rename('![[Winter hexagon.png|a caption]]', { 'Photos/Winter hexagon.png': 'Photos/Hexagon.png' })).toBe('![[Hexagon.png|a caption]]');
  });

  it('writes a canvas as Name.excalidraw, and a note’s .md only where the link had it', () => {
    expect(rename('![[Winter hexagon.excalidraw]]', { 'Sketches/Winter hexagon.excalidraw.md': 'Sketches/Hexagon.excalidraw.md' })).toBe('![[Hexagon.excalidraw]]');
    expect(rename('![[Winter hexagon.excalidraw.md]]', { 'Sketches/Winter hexagon.excalidraw.md': 'Sketches/Hexagon.excalidraw.md' })).toBe('![[Hexagon.excalidraw.md]]');
    expect(rename('[[Orion.md]]', ORION)).toBe('[[Orion 2.md]]');
  });

  it('leaves a link alone when the same words still reach the same file: a move that changes nothing costs nothing', () => {
    // Orion.md moves to another folder; from this note [[Orion]] still reaches the one beside it? No: it moves away from the note, so use a note elsewhere.
    expect(run('[[Orion]]', { 'Guides/Orion.md': 'Archive/Orion.md' }, 'README.md')).toEqual({ text: '[[Orion]]', count: 0 });
    expect(run('[[Winter hexagon.png]]', { 'Photos/Winter hexagon.png': 'Gallery/Winter hexagon.png' })).toEqual({ text: '[[Winter hexagon.png]]', count: 0 });
    expect(run('no links here', ORION)).toEqual({ text: 'no links here', count: 0 });
  });

  it('follows a link written as a path to the new path, and an anchored one stays anchored', () => {
    expect(rename('[[Guides/Orion]]', { 'Guides/Orion.md': 'Archive/Orion.md' })).toBe('[[Archive/Orion]]');
    expect(rename('[[Guides/Orion#Stars|x]]', ORION)).toBe('[[Guides/Orion 2#Stars|x]]');
    expect(rename('[[/Guides/Orion]]', { 'Guides/Orion.md': 'Archive/Orion.md' })).toBe('[[/Archive/Orion]]');
  });

  it('keeps a bare name bare while it names the file alone, else writes the shortest path that does', () => {
    // Two Orions: from this note, [[Orion]] meant the one beside it. Moved to a folder that sorts after Misc, the bare name would reach Misc's.
    expect(rename('[[Orion]]', { 'Guides/Orion.md': 'Zeta/Orion.md' })).toBe('[[Zeta/Orion]]');
    // A new folder with its own name: the path needs two parts only when the name alone isn't unique.
    expect(rename('[[Orion]]', { 'Guides/Orion.md': 'Zeta/Deep/Orion.md' })).toBe('[[Deep/Orion]]');
    // Moved to the top: nothing else is called that, so the name alone does.
    expect(rename('[[Orion]]', { 'Guides/Orion.md': 'Orion 3.md' })).toBe('[[Orion 3]]');
  });

  it('writes the whole path with a leading slash when no tail of it is unique', () => {
    const files = ['a/Note.md', 'b/Note.md', 'c/b/Note.md', 'y/x/b/Note.md', 'Linker.md'];
    // After the move: b/Note, x/b/Note and y/x/b/Note all end the same way; only the whole path, anchored, names the moved one.
    expect(rename('[[a/Note]]', { 'a/Note.md': 'x/b/Note.md' }, 'Linker.md', files)).toBe('[[/x/b/Note]]');
  });

  it('follows a folder renamed: names stay, paths follow', () => {
    const moves = { Guides: 'Notes' };
    // The note moved with its folder, and its sibling by name is still beside it.
    expect(run('[[Orion]] and [[Guides/Orion]]', moves)).toEqual({ text: '[[Orion]] and [[Notes/Orion]]', count: 1 });
    // A note elsewhere that named a note in the folder by its path.
    expect(rename('[[Guides/Observing plan|plan]]', moves, 'README.md')).toBe('[[Notes/Observing plan|plan]]');
  });

  it('follows a note that links to itself', () => {
    expect(run('I am [[Orion]], and [[Orion#Stars]].', ORION, 'Guides/Orion.md')).toEqual({ text: 'I am [[Orion 2]], and [[Orion 2#Stars]].', count: 2 });
  });

  it('ignores case in what it reads, writes the file’s own name, and keeps spaces inside the brackets', () => {
    expect(rename('[[orion]]', ORION)).toBe('[[Orion 2]]');
    expect(rename('[[ Orion | the hunter ]]', ORION)).toBe('[[ Orion 2 | the hunter ]]');
  });

  it('keeps the slash in front of a bar written for a table', () => {
    expect(rename('| [[Orion\\|the hunter]] |', ORION)).toBe('| [[Orion 2\\|the hunter]] |');
  });

  it('leaves a link to nothing as it was, and a link to a heading in this note', () => {
    expect(run('[[Nope]] [[#Targets]] [[Orion 2]]', ORION)).toEqual({ text: '[[Nope]] [[#Targets]] [[Orion 2]]', count: 0 });
  });

  it('does not rewrite a link to a file that is gone', () => {
    const files = FILES;
    const world = linkWorld(files, files.filter((path) => path !== 'Guides/Orion.md'), new Map());
    expect(updateLinks('[[Orion]]', 'Guides/Observing plan.md', 'Guides/Observing plan.md', world).count).toBe(0);
  });

  it('works on every link of a note, and counts them', () => {
    const text = 'A [[Orion]], B ![[Orion#Stars]], C [[Orion|d]], D [[Moon]].';
    expect(run(text, ORION)).toEqual({ text: 'A [[Orion 2]], B ![[Orion 2#Stars]], C [[Orion 2|d]], D [[Moon]].', count: 3 });
  });
});

describe('updateLinks: what is not a link', () => {
  const ORION = { 'Guides/Orion.md': 'Guides/Orion 2.md' };

  it('never touches a code fence, a code span, or text that only looks like a link', () => {
    const text = ['Real [[Orion]] and `[[Orion]]` and ``a `[[Orion]]` b``.', '', '```md', '[[Orion]]', '[x](../Photos/my image.png)', '```', '', '~~~', '[[Orion]]', '~~~', '', 'After [[Orion]].', '', '[[Orion', 'and Orion alone, [Orion]'].join('\n');
    const expected = text.replace('Real [[Orion]]', 'Real [[Orion 2]]').replace('After [[Orion]]', 'After [[Orion 2]]');
    expect(run(text, ORION)).toEqual({ text: expected, count: 2 });
  });

  it('keeps a fence open to the end of the note when it is never closed', () => {
    expect(run('[[Orion]]\n\n```\n[[Orion]]\n', ORION)).toEqual({ text: '[[Orion 2]]\n\n```\n[[Orion]]\n', count: 1 });
  });

  it('does not take a backtick with no partner for a code span', () => {
    expect(run('A ` tick and [[Orion]].', ORION).text).toBe('A ` tick and [[Orion 2]].');
    expect(run('A \\`[[Orion]]\\`.', ORION).count).toBe(1);
  });

  it('changes nothing else: line ends, a byte order mark, and the words around', () => {
    const text = '\uFEFFTitle\r\n\r\nSee [[Orion]]\r\nand more.\r\n';
    expect(run(text, ORION).text).toBe('\uFEFFTitle\r\n\r\nSee [[Orion 2]]\r\nand more.\r\n');
  });

  it('follows a link in the frontmatter too, as Obsidian does', () => {
    expect(run('---\nup: "[[Orion]]"\n---\nBody\n', ORION).text).toBe('---\nup: "[[Orion 2]]"\n---\nBody\n');
  });

  it('is quick to say no: text without [[ or ]( has no links', () => {
    expect(mayHaveLinks('plain')).toBe(false);
    expect(mayHaveLinks('a [[b]]')).toBe(true);
    expect(mayHaveLinks('a [b](c)')).toBe(true);
  });
});

describe('updateLinks: markdown links', () => {
  const IMAGE = { 'Photos/Winter hexagon.png': 'Photos/Hexagon.png' };

  it('follows a renamed file, keeping the text, the title and the #fragment', () => {
    expect(rename('![Hex](../Photos/Winter%20hexagon.png)', IMAGE)).toBe('![Hex](../Photos/Hexagon.png)');
    expect(rename('[a](../Photos/Winter%20hexagon.png "A title")', IMAGE)).toBe('[a](../Photos/Hexagon.png "A title")');
    expect(rename("[a](<../Photos/Winter hexagon.png> 'T')", IMAGE)).toBe("[a](<../Photos/Hexagon.png> 'T')");
    expect(rename('[a](../Photos/Winter%20hexagon.png#frag)', IMAGE)).toBe('[a](../Photos/Hexagon.png#frag)');
  });

  it('keeps the way spaces were written: <…>, %20, or none', () => {
    expect(rename('![](<../Photos/my image.png>)', { 'Photos/my image.png': 'Photos/your image.png' })).toBe('![](<../Photos/your image.png>)');
    expect(rename('![](../Photos/my%20image.png)', { 'Photos/my image.png': 'Photos/your image.png' })).toBe('![](../Photos/your%20image.png)');
    // Written without spaces, a name that now has them needs the angle brackets.
    expect(rename('![](../Photos/Winter%20hexagon.png)', { 'Photos/Winter hexagon.png': 'Photos/Winter.png' })).toBe('![](../Photos/Winter.png)');
    expect(rename('![](../Photos/x.png)', { 'Photos/x.png': 'Photos/a b.png' }, 'Guides/Observing plan.md', [...FILES, 'Photos/x.png'])).toBe('![](<../Photos/a b.png>)');
  });

  it('follows a file moved to another folder, relative to the note', () => {
    expect(rename('![](../Photos/Winter%20hexagon.png)', { 'Photos/Winter hexagon.png': 'Gallery/Winter hexagon.png' })).toBe('![](../Gallery/Winter%20hexagon.png)');
    expect(rename('![](/Photos/Winter%20hexagon.png)', { 'Photos/Winter hexagon.png': 'Gallery/Winter hexagon.png' })).toBe('![](/Gallery/Winter%20hexagon.png)');
    expect(rename('[a](./Orion.md)', { 'Guides/Orion.md': 'Guides/Deep/Orion.md' })).toBe('[a](./Deep/Orion.md)');
  });

  it('leaves a link to the web, to an anchor, to nothing, and an unchanged one', () => {
    const text = '[w](https://example.com/x.png) [m](mailto:a@b.c) [h](#heading) [n](Nope.md) ![](../Photos/Winter%20hexagon.png)';
    expect(run(text, { 'Guides/Orion.md': 'Guides/Orion 2.md' })).toEqual({ text, count: 0 });
  });

  it('keeps a moved note’s own relative links pointing at what they pointed at', () => {
    // The note moves up out of Guides: ../Photos/… becomes Photos/…, and [[Orion]] still reaches the same Orion.
    expect(run('![](../Photos/Winter%20hexagon.png) and [[Orion]]', { 'Guides/Observing plan.md': 'Observing plan.md' })).toEqual({
      text: '![](Photos/Winter%20hexagon.png) and [[Orion]]',
      count: 1,
    });
  });

  it('a moved note’s bare names are checked from where it is now', () => {
    // Into Misc, [[Orion]] would reach Misc's own Orion, not the one it meant: the path says which.
    expect(run('![](../Photos/Winter%20hexagon.png) and [[Orion]]', { 'Guides/Observing plan.md': 'Misc/Observing plan.md' })).toEqual({
      text: '![](../Photos/Winter%20hexagon.png) and [[Guides/Orion]]',
      count: 1,
    });
  });

  it('updates an image inside a link, both', () => {
    expect(rename('[![a](../Photos/Winter%20hexagon.png)](Orion.md)', { ...IMAGE, 'Guides/Orion.md': 'Guides/Orion 2.md' })).toBe('[![a](../Photos/Hexagon.png)](<Orion 2.md>)');
  });

  it('does not take ordinary parentheses for a link', () => {
    expect(run('Orion (M42) and [[Orion]] (the hunter)', { 'Guides/Orion.md': 'Guides/Orion 2.md' }).text).toBe('Orion (M42) and [[Orion 2]] (the hunter)');
  });
});

describe('updateLinks: a whole move', () => {
  const files = ['Index.md', 'Stars/Rigel.md', 'Stars/Sirius.md', 'Stars/deep/Vega.md'];

  it('a folder moved deeper costs nothing: a path matches the end of a file’s path', () => {
    const text = '[[Rigel]] [[Stars/Sirius]] [[Vega]] [[deep/Vega]]';
    expect(run(text, { Stars: 'Sky/Stars' }, 'Index.md', files)).toEqual({ text, count: 0 });
  });

  it('a folder renamed takes every file in it, and only the links that named the old folder change', () => {
    const text = '[[Rigel]] [[Stars/Sirius]] [[Vega]] [[deep/Vega]] [[Stars/deep/Vega|v]]';
    expect(run(text, { Stars: 'Planets' }, 'Index.md', files)).toEqual({ text: '[[Rigel]] [[Planets/Sirius]] [[Vega]] [[deep/Vega]] [[Planets/deep/Vega|v]]', count: 2 });
  });

  it('a note inside the renamed folder keeps its sibling links, and writes nothing for them', () => {
    expect(run('[[Sirius]] and ![](deep/../Sirius.md)', { Stars: 'Planets' }, 'Stars/Rigel.md', files)).toEqual({ text: '[[Sirius]] and ![](deep/../Sirius.md)', count: 0 });
  });
});

describe('updateCanvasLinks: the Embedded Files lines of a canvas', () => {
  const CANVAS = 'Sketches/Map.excalidraw.md';
  const IMAGES = ['Photos/Sky.png', 'Photos/Moon.png', 'Other/Moon 2.png', 'Notes/Orion.md', CANVAS];

  /** A drawing with a text element that holds a link of its own, and these Embedded Files lines. */
  function canvas(lines: string[], { crlf = false, compressed = true }: { crlf?: boolean; compressed?: boolean } = {}): string {
    const scene = {
      type: 'excalidraw' as const,
      version: 2,
      source: 'test',
      elements: [{ id: 'abcd1234', type: 'text', x: 0, y: 0, width: 50, height: 20, text: 'See [[Orion]]', originalText: 'See [[Orion]]', link: '[[Orion]]' }],
      appState: {},
      files: {},
    };
    const text = toObsidianExcalidrawMarkdown(scene, { compressed, embedded: { add: lines.map((line, at) => [`id${at + 1}`, line] as const) } });
    return crlf ? text.replace(/\n/g, '\r\n') : text;
  }

  const update = (text: string, moves: Record<string, string>, files = IMAGES) => {
    const { world, at } = moveWorld(files, moves);
    return updateCanvasLinks(text, CANVAS, at(CANVAS), world);
  };
  const links = (text: string) => embeddedFiles(text).map((file) => file.link);

  it('follows a renamed image, a bare name staying bare while it names the file alone', () => {
    const before = canvas(['Sky.png']);
    const result = update(before, { 'Photos/Sky.png': 'Photos/Clouds.png' });
    expect(result.count).toBe(1);
    expect(links(result.text)).toEqual(['Clouds.png']);
  });

  it('writes the shortest path that names the file alone when the bare name would be ambiguous', () => {
    const result = update(canvas(['Moon.png']), { 'Photos/Moon.png': 'Photos/Moon 2.png' });
    expect(links(result.text)).toEqual(['Photos/Moon 2.png']);
  });

  it('keeps the alias, the size and the `#…` after the name', () => {
    const before = canvas(['Sky.png|100%', 'Sky.png#page=2', 'Sky.png#page=2|50']);
    const result = update(before, { 'Photos/Sky.png': 'Photos/Clouds.png' });
    expect(result.count).toBe(3);
    expect(links(result.text)).toEqual(['Clouds.png|100%', 'Clouds.png#page=2', 'Clouds.png#page=2|50']);
  });

  it('leaves a line that still finds its file, as written', () => {
    const before = canvas(['Sky.png', 'Photos/Moon.png']);
    // Sky.png moves to another folder and is still the only Sky.png; Photos/Moon.png is a path, which a folder move follows.
    const moved = update(before, { 'Photos/Sky.png': 'Gallery/Sky.png' });
    expect(moved).toEqual({ text: before, count: 0 });
    expect(update(before, { 'Notes/Orion.md': 'Notes/Hunter.md' })).toEqual({ text: before, count: 0 });
  });

  it('follows a folder that was renamed, a line written as a path following it', () => {
    const result = update(canvas(['Photos/Sky.png']), { Photos: 'Pictures' });
    expect(links(result.text)).toEqual(['Pictures/Sky.png']);
  });

  it('changes only the links: the drawing, compressed or not, and every other byte, CRLF included, stay', () => {
    for (const options of [{}, { crlf: true }, { compressed: false }]) {
      const before = canvas(['Sky.png|100%', 'Moon.png'], options);
      const { text, count } = update(before, { 'Photos/Sky.png': 'Photos/Clouds.png' });
      expect(count).toBe(1);
      expect(text).toBe(before.replace('[[Sky.png|100%]]', '[[Clouds.png|100%]]'));
      // The text element's own link, `[[Orion]]`, is the drawing's: a rename of Orion doesn't reach it here.
      expect(readObsidianExcalidrawMarkdown(text).elements[0].link).toBe('[[Orion]]');
    }
  });

  it('checks a canvas that moved itself from its new place, so a bare name that now means another file gets a path', () => {
    // Moon.png resolves to the file nearest the canvas: beside it in Sketches, there is none, so Photos/Moon.png (shallower) wins.
    const files = ['Photos/Moon.png', 'Elsewhere/Deep/Moon.png', CANVAS];
    const { world, at } = moveWorld(files, { [CANVAS]: 'Elsewhere/Deep/Map.excalidraw.md' });
    const result = updateCanvasLinks(canvas(['Moon.png']), CANVAS, at(CANVAS), world);
    expect(links(result.text)).toEqual(['Photos/Moon.png']);
  });

  it('is quick to say no: a text without an Embedded Files section has nothing to rewrite', () => {
    const none = toObsidianExcalidrawMarkdown({ type: 'excalidraw', version: 2, source: 't', elements: [], appState: {}, files: {} });
    expect(update(none, { 'Photos/Sky.png': 'Photos/Clouds.png' })).toEqual({ text: none, count: 0 });
  });
});
