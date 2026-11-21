import { describe, expect, it } from 'vitest';
import * as files from './index';

describe('src/files public surface', () => {
  it('carries the first run the app does: registry, then the sample or the last project', async () => {
    // jsdom has no OPFS, so this is the memory tier: nothing will be kept.
    const { registry, persistent, reason } = await files.openBrowserRegistry();
    expect(persistent).toBe(false);
    expect(reason).toBeTruthy();

    if ((await registry.current()) === null) {
      const fetchNothing = (async () => new Response(null, { status: 404 })) as typeof fetch;
      const { project, missing } = await files.seedSampleProject(registry, { fetch: fetchNothing });
      expect(project.name).toBe(files.SAMPLE_PROJECT.name);
      expect(missing).toHaveLength(2);
    }
    const current = await registry.current();
    expect(current).not.toBeNull();
    const store = await registry.open(current as string);
    const state = await files.readWorkspaceState(store);
    expect(state.active).toBe('Guides/Observing plan.md');
    expect(await files.kindOf(store, state.active as string)).toBe('note');
    expect(await files.kindOf(store, 'Sketches/Winter hexagon.excalidraw.md')).toBe('canvas');

    const zip = await files.projectToZip(store, { folder: 'Night Sky' });
    expect(zip.type).toBe('application/zip');
    expect(files.zipFileName('Night Sky')).toBe('Night Sky.zip');
    expect(await files.requestPersistentStorage()).toBeNull();
  });

  it('exports the stores, path helpers, errors and contracts the other lanes use', () => {
    for (const name of [
      'MemoryFileStore',
      'OpfsFileStore',
      'scopedStore',
      'createBrowserRegistry',
      'normalizePath',
      'joinPath',
      'dirname',
      'basename',
      'extension',
      'stem',
      'uniqueName',
      'comparePaths',
      'InvalidPathError',
      'FileNotFoundError',
      'FileExistsError',
      'errorName',
      'kindFromName',
      'kindFromContent',
      'storageStatus',
      'formatBytes',
      'writeWorkspaceState',
      'emptyWorkspaceState',
      'PLANET_COLOURS',
      'DEFAULT_PREFERENCES',
      'blobToText',
    ]) {
      expect(files, name).toHaveProperty(name);
    }
  });

  it('exports the locks', () => {
    for (const name of ['withLock', 'PathLocks']) {
      expect(files, name).toHaveProperty(name);
    }
  });

  it('exports the name rules for new names and the read-only registry error', () => {
    for (const name of ['newNameProblem', 'portableName', 'ReadOnlyRegistryError']) {
      expect(files, name).toHaveProperty(name);
    }
  });
});
