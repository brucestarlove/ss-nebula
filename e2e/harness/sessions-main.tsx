import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { startStarscape } from '@starlove/ui/starscape';
import '../../src/workspace/style';
import { blobToBytes } from '../../src/files/bytes';
import { createOpfsRegistry } from '../../src/files/opfsRegistry';
import type { FileStore } from '../../src/files/types';
import { isObsidianExcalidrawMarkdown, readObsidianExcalidrawMarkdown } from '../../src/nebula/excalidraw/obsidianMarkdown';
import { initBackgroundFromStorage } from '../../src/nebula/ui/useBackground';
import { initMotionFromStorage } from '../../src/nebula/ui/useMotion';
import { initThemeFromStorage, resolveStoredTheme } from '../../src/nebula/ui/useTheme';
import { Workspace, initPreferencesFromStorage } from '../../src/workspace';
import { buildFixtures, PROJECT_ID } from './sessions-files';
import { instrumentStore, type ReadFaults, type StoreCall } from './storeWrappers';

// What main.tsx does before first paint.
initThemeFromStorage();
initMotionFromStorage();
initBackgroundFromStorage(resolveStoredTheme());
initPreferencesFromStorage();
startStarscape();

const params = new URLSearchParams(location.search);
const slow = Number(params.get('slow') ?? 0);

const calls: StoreCall[] = [];
const faults: ReadFaults = { next: null };

/** Logs the store's calls; `slow` holds each write back that long first, so
 * a save is still in flight when the next step comes. */
function instrument(store: FileStore): FileStore {
  return instrumentStore(store, calls, slow, faults);
}

async function start() {
  const opfs = await navigator.storage.getDirectory();
  const registry = await createOpfsRegistry(await opfs.getDirectoryHandle('sessions-harness', { create: true }));
  if ((await registry.list()).length === 0) {
    await registry.create({ name: 'Night Sky', color: '#7c8cff', id: PROJECT_ID });
    const seed = await registry.files(PROJECT_ID);
    for (const [path, data] of Object.entries(buildFixtures())) await seed.write(path, data);
  }
  const open = registry.open.bind(registry);
  registry.open = async (id) => instrument(await open(id));

  // A store of its own, as another part of the page would have.
  const files = () => registry.files(PROJECT_ID);
  const harness = {
    calls,
    writes: (path: string) => calls.filter((call) => call.op === 'write' && call.path === path).length,
    lists: () => calls.filter((call) => call.op === 'list').length,
    /** The workspace's next `skip` reads of `path` go through, the `fail`
     * after them fail. */
    failReads(path: string, skip: number, fail: number) {
      faults.next = { path, skip, fail };
    },
    async read(path: string): Promise<string | null> {
      const store = await files();
      return (await store.stat(path)) ? store.readText(path) : null;
    },
    async bytes(path: string): Promise<number[] | null> {
      const store = await files();
      return (await store.stat(path)) ? Array.from(await blobToBytes(await store.readBlob(path))) : null;
    },
    async paths(): Promise<string[]> {
      return (await (await files()).list()).filter((entry) => !entry.path.startsWith('.nebula')).map((entry) => entry.path);
    },
    async write(path: string, text: string): Promise<void> {
      await (await files()).write(path, text);
    },
    async scene(path: string): Promise<{ ids: string[]; appState: Record<string, unknown> } | null> {
      const text = await harness.read(path);
      if (text === null || text.trim() === '') return null;
      let scene: { elements: Array<{ id: string; isDeleted?: boolean }>; appState?: Record<string, unknown> };
      try {
        scene = isObsidianExcalidrawMarkdown(text) ? readObsidianExcalidrawMarkdown(text) : JSON.parse(text);
      } catch {
        // Caught mid-write (WebKit shows a file being written as NUL bytes): not yet.
        return null;
      }
      return {
        ids: scene.elements.filter((element) => !element.isDeleted).map((element) => element.id),
        appState: scene.appState ?? {},
      };
    },
  };
  (window as unknown as { __sessions: typeof harness }).__sessions = harness;

  const file = params.get('file');
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Workspace registry={registry} persistent={params.get('persistent') !== '0'} initialFile={file ? { projectId: PROJECT_ID, path: file } : null} />
    </StrictMode>,
  );
  (window as unknown as { __sessionsReady: boolean }).__sessionsReady = true;
}

void start();
