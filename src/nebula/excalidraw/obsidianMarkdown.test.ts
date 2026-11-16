import { describe, expect, it } from 'vitest';

import {
  getObsidianExcalidrawInteropFilename,
  getObsidianTextElementsSection,
  isObsidianExcalidrawFile,
  isObsidianExcalidrawMarkdown,
  readObsidianExcalidrawMarkdown,
  toObsidianExcalidrawMarkdown,
  updateObsidianExcalidrawMarkdown,
} from './obsidianMarkdown';
import type { ExcalidrawScene } from './scene';
import gardenPlan from '../../files/fixtures/obsidian/Edraw - Garden plan.md?raw';
import recipeCards from '../../files/fixtures/obsidian/Edraw - Recipe cards.md?raw';
import busTimetable from '../../files/fixtures/obsidian/Edraw - Bus timetable.md?raw';

const scene: ExcalidrawScene = {
  type: 'excalidraw',
  version: 2,
  source: 'vitest',
  elements: [
    {
      id: 'text-1',
      type: 'text',
      x: 10,
      y: 20,
      width: 180,
      height: 40,
      text: 'Mission note',
      originalText: 'Mission note',
    },
    {
      id: 'rect-1',
      type: 'rectangle',
      x: 30,
      y: 80,
      width: 120,
      height: 90,
    },
  ],
  appState: { viewBackgroundColor: '#ffffff' },
  files: {},
};

describe('Obsidian Excalidraw markdown interop', () => {
  it('round-trips compressed Obsidian Excalidraw markdown drawing sections', () => {
    const markdown = toObsidianExcalidrawMarkdown(scene);

    expect(isObsidianExcalidrawMarkdown(markdown)).toBe(true);
    expect(markdown).toContain('excalidraw-plugin: parsed');
    expect(markdown).toContain('# Excalidraw Data');
    expect(markdown).toContain('## Text Elements');
    expect(markdown).toContain('Mission note ^text-1');
    expect(markdown).toContain('\n%%\n## Drawing\n```compressed-json');
    const parsed = readObsidianExcalidrawMarkdown(markdown);
    expect(parsed).toMatchObject({
      type: 'excalidraw',
      version: 2,
      source: 'vitest',
      elements: expect.arrayContaining([
        expect.objectContaining({ id: 'text-1', type: 'text', text: 'Mission note', boundElements: [] }),
        expect.objectContaining({ id: 'rect-1', type: 'rectangle', boundElements: [] }),
      ]),
      appState: expect.objectContaining(scene.appState),
      files: {},
    });
    expect(parsed.appState).toEqual(
      expect.objectContaining({
        theme: 'light',
        zoom: { value: 1 },
      }),
    );
    // Excalidraw expects appState.collaborators to be a Map and defaults it
    // itself; a serialized array/object value is what triggers the Obsidian
    // plugin's `collaborators.forEach` crash on import, so it must be absent.
    expect(parsed.appState).not.toHaveProperty('collaborators');
  });

  it('drops Excalidraw runtime-only appState keys that genuine Obsidian files never contain', () => {
    const markdown = toObsidianExcalidrawMarkdown({
      ...scene,
      appState: {
        viewBackgroundColor: '#ffffff',
        // Ephemeral runtime fields Excalidraw's live appState carries but that
        // no genuine plugin-authored file persists.
        collaborators: {},
        selectedElementIds: { 'rect-1': true },
        editingGroupId: 'group-9',
        draggingElement: { id: 'x' },
        cursorButton: 'down',
      },
    });

    const { appState } = readObsidianExcalidrawMarkdown(markdown);
    expect(appState).not.toHaveProperty('collaborators');
    expect(appState).not.toHaveProperty('selectedElementIds');
    expect(appState).not.toHaveProperty('editingGroupId');
    expect(appState).not.toHaveProperty('draggingElement');
    expect(appState).not.toHaveProperty('cursorButton');
  });

  it("replaces Nebula's transparent canvas background with a solid color for Obsidian", () => {
    const markdown = toObsidianExcalidrawMarkdown({
      ...scene,
      appState: { viewBackgroundColor: 'transparent' },
    });

    const { appState } = readObsidianExcalidrawMarkdown(markdown);
    expect(appState?.viewBackgroundColor).toBe('#ffffff');
  });

  it("exports the light theme so Excalidraw's dark invert filter does not blacken the canvas", () => {
    const markdown = toObsidianExcalidrawMarkdown({
      ...scene,
      appState: { theme: 'dark', viewBackgroundColor: 'transparent' },
    });

    const { appState } = readObsidianExcalidrawMarkdown(markdown);
    expect(appState?.theme).toBe('light');
    expect(appState?.viewBackgroundColor).toBe('#ffffff');
  });

  it('reads uncompressed json drawing sections from markdown files', () => {
    const markdown = toObsidianExcalidrawMarkdown(scene, { compressed: false });

    expect(readObsidianExcalidrawMarkdown(markdown).elements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'text-1', type: 'text' }),
        expect.objectContaining({ id: 'rect-1', type: 'rectangle' }),
      ]),
    );
  });

  it('sanitizes Obsidian markdown export filenames', () => {
    expect(getObsidianExcalidrawInteropFilename('Ss Nebula / Missions', 'board:id', 'main canvas')).toBe(
      'Ss-Nebula-Missions-main-canvas.excalidraw.md',
    );
  });

  it('omits empty text elements from the readable text section', () => {
    expect(
      getObsidianTextElementsSection({
        ...scene,
        elements: [
          { id: 'blank', type: 'text', x: 0, y: 0, width: 10, height: 10, text: '' },
          { id: 'note', type: 'text', x: 0, y: 0, width: 10, height: 10, rawText: 'Raw note' },
        ],
      }),
    ).toBe('Raw note ^note');
  });

  it('normalizes nullable Excalidraw runtime element collections for Obsidian plugin restore', () => {
    const markdown = toObsidianExcalidrawMarkdown({
      ...scene,
      elements: [
        {
          id: 'runtime-text',
          type: 'text',
          x: 0,
          y: 0,
          width: 100,
          height: 25,
          text: 'Runtime text',
          boundElements: null,
        },
      ],
    });

    const [element] = readObsidianExcalidrawMarkdown(markdown).elements;
    expect(element).toEqual(
      expect.objectContaining({
        groupIds: [],
        boundElements: [],
        frameId: null,
        link: null,
        locked: false,
        containerId: null,
        originalText: 'Runtime text',
        lineHeight: 1.25,
      }),
    );
  });
});

function textElement(id: string, text: string, extra: Record<string, unknown> = {}): ExcalidrawScene['elements'][number] {
  return { id, type: 'text', x: 0, y: 0, width: 100, height: 25, text, originalText: text, ...extra };
}

/** A scene as Nebula's canvas would hand it back after an edit: one shape moved, one text changed. */
function edited(original: ExcalidrawScene): { scene: ExcalidrawScene; movedId: string; textId: string } {
  const moved = original.elements.find((element) => element.type !== 'text' && !element.isDeleted) ?? original.elements[0];
  const text = original.elements.find((element) => element.type === 'text' && !element.isDeleted) as ExcalidrawScene['elements'][number];
  const elements = original.elements.map((element) => {
    let next = element;
    if (element.id === moved.id) next = { ...next, x: (element.x as number) + 10 };
    if (element.id === text.id) next = { ...next, text: 'Changed in Nebula', originalText: 'Changed in Nebula', rawText: 'Changed in Nebula' };
    return next;
  });
  return { scene: { ...original, elements }, movedId: moved.id, textId: text.id };
}

/** The text from a line that starts with `heading` up to the line that starts with `until`. */
function section(text: string, heading: string, until: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  const end = text.indexOf(`\n${until}`, start + 1);
  expect(start, heading).toBeGreaterThan(-1);
  expect(end, until).toBeGreaterThan(start);
  return text.slice(start, end);
}

/** What the plugin itself does to find the drawing (2.27.3, main.js:
 * getDecompressedScene): the first `## Drawing` heading followed by a
 * compressed-json fence. */
function pluginReads(markdown: string): string | undefined {
  return /(\n##? Drawing\n[^`]*(?:```compressed-json\n))([\s\S]*?)(```\n)/gm.exec(markdown)?.[2];
}

describe('a drawing quoted inside a text element', () => {
  const thirty: ExcalidrawScene = {
    ...scene,
    elements: Array.from({ length: 30 }, (_, index) => ({ id: `rect-${index}`, type: 'rectangle', x: index * 10, y: 0, width: 5, height: 5 })),
  };
  const pasted = toObsidianExcalidrawMarkdown({ ...scene, elements: [] });
  const pastedDrawing = pasted.slice(pasted.indexOf('## Drawing\n'), pasted.lastIndexOf('```') + 3);

  it('reads the drawing after the last ## Drawing heading, not one pasted into a text element', () => {
    const real = toObsidianExcalidrawMarkdown(thirty);
    // The plugin writes text elements as they are, so a pasted drawing sits in Text Elements, ahead of the real one.
    const markdown = real.replace('## Text Elements\n', `## Text Elements\n${pastedDrawing} ^abcdefgh\n\n`);
    expect(markdown.indexOf(pastedDrawing)).toBeLessThan(markdown.lastIndexOf('## Drawing'));
    expect(readObsidianExcalidrawMarkdown(markdown).elements).toHaveLength(30);
  });

  it('is not stopped by a pasted fence whose payload does not decode', () => {
    const real = toObsidianExcalidrawMarkdown(thirty);
    const markdown = real.replace('## Text Elements\n', '## Text Elements\n## Drawing\n```compressed-json\nnot base64 at all!\n``` ^abcdefgh\n\n');
    expect(readObsidianExcalidrawMarkdown(markdown).elements).toHaveLength(30);
  });

  it('fails that file alone, with the reason, when its own drawing does not decode', () => {
    const real = toObsidianExcalidrawMarkdown(thirty);
    const broken = real.replace(/```compressed-json\n[\s\S]*?\n```/, '```compressed-json\n!!!!\n```');
    expect(() => readObsidianExcalidrawMarkdown(broken)).toThrow(/Could not decompress/);
  });

  it('writes fences and section headings inside text elements so that no reader mistakes them', () => {
    const quoted = '## Drawing\n```compressed-json\nabc\n```\n   ~~~ tilde fence\n# Excalidraw Data\n## Embedded Files\n## Element Links\nfine: `inline` and ```mid-line```';
    const markdown = toObsidianExcalidrawMarkdown({ ...thirty, elements: [...thirty.elements, textElement('abcdefgh', quoted)] });
    const textSection = markdown.slice(markdown.indexOf('## Text Elements\n') + '## Text Elements\n'.length, markdown.lastIndexOf('%%\n## Drawing'));

    expect(textSection.split('\n').filter((line) => /^ {0,3}(```|~~~)/.test(line) || /^ {0,3}#{1,2} (Drawing|Excalidraw Data|Text Elements|Element Links|Embedded Files)\s*$/.test(line))).toEqual([]);
    expect(textSection).toContain('fine: `inline` and ```mid-line``` ^abcdefgh');
    // The drawing itself keeps the text exactly; only the readable copy is changed.
    expect(readObsidianExcalidrawMarkdown(markdown).elements.at(-1)?.text).toBe(quoted);
    // And the plugin's own first-match reader finds the real drawing.
    expect(pluginReads(markdown)).toBe(markdown.slice(markdown.lastIndexOf('```compressed-json\n') + '```compressed-json\n'.length, markdown.lastIndexOf('\n```') + 1));
    expect(updateObsidianExcalidrawMarkdown(markdown, { ...thirty, elements: [...thirty.elements, textElement('abcdefgh', quoted)] })).toBe(markdown);
  });

  it('leaves a text element’s readable copy alone when nothing in it could be mistaken', () => {
    const plain = 'Line one\n  ## a heading of its own\n``code`` and `x`';
    const markdown = toObsidianExcalidrawMarkdown({ ...scene, elements: [textElement('abcdefgh', plain)] });
    expect(markdown).toContain(`## Text Elements\n${plain} ^abcdefgh\n\n%%`);
  });
});

describe('updateObsidianExcalidrawMarkdown', () => {
  const fixtures: Array<[string, string]> = [
    ['Edraw - Garden plan.md', gardenPlan],
    ['Edraw - Recipe cards.md', recipeCards],
    ['Edraw - Bus timetable.md', busTimetable],
  ];

  for (const [name, original] of fixtures) {
    it(`keeps everything outside Text Elements and Drawing in a real plugin file (${name})`, () => {
      const { scene: changed, movedId, textId } = edited(readObsidianExcalidrawMarkdown(original));
      const updated = updateObsidianExcalidrawMarkdown(original, changed);

      const header = original.slice(0, original.indexOf('## Text Elements\n') + '## Text Elements\n'.length);
      expect(updated.startsWith(header)).toBe(true);
      expect(updated.slice(updated.lastIndexOf('```') + 3)).toBe(original.slice(original.lastIndexOf('```') + 3));
      expect(updated).toContain(`Changed in Nebula ^${textId}\n`);
      expect(isObsidianExcalidrawFile(updated)).toBe(true);

      const back = readObsidianExcalidrawMarkdown(updated);
      expect(back.elements.map((element) => element.id)).toEqual(changed.elements.map((element) => element.id));
      expect(back.elements.find((element) => element.id === movedId)?.x).toBe((changed.elements.find((element) => element.id === movedId)?.x as number));
      expect(back.elements.find((element) => element.id === textId)?.text).toBe('Changed in Nebula');
    });
  }

  it('keeps the Embedded Files section of a real drawing that holds images, byte for byte', () => {
    const { scene: changed } = edited(readObsidianExcalidrawMarkdown(gardenPlan));
    const updated = updateObsidianExcalidrawMarkdown(gardenPlan, changed);
    expect(section(updated, '## Embedded Files', '%%\n## Drawing')).toBe(section(gardenPlan, '## Embedded Files', '%%\n## Drawing'));
    // 62 image files behind the drawing's 63 image elements.
    expect(section(updated, '## Embedded Files', '%%\n## Drawing').match(/: \[\[/g)).toHaveLength(62);
  });

  it('keeps extra frontmatter, back-of-card notes, Element Links, Embedded Files and sections it does not know', () => {
    const drawing = toObsidianExcalidrawMarkdown({ ...scene, elements: [textElement('abcdefgh', 'Hello'), { id: 'ijklmnop', type: 'rectangle', x: 0, y: 0, width: 5, height: 5, link: '[[Some note]]' }] });
    const payload = drawing.slice(drawing.indexOf('## Drawing\n'));
    const original = [
      '---',
      '',
      'excalidraw-plugin: parsed',
      'aliases: [Launch plan]',
      'excalidraw-autoexport: png',
      'tags: [excalidraw]',
      '',
      '---',
      '==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠==',
      '',
      '# Back of the card',
      '',
      'Notes about this drawing, with a [[link]] and a ^block-ref.',
      '',
      '# Excalidraw Data',
      '',
      '## Text Elements',
      'Hello ^abcdefgh',
      '',
      '## Element Links',
      'ijklmnop: [[Some note]]',
      '',
      '## Embedded Files',
      'qrstuvwx: [[Photo.png]]',
      '',
      '## Something newer',
      'kept as it is',
      '',
      `%%\n${payload}`,
    ].join('\n');
    const next: ExcalidrawScene = { ...scene, elements: [textElement('abcdefgh', 'Hello, again'), textElement('yzabcdef', 'New text'), { id: 'ijklmnop', type: 'rectangle', x: 20, y: 0, width: 5, height: 5, link: '[[Some note]]' }] };
    const updated = updateObsidianExcalidrawMarkdown(original, next);

    const keptBefore = original.slice(0, original.indexOf('## Text Elements\n') + '## Text Elements\n'.length);
    const keptAfter = original.slice(original.indexOf('## Element Links\n'), original.indexOf('%%\n## Drawing'));
    expect(updated).toBe(`${keptBefore}Hello, again ^abcdefgh\n\nNew text ^yzabcdef\n\n${keptAfter}%%\n${toObsidianExcalidrawMarkdown(next).slice(toObsidianExcalidrawMarkdown(next).indexOf('## Drawing\n'))}`);
    expect(readObsidianExcalidrawMarkdown(updated).elements.map((element) => element.x)).toEqual([0, 0, 20]);
  });

  it('keeps a data section commented out from the top, as the plugin can write it', () => {
    const fresh = toObsidianExcalidrawMarkdown({ ...scene, elements: [textElement('abcdefgh', 'Hello')] });
    const original = fresh.replace('\n# Excalidraw Data\n', '\n%%\n# Excalidraw Data\n').replace('%%\n## Drawing\n', '## Drawing\n');
    const updated = updateObsidianExcalidrawMarkdown(original, { ...scene, elements: [textElement('abcdefgh', 'Bye')] });
    expect(updated).toContain('\n%%\n# Excalidraw Data\n\n## Text Elements\nBye ^abcdefgh\n\n## Drawing\n```compressed-json\n');
    expect(updated.match(/^%%$/gm)).toHaveLength(2);
    expect(readObsidianExcalidrawMarkdown(updated).elements[0].text).toBe('Bye');
  });

  it('gives exactly what a fresh write gives, for a file Nebula wrote', () => {
    const next: ExcalidrawScene = { ...scene, elements: [...scene.elements, textElement('text-2', 'Second note')] };
    expect(updateObsidianExcalidrawMarkdown(toObsidianExcalidrawMarkdown(scene), next)).toBe(toObsidianExcalidrawMarkdown(next));
    expect(updateObsidianExcalidrawMarkdown(toObsidianExcalidrawMarkdown(scene), { ...scene, elements: [] })).toBe(toObsidianExcalidrawMarkdown({ ...scene, elements: [] }));
  });

  it('keeps an uncompressed drawing uncompressed, unless asked', () => {
    const original = toObsidianExcalidrawMarkdown(scene, { compressed: false });
    expect(updateObsidianExcalidrawMarkdown(original, scene)).toBe(original);
    expect(updateObsidianExcalidrawMarkdown(original, scene, { compressed: true })).toBe(toObsidianExcalidrawMarkdown(scene, { compressed: true }));
  });

  it('appends an envelope, and the frontmatter key, to a file that has none', () => {
    expect(updateObsidianExcalidrawMarkdown('', scene)).toBe(toObsidianExcalidrawMarkdown(scene));

    const plain = updateObsidianExcalidrawMarkdown('Notes kept on the back.\n', scene);
    expect(plain.startsWith('---\n\nexcalidraw-plugin: parsed\ntags: [excalidraw]\n\n---\nNotes kept on the back.\n\n# Excalidraw Data\n\n## Text Elements\nMission note ^text-1\n\n%%\n## Drawing\n```compressed-json\n')).toBe(true);
    expect(readObsidianExcalidrawMarkdown(plain).elements.map((element) => element.id)).toEqual(['text-1', 'rect-1']);

    const withFrontmatter = updateObsidianExcalidrawMarkdown('---\ntitle: Plan\nexcalidraw-plugin: false\n---\nNotes\n', scene);
    expect(withFrontmatter.startsWith('---\ntitle: Plan\nexcalidraw-plugin: parsed\n---\nNotes\n\n# Excalidraw Data\n')).toBe(true);
    expect(isObsidianExcalidrawFile(withFrontmatter)).toBe(true);
    expect(isObsidianExcalidrawFile(updateObsidianExcalidrawMarkdown('---\ntitle: Plan\n---\n', scene))).toBe(true);
  });

  it('lists text elements with the plugin’s 8-character ids first, so the plugin reads each back as written', () => {
    // The plugin finds text elements by /\s\^(.{8})\n+/: text under a longer id
    // would be read as part of the next 8-character one.
    expect(
      getObsidianTextElementsSection({
        ...scene,
        elements: [textElement('nebula-made-id-0000000', 'From Nebula'), textElement('abcdefgh', 'From Obsidian'), textElement('gone0000', 'Deleted', { isDeleted: true })],
      }),
    ).toBe('From Obsidian ^abcdefgh\n\nFrom Nebula ^nebula-made-id-0000000');
  });
});

/** The ids of the `## Text Elements` entries, in the file's order. */
function textEntryIds(markdown: string): string[] {
  const drawing = markdown.lastIndexOf('## Drawing');
  return [...markdown.slice(0, drawing).matchAll(/ \^([A-Za-z0-9_-]+)\r?\n/g)].map((match) => match[1]);
}

describe('line ends (re-review R7)', () => {
  const bareLf = (text: string) => (text.match(/(?:^|[^\r])\n/g) ?? []).length;

  it('writes every regenerated section of a CRLF drawing with CRLF (Edraw - Bus timetable.md in CRLF)', () => {
    const crlf = busTimetable.replace(/\n/g, '\r\n');
    expect(bareLf(crlf)).toBe(0);
    const { scene: changed, textId } = edited(readObsidianExcalidrawMarkdown(crlf));
    const multiline = changed.elements.map((element) =>
      element.id === textId ? { ...element, text: 'Changed\nin Nebula', originalText: 'Changed\nin Nebula', rawText: 'Changed\nin Nebula' } : element,
    );
    const updated = updateObsidianExcalidrawMarkdown(crlf, { ...changed, elements: multiline });
    expect(bareLf(updated)).toBe(0);
    expect(updated).toContain(`Changed\r\nin Nebula ^${textId}\r\n`);
    expect(updated.startsWith(crlf.slice(0, crlf.indexOf('## Text Elements\r\n')))).toBe(true);
    const back = readObsidianExcalidrawMarkdown(updated);
    expect(back.elements.map((element) => element.id)).toEqual(changed.elements.map((element) => element.id));
    expect(back.elements.find((element) => element.id === textId)?.text).toBe('Changed\nin Nebula');
  });

  it('keeps CRLF when it adds the drawing, its heading and the frontmatter key to a CRLF file', () => {
    for (const original of ['---\r\ntitle: Plan\r\n---\r\nNotes\r\n', 'Notes kept on the back.\r\n']) {
      const updated = updateObsidianExcalidrawMarkdown(original, scene);
      expect(bareLf(updated), JSON.stringify(original)).toBe(0);
      expect(isObsidianExcalidrawFile(updated)).toBe(true);
      expect(readObsidianExcalidrawMarkdown(updated).elements.map((element) => element.id)).toEqual(['text-1', 'rect-1']);
    }
  });

  it('leaves an LF file, and one with mixed line ends, with LF in what it writes', () => {
    const { scene: changed } = edited(readObsidianExcalidrawMarkdown(busTimetable));
    expect(updateObsidianExcalidrawMarkdown(busTimetable, changed)).not.toContain('\r');
    const mixed = busTimetable.replace('tags: [excalidraw]\n', 'tags: [excalidraw]\r\n');
    expect(bareLf(updateObsidianExcalidrawMarkdown(mixed, changed))).toBeGreaterThan(100);
  });
});

describe('the order of Text Elements (re-review R9)', () => {
  const sceneTextOrder = (value: ExcalidrawScene) =>
    value.elements.filter((element) => element.type === 'text' && !element.isDeleted).map((element) => String(element.id));

  it('keeps the file’s own order through an edit, where it differs from the scene’s (Edraw - Garden plan.md)', () => {
    const original = readObsidianExcalidrawMarkdown(gardenPlan);
    const before = textEntryIds(gardenPlan);
    // The fixture is a useful case: its entries aren't in scene order.
    expect(before).not.toEqual(sceneTextOrder(original));
    expect([...before].sort()).toEqual([...sceneTextOrder(original)].sort());

    const updated = updateObsidianExcalidrawMarkdown(gardenPlan, edited(original).scene);
    expect(textEntryIds(updated)).toEqual(before);
  });

  it('drops a removed text element and adds a new one at the end, keeping the rest where they were', () => {
    const original = readObsidianExcalidrawMarkdown(gardenPlan);
    const before = textEntryIds(gardenPlan);
    const removed = before[3];
    const next: ExcalidrawScene = {
      ...original,
      elements: [textElement('NewText1', 'Planted in Nebula'), ...original.elements.filter((element) => element.id !== removed)],
    };
    const updated = updateObsidianExcalidrawMarkdown(gardenPlan, next);
    expect(textEntryIds(updated)).toEqual([...before.filter((id) => id !== removed), 'NewText1']);
    expect(updated).toContain('Planted in Nebula ^NewText1\n');
  });

  it('still lists a new Nebula id after every 8-character one', () => {
    const original = readObsidianExcalidrawMarkdown(busTimetable);
    const next: ExcalidrawScene = {
      ...original,
      elements: [textElement('nebula-made-id-0000000', 'From Nebula'), ...original.elements, textElement('Added008', 'Added in Nebula')],
    };
    expect(textEntryIds(updateObsidianExcalidrawMarkdown(busTimetable, next))).toEqual([...textEntryIds(busTimetable), 'Added008', 'nebula-made-id-0000000']);
  });
});
