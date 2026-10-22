import { describe, expect, it } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import type { FileStore } from '../../../files/types';
import { createFileSceneStore } from '../canvas/fileSceneStore';
import { createTextSession } from './textSession';

/**
 * Re-review R8: flush() settles only once the session's writes stop
 * changing, so a write aimed again after a rename has landed too.
 */

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Another tab's view of the disk: this tab's writes take `ms` to land, and
 * the other tab's rename can't wait for them. */
function crossTabSlowWrites(inner: MemoryFileStore, ms: number): FileStore {
  const slow: FileStore = Object.create(inner) as FileStore;
  slow.write = async (path, data) => {
    await wait(ms);
    return inner.write(path, data);
  };
  slow.watch = (listener) => inner.watch(listener);
  slow.readText = (path) => inner.readText(path);
  slow.readBlob = (path) => inner.readBlob(path);
  slow.stat = (path) => inner.stat(path);
  slow.list = () => inner.list();
  slow.rename = (from, to) => inner.rename(from, to);
  slow.remove = (path) => inner.remove(path);
  return slow;
}

function element(id: string, patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike {
  return { id, type: 'rectangle', x: 10, y: 20, width: 100, height: 50, angle: 0, version: 1, versionNonce: 1, isDeleted: false, ...patch };
}

function scene(elements: ExcalidrawElementLike[]): ExcalidrawScene {
  return { type: 'excalidraw', version: 2, source: 'test', elements, appState: {}, files: {} };
}

describe('flush() after a rename elsewhere during a write', () => {
  it('canvas: settles once the change is at the new path', async () => {
    const inner = createMemoryFileStore({ 'c.excalidraw.md': toObsidianExcalidrawMarkdown(scene([element('a')]), { compressed: true }) });
    const sceneStore = createFileSceneStore({ store: crossTabSlowWrites(inner, 30), path: 'c.excalidraw.md', intervalMs: 5 });
    const loaded = (await sceneStore.load({ boardId: 'p', canvasId: 'c' }))!;
    await sceneStore.save(loaded);
    await sceneStore.save({ ...loaded, scene: scene([element('a', { version: 2, x: 777 })]) });
    await wait(10); // the write is on its way
    await inner.rename('c.excalidraw.md', 'renamed.excalidraw.md');
    await sceneStore.flush();
    expect(readObsidianExcalidrawMarkdown(inner.peek('renamed.excalidraw.md') ?? '').elements[0].x).toBe(777);
    await sceneStore.dispose();
  });

  it('note: settles once the edit is at the new path', async () => {
    const inner = createMemoryFileStore({ 'n.md': 'v1' });
    const session = createTextSession(crossTabSlowWrites(inner, 30), 'n.md', { saveDelayMs: 5 });
    await session.ready;
    session.edit('mine');
    await wait(10); // the write is on its way
    await inner.rename('n.md', 'renamed.md');
    await session.flush();
    expect(inner.peek('renamed.md')).toBe('mine');
    await session.dispose();
  });

  it('note: settles once the edit is at the new path when the rename comes while it looks at the file', async () => {
    const inner = createMemoryFileStore({ 'n.md': 'v1' });
    const store = crossTabSlowWrites(inner, 0);
    const session = createTextSession(store, 'n.md', { saveDelayMs: 1000 });
    await session.ready;
    // The look at the file takes a while to come back.
    store.stat = async (path) => {
      const entry = await inner.stat(path);
      await wait(30);
      return entry;
    };
    session.edit('mine');
    const flushed = session.flush();
    await wait(10); // looking at the file before writing
    await inner.rename('n.md', 'renamed.md');
    await flushed;
    expect(inner.peek('renamed.md')).toBe('mine');
    await session.dispose();
  });
});
