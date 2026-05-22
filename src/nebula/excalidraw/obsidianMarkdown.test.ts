import { describe, expect, it } from 'vitest';

import {
  getObsidianExcalidrawInteropFilename,
  getObsidianTextElementsSection,
  isObsidianExcalidrawMarkdown,
  readObsidianExcalidrawMarkdown,
  toObsidianExcalidrawMarkdown,
} from './obsidianMarkdown';
import type { ExcalidrawScene } from './scene';

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
