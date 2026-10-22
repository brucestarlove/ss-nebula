import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import type { NebulaExcalidrawDocument } from '../../../nebula/storage/types';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import { conflictCopyName } from './conflictCopy';
import { hasUnsavedChanges, subscribeKeptCopies, type KeptCopy } from './fileSessions';
import { createTextSession } from './textSession';

/**
 * Re-review R1: a change held in a conflict isn't thrown away when its view
 * unmounts. It's written beside the file as '<stem> (conflict <time>)<ext>',
 * and the workspace hears about it.
 */

const NOW = new Date(2026, 9, 22, 11, 40, 12);

function element(id: string, patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike {
  return { id, type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0, version: 1, versionNonce: 1, isDeleted: false, ...patch };
}

function scene(elements: ExcalidrawElementLike[]): ExcalidrawScene {
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: { viewBackgroundColor: 'transparent' }, files: {} };
}

function documentWith(loaded: NebulaExcalidrawDocument, next: ExcalidrawScene): NebulaExcalidrawDocument {
  return { ...loaded, scene: next };
}

describe('conflictCopyName', () => {
  it('names the copy with the local date and a portable time', () => {
    expect(conflictCopyName('Guides/Orion.md', [], NOW)).toBe('Orion (conflict 2026-10-22 11.40).md');
  });

  it('keeps a double extension whole', () => {
    expect(conflictCopyName('Orion.excalidraw.md', [], NOW)).toBe('Orion (conflict 2026-10-22 11.40).excalidraw.md');
    expect(conflictCopyName('Orion.excalidraw', [], NOW)).toBe('Orion (conflict 2026-10-22 11.40).excalidraw');
    expect(conflictCopyName('README', [], NOW)).toBe('README (conflict 2026-10-22 11.40)');
  });

  it('pads single digits', () => {
    expect(conflictCopyName('a.txt', [], new Date(2026, 0, 2, 3, 4))).toBe('a (conflict 2026-01-02 03.04).txt');
  });

  it('is unique among the folder’s names', () => {
    expect(conflictCopyName('Orion.md', ['Orion (conflict 2026-10-22 11.40).md'], NOW)).toBe('Orion (conflict 2026-10-22 11.40) 2.md');
  });
});

describe('a change held in a conflict, then its view goes', () => {
  let files: MemoryFileStore;
  let kept: KeptCopy[];
  let stop: () => void;

  beforeEach(() => {
    vi.useFakeTimers({ now: NOW });
    kept = [];
    stop = subscribeKeptCopies((copy) => kept.push(copy));
  });

  afterEach(() => {
    stop();
    vi.useRealTimers();
  });

  describe('note', () => {
    const PATH = 'Guides/Orion.md';

    async function inConflict() {
      files = createMemoryFileStore({ [PATH]: 'v1' });
      const session = createTextSession(files, PATH, { saveDelayMs: 1000, scope: 'night-sky' });
      await session.ready;
      session.edit('my paragraph, typed in this tab');
      await files.write(PATH, 'theirs'); // another tab's save, heard
      await vi.advanceTimersByTimeAsync(0);
      expect(session.getState().conflict).toBe(true);
      return session;
    }

    it('keeps warning before the page closes while the conflict holds the edit', async () => {
      const session = await inConflict();
      await vi.advanceTimersByTimeAsync(5000);
      expect(hasUnsavedChanges()).toBe(true);
      await session.reload();
    });

    it('writes the edit beside the file, leaves theirs alone, and says so', async () => {
      const session = await inConflict();
      await session.dispose();
      expect(files.peek(PATH)).toBe('theirs');
      expect(files.peek('Guides/Orion (conflict 2026-10-22 11.40).md')).toBe('my paragraph, typed in this tab');
      expect(kept).toEqual([{ scope: 'night-sky', path: PATH, copy: 'Guides/Orion (conflict 2026-10-22 11.40).md' }]);
      expect(hasUnsavedChanges()).toBe(false);
    });

    it('keeps the file’s CRLF line ends in the copy', async () => {
      files = createMemoryFileStore({ [PATH]: 'a\r\nb\r\n' });
      const session = createTextSession(files, PATH, { saveDelayMs: 1000, scope: 'night-sky' });
      await session.ready;
      session.edit('a\nmine\n');
      await files.write(PATH, 'x\r\n');
      await vi.advanceTimersByTimeAsync(0);
      await session.dispose();
      expect(files.peek('Guides/Orion (conflict 2026-10-22 11.40).md')).toBe('a\r\nmine\r\n');
    });

    it('writes no copy after Reload', async () => {
      const session = await inConflict();
      await session.reload();
      await session.dispose();
      expect((await files.list()).map((entry) => entry.path)).toEqual(['Guides', PATH]);
      expect(kept).toEqual([]);
    });
  });

  describe('canvas', () => {
    const PATH = 'Sketches/Orion.excalidraw.md';

    async function inConflict() {
      files = createMemoryFileStore({ [PATH]: toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }) });
      const sceneStore = createFileSceneStore({ store: files, path: PATH, intervalMs: 1000, scope: 'night-sky' });
      const loaded = (await sceneStore.load({ boardId: 'p', canvasId: PATH }))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2, x: 222 }), element('mine')])));
      await files.write(PATH, toObsidianExcalidrawMarkdown(scene([element('a', { version: 2, x: 111 }), element('theirs')]), { compressed: true }));
      await vi.advanceTimersByTimeAsync(0);
      expect(sceneStore.getState().conflict).toBe(true);
      return sceneStore;
    }

    it('keeps warning before the page closes while the conflict holds the change', async () => {
      const sceneStore = await inConflict();
      await vi.advanceTimersByTimeAsync(5000);
      expect(hasUnsavedChanges()).toBe(true);
      await sceneStore.reload();
    });

    it('writes the drawing beside the file, as a whole canvas, leaves theirs alone, and says so', async () => {
      const sceneStore = await inConflict();
      await sceneStore.dispose();
      const theirs = readObsidianExcalidrawMarkdown(files.peek(PATH) ?? '');
      expect(theirs.elements.map((item) => [item.id, item.x])).toEqual([
        ['a', 111],
        ['theirs', 10],
      ]);
      const copyPath = 'Sketches/Orion (conflict 2026-10-22 11.40).excalidraw.md';
      const mine = readObsidianExcalidrawMarkdown(files.peek(copyPath) ?? '');
      expect(mine.elements.map((item) => [item.id, item.x])).toEqual([
        ['a', 222],
        ['mine', 10],
      ]);
      expect(kept).toEqual([{ scope: 'night-sky', path: PATH, copy: copyPath }]);
      expect(hasUnsavedChanges()).toBe(false);
    });

    it('writes an .excalidraw copy as Excalidraw’s JSON', async () => {
      const path = 'Orion.excalidraw';
      files = createMemoryFileStore({ [path]: JSON.stringify(scene([element('a')])) });
      const sceneStore = createFileSceneStore({ store: files, path, intervalMs: 1000, scope: 'night-sky' });
      const loaded = (await sceneStore.load({ boardId: 'p', canvasId: path }))!;
      await sceneStore.save(loaded);
      await sceneStore.save(documentWith(loaded, scene([element('a', { version: 2, x: 222 })])));
      await files.write(path, JSON.stringify(scene([element('a', { version: 2, x: 111 })])));
      await vi.advanceTimersByTimeAsync(0);
      await sceneStore.dispose();
      const copy = JSON.parse(files.peek('Orion (conflict 2026-10-22 11.40).excalidraw') ?? 'null') as ExcalidrawScene;
      expect(copy).toMatchObject({ type: 'excalidraw', elements: [{ id: 'a', x: 222 }] });
    });

    it('writes no copy after Reload', async () => {
      const sceneStore = await inConflict();
      await sceneStore.reload();
      await sceneStore.dispose();
      expect((await files.list()).map((entry) => entry.path)).toEqual(['Sketches', PATH]);
      expect(kept).toEqual([]);
    });
  });
});
