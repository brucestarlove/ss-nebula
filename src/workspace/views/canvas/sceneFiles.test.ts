import { describe, expect, it } from 'vitest';
import { createMemoryFileStore } from '../../../../e2e/harness/views-store';
import { readObsidianExcalidrawMarkdown, toObsidianExcalidrawMarkdown } from '../../../nebula/excalidraw/obsidianMarkdown';
import type { ExcalidrawElementLike, ExcalidrawScene } from '../../../nebula/excalidraw/scene';
import { createFileSceneStore } from './fileSceneStore';
import { withoutRemoteFiles } from './sceneFiles';

/**
 * Re-review R2: a canvas can't make the browser fetch a third-party image.
 * Every scene read from a file reaches Excalidraw with only `data:` images;
 * the element stays, so Excalidraw shows it as a missing image.
 */

const TRACKER = 'https://tracker.example/p.png?u=1';
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

function image(id: string, fileId: string, patch: Partial<ExcalidrawElementLike> = {}): ExcalidrawElementLike {
  return { id, type: 'image', fileId, status: 'saved', x: 0, y: 0, width: 10, height: 10, angle: 0, version: 1, versionNonce: 1, isDeleted: false, ...patch };
}

function crafted(): ExcalidrawScene {
  return {
    type: 'excalidraw',
    version: 2,
    source: 'test',
    elements: [image('remote', 'f-remote'), image('local', 'f-local'), image('odd', 'f-odd'), image('blank', 'f-blank')],
    appState: { viewBackgroundColor: '#ffffff' },
    files: {
      'f-remote': { id: 'f-remote', mimeType: 'image/png', dataURL: TRACKER, created: 1 },
      'f-local': { id: 'f-local', mimeType: 'image/png', dataURL: PIXEL, created: 1 },
      'f-odd': { id: 'f-odd', mimeType: 'image/png', dataURL: '//tracker.example/p.png', created: 1 },
      'f-blank': { id: 'f-blank', mimeType: 'image/png', created: 1 },
    },
  };
}

describe('withoutRemoteFiles', () => {
  it('keeps only images whose data is a data: URL, and every element', () => {
    const { scene, held } = withoutRemoteFiles(crafted());
    expect(Object.keys(scene.files ?? {})).toEqual(['f-local']);
    expect(scene.elements.map((element) => element.id)).toEqual(['remote', 'local', 'odd', 'blank']);
    expect(Object.keys(held).sort()).toEqual(['f-blank', 'f-odd', 'f-remote']);
  });
});

describe('a canvas file with a web image', () => {
  async function opened(path: string, text: string) {
    const files = createMemoryFileStore({ [path]: text });
    const sceneStore = createFileSceneStore({ store: files, path, intervalMs: 5 });
    const loaded = (await sceneStore.load({ boardId: 'p', canvasId: path }))!;
    return { files, sceneStore, loaded };
  }

  it('opens an .excalidraw without it, and with its element', async () => {
    const { loaded, sceneStore } = await opened('Trap.excalidraw', JSON.stringify(crafted()));
    expect(Object.keys(loaded.scene.files ?? {})).toEqual(['f-local']);
    expect(loaded.scene.elements.map((element) => element.id)).toEqual(['remote', 'local', 'odd', 'blank']);
    await sceneStore.dispose();
  });

  it('opens an .excalidraw.md without it', async () => {
    const { loaded, sceneStore } = await opened('Trap.excalidraw.md', toObsidianExcalidrawMarkdown(crafted(), { compressed: true }));
    expect(JSON.stringify(loaded.scene)).not.toContain('tracker.example');
    expect(loaded.scene.elements).toHaveLength(4);
    await sceneStore.dispose();
  });

  it('reloads a change made elsewhere without it', async () => {
    const plain: ExcalidrawScene = { ...crafted(), elements: [image('local', 'f-local')], files: { 'f-local': crafted().files!['f-local'] } };
    const { files, sceneStore } = await opened('Trap.excalidraw', JSON.stringify(plain));
    await files.write('Trap.excalidraw', JSON.stringify(crafted()));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(sceneStore.getState().revision).toBe(1);
    const reloaded = (await sceneStore.load({ boardId: 'p', canvasId: 'Trap.excalidraw' }))!;
    expect(JSON.stringify(reloaded.scene)).not.toContain('tracker.example');
    await sceneStore.dispose();
  });

  it('keeps what the file held when it saves an edit: nothing of the file is lost', async () => {
    const { files, sceneStore, loaded } = await opened('Trap.excalidraw', JSON.stringify(crafted()));
    await sceneStore.save(loaded);
    const moved = { ...loaded.scene, elements: loaded.scene.elements.map((element) => (element.id === 'local' ? { ...element, x: 50, version: 2 } : element)) };
    await sceneStore.save({ ...loaded, scene: moved });
    await sceneStore.flush();
    const written = JSON.parse(files.peek('Trap.excalidraw') ?? '{}') as ExcalidrawScene;
    expect(written.elements.find((element) => element.id === 'local')?.x).toBe(50);
    expect(written.files?.['f-remote']).toMatchObject({ dataURL: TRACKER });
    expect(Object.keys(written.files ?? {}).sort()).toEqual(['f-blank', 'f-local', 'f-odd', 'f-remote']);
    await sceneStore.dispose();
  });

  it('keeps it in an .excalidraw.md too', async () => {
    const { files, sceneStore, loaded } = await opened('Trap.excalidraw.md', toObsidianExcalidrawMarkdown(crafted(), { compressed: true }));
    await sceneStore.save(loaded);
    await sceneStore.save({ ...loaded, scene: { ...loaded.scene, elements: [...loaded.scene.elements, image('new', 'f-local', { x: 99 })] } });
    await sceneStore.flush();
    const written = readObsidianExcalidrawMarkdown(files.peek('Trap.excalidraw.md') ?? '');
    expect(written.elements).toHaveLength(5);
    expect(written.files?.['f-remote']).toMatchObject({ dataURL: TRACKER });
    await sceneStore.dispose();
  });
});
