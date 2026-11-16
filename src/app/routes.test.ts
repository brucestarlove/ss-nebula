import { beforeEach, describe, expect, it } from 'vitest';
import { MemoryFileStore } from '../files/memoryStore';
import { migrateLegacyCanvases } from '../files/migration';
import { createBrowserRegistry, type BrowserRegistry } from '../files/registry';
import { createEmptyNebulaMetadata } from '../nebula/excalidraw/metadata';
import { createEmptyExcalidrawScene } from '../nebula/excalidraw/scene';
import type { LegacyRoutes } from './boot';
import { appBase, appHome, fileUrl, parseRoute, resolveLegacyRoute } from './routes';

function at(url: string) {
  const parsed = new URL(url, 'https://nebula.starscape.app');
  return { pathname: parsed.pathname, search: parsed.search, hash: parsed.hash };
}

describe('parseRoute', () => {
  it('opens the last project at the root', () => {
    expect(parseRoute(at('/'))).toBeNull();
  });

  it('reads a file link: /p/<project>/<path>, decoded', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa/Guides/Observing%20plan.md'))).toEqual({
      type: 'file',
      projectId: 'k3v9x2m1qa',
      path: 'Guides/Observing plan.md',
    });
    expect(parseRoute(at('/p/k3v9x2m1qa/Charts/Star%20chart%20%E2%80%94%20October.pdf'))).toMatchObject({
      path: 'Charts/Star chart — October.pdf',
    });
  });

  it('reads a project link without a file', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at('/p/k3v9x2m1qa/'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
  });

  it('treats a malformed link as no link, rather than failing', () => {
    expect(parseRoute(at('/p/k3v9x2m1qa/%E0%A4%A'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at('/p/%E0%A4%A/notes.md'))).toBeNull();
    expect(parseRoute(at('/p/'))).toBeNull();
  });

  it('reads the old board links: path, hash and query', () => {
    expect(parseRoute(at('/b/ss-nebula/c/launch-map'))).toEqual({ type: 'legacy', board: 'ss-nebula', canvas: 'launch-map' });
    expect(parseRoute(at('/#/b/demo/c/sketch'))).toEqual({ type: 'legacy', board: 'demo', canvas: 'sketch' });
    expect(parseRoute(at('/?board=demo&canvas=sketch'))).toEqual({ type: 'legacy', board: 'demo', canvas: 'sketch' });
    expect(parseRoute(at('/b/Mission%20Control'))).toEqual({ type: 'legacy', board: 'Mission Control', canvas: null });
    expect(parseRoute(at('/?canvas=sketch'))).toEqual({ type: 'legacy', board: null, canvas: 'sketch' });
  });

  it('lets the query win over the old path, as Nebula 1.x did', () => {
    expect(parseRoute(at('/b/demo/c/sketch?canvas=other'))).toEqual({ type: 'legacy', board: 'demo', canvas: 'other' });
  });

  it('ignores queries that aren’t board links', () => {
    expect(parseRoute(at('/?utm_source=mastodon'))).toBeNull();
  });

  it('reads every address the same inside /app, where the site mounts the app', () => {
    expect(parseRoute(at('/app'))).toBeNull();
    expect(parseRoute(at('/app/'))).toBeNull();
    expect(parseRoute(at('/app/p/k3v9x2m1qa/Guides/Observing%20plan.md'))).toEqual({
      type: 'file',
      projectId: 'k3v9x2m1qa',
      path: 'Guides/Observing plan.md',
    });
    expect(parseRoute(at('/app/p/k3v9x2m1qa'))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: null });
    expect(parseRoute(at('/app/b/ss-nebula/c/launch-map'))).toEqual({ type: 'legacy', board: 'ss-nebula', canvas: 'launch-map' });
    expect(parseRoute(at('/app#/b/demo/c/sketch'))).toEqual({ type: 'legacy', board: 'demo', canvas: 'sketch' });
    expect(parseRoute(at('/app?board=demo&canvas=sketch'))).toEqual({ type: 'legacy', board: 'demo', canvas: 'sketch' });
  });

  it('doesn’t mistake a path that only starts with “app” for the mount', () => {
    expect(appBase('/apple/p/x')).toBe('');
    expect(parseRoute(at('/apple/p/x'))).toBeNull();
  });
});

describe('appBase and appHome', () => {
  it('finds the mount from the address the app was opened at', () => {
    expect(appBase('/app')).toBe('/app');
    expect(appBase('/app/p/k3v9x2m1qa/README.md')).toBe('/app');
    expect(appBase('/')).toBe('');
    expect(appBase('/p/k3v9x2m1qa')).toBe('');
  });

  it('names the app’s front door under each', () => {
    expect(appHome('/app')).toBe('/app');
    expect(appHome('')).toBe('/');
  });
});

describe('fileUrl', () => {
  it('writes a file link that reads back the same, whatever the name', () => {
    for (const path of ['Guides/Observing plan.md', 'Charts/Star chart — October.pdf', 'a#b?c.md', '100% done.md', 'Ünïcode/日本.txt']) {
      const url = fileUrl('k3v9x2m1qa', path);
      expect(url.startsWith('/p/k3v9x2m1qa/')).toBe(true);
      expect(url).not.toMatch(/[ #?]/);
      expect(parseRoute(at(url))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path });
    }
  });

  it('keeps folders readable in the address', () => {
    expect(fileUrl('k3v9x2m1qa', 'Guides/Observing plan.md')).toBe('/p/k3v9x2m1qa/Guides/Observing%20plan.md');
  });

  it('links a project with nothing open', () => {
    expect(fileUrl('k3v9x2m1qa', null)).toBe('/p/k3v9x2m1qa');
  });

  it('writes links inside the mount that read back the same', () => {
    expect(fileUrl('k3v9x2m1qa', 'Concept art', '/app')).toBe('/app/p/k3v9x2m1qa/Concept%20art');
    expect(fileUrl('k3v9x2m1qa', null, '/app')).toBe('/app/p/k3v9x2m1qa');
    const url = fileUrl('k3v9x2m1qa', 'Sessions/2026-10-26 14.55 Deploy.md', '/app');
    expect(parseRoute(at(url))).toEqual({ type: 'file', projectId: 'k3v9x2m1qa', path: 'Sessions/2026-10-26 14.55 Deploy.md' });
  });
});

describe('resolveLegacyRoute', () => {
  let registry: BrowserRegistry;
  let routes: LegacyRoutes;

  beforeEach(async () => {
    registry = createBrowserRegistry(new MemoryFileStore());
    await registry.create({ name: 'My First Project', color: '#7c8cff', id: 'ss-nebula' });
    const launch = await registry.create({ name: 'Launch', color: '#e0a458' });
    const mine = await registry.files('ss-nebula');
    await mine.write('Winter hexagon.excalidraw.md', 'x');
    await mine.write('Launch plan.excalidraw.md', 'x');
    await (await registry.files(launch.id)).write('Phase 1.excalidraw.md', 'x');
    routes = {
      'ss-nebula': { project: 'ss-nebula', canvases: { main: 'Winter hexagon.excalidraw.md', ideas: 'Launch plan.excalidraw.md' } },
      'board/a': { project: launch.id, canvases: { 'canvas b': 'Phase 1.excalidraw.md' } },
    };
  });

  it('opens the file a canvas moved to', async () => {
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'ss-nebula', canvas: 'ideas' }, { registry, routes })).toEqual({
      projectId: 'ss-nebula',
      path: 'Launch plan.excalidraw.md',
    });
    const launch = routes['board/a'].project;
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'board/a', canvas: 'canvas b' }, { registry, routes })).toEqual({
      projectId: launch,
      path: 'Phase 1.excalidraw.md',
    });
  });

  it('starts from the default board, as Nebula 1.x did', async () => {
    expect(await resolveLegacyRoute({ type: 'legacy', board: null, canvas: 'main' }, { registry, routes })).toEqual({
      projectId: 'ss-nebula',
      path: 'Winter hexagon.excalidraw.md',
    });
  });

  it('finds a canvas by its name when its id isn’t known', async () => {
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'ss-nebula', canvas: 'winter HEXAGON' }, { registry, routes: {} })).toEqual({
      projectId: 'ss-nebula',
      path: 'Winter hexagon.excalidraw.md',
    });
  });

  it('opens the project when the canvas isn’t there', async () => {
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'ss-nebula', canvas: 'gone' }, { registry, routes })).toEqual({
      projectId: 'ss-nebula',
      path: null,
    });
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'Launch', canvas: null }, { registry, routes: {} })).toMatchObject({ path: null });
  });

  it('opens nothing in particular for a board that never moved here', async () => {
    expect(await resolveLegacyRoute({ type: 'legacy', board: 'elsewhere', canvas: 'main' }, { registry, routes })).toBeNull();
  });
});

describe('resolveLegacyRoute, from the migration’s own record', () => {
  // Not a safe id, so its project gets a new one; and no localStorage map,
  // as when localStorage was full.
  const BOARD = 'Field Board/2026';

  async function migrated() {
    window.localStorage.clear();
    const registry = createBrowserRegistry(new MemoryFileStore());
    const legacy = {
      type: 'starscape.nebula.excalidraw',
      version: 1,
      boardId: BOARD,
      canvasId: 'c-7',
      name: 'Field notes',
      updatedAt: '2026-05-29T12:00:00.000Z',
      scene: createEmptyExcalidrawScene(),
      nebula: createEmptyNebulaMetadata(),
    };
    window.localStorage.setItem(`nebula:excalidraw:${encodeURIComponent(BOARD)}:c-7`, JSON.stringify(legacy));
    const report = await migrateLegacyCanvases({ storage: window.localStorage, registry, persistent: true });
    expect(report.status).toBe('migrated');
    return { registry, project: report.projects[0] };
  }

  it('opens the file a canvas moved to, with no map of it in localStorage', async () => {
    const { registry, project } = await migrated();
    expect(await resolveLegacyRoute({ type: 'legacy', board: BOARD, canvas: 'c-7' }, { registry, routes: {} })).toEqual({
      projectId: project.projectId,
      path: project.files[0].path,
    });
  });

  it('opens the project a board moved to, though it has been renamed since', async () => {
    const { registry, project } = await migrated();
    await registry.update(project.projectId, { name: 'Renamed' });
    expect(await resolveLegacyRoute({ type: 'legacy', board: BOARD, canvas: null }, { registry, routes: {} })).toEqual({
      projectId: project.projectId,
      path: null,
    });
  });
});
