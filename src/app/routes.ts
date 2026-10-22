/**
 * Nebula's addresses (PLAN §6, docs/slice-3.md Integration 3):
 *
 * - `/p/<project>/<path>` opens a file; `/p/<project>` opens a project. Each
 *   segment is URL-encoded, so any file name survives the trip.
 * - Nebula 1.x links, `/b/<board>/c/<canvas>`, `#/b/<board>/c/<canvas>` and
 *   `?board=&canvas=`, open the file that canvas moved to (see boot.ts,
 *   LEGACY_ROUTES_KEY), else a canvas of that name, else the project.
 *
 * vercel.json serves the app for `/p/*` and `/b/*` (tests/nebulaSite.test.mjs).
 */
import { kindFromName } from '../files/kinds';
import { stem } from '../files/paths';
import type { BrowserRegistry } from '../files/registry';
import { DEFAULT_NEBULA_BOARD_ID, nebulaContextFromRoute, nebulaContextFromSearchParams, type NebulaContextInput } from '../nebula/context';
import type { LegacyRoutes } from './boot';

export type RouteLocation = { pathname: string; search: string; hash: string };

export type FileTarget = { type: 'file'; projectId: string; path: string | null };
export type LegacyTarget = { type: 'legacy'; board: string | null; canvas: string | null };
export type RouteTarget = FileTarget | LegacyTarget | null;

/** Where to start: a project, and maybe a file in it. */
export type OpenTarget = { projectId: string; path: string | null };

const FILE_PREFIX = '/p/';
const LEGACY_PATH = /^\/b(?:\/|$)/;
const LEGACY_HASH = /^#\/(?:b|board|c|canvas)(?:\/|$)/;

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

function attempt(read: () => NebulaContextInput): NebulaContextInput {
  try {
    return read();
  } catch {
    // A malformed escape in an old link: read it as no link.
    return {};
  }
}

function parseFileRoute(pathname: string): FileTarget | null {
  const segments = pathname.slice(FILE_PREFIX.length).split('/');
  const projectId = decode(segments[0] ?? '');
  if (!projectId) return null;
  const parts = segments.slice(1).filter((segment) => segment !== '').map(decode);
  const path = parts.length > 0 && parts.every((part) => part) ? parts.join('/') : null;
  return { type: 'file', projectId, path };
}

/** What an address asks Nebula to open; null for the plain front door. */
export function parseRoute(location: RouteLocation): RouteTarget {
  const { pathname, search, hash } = location;
  if (pathname.startsWith(FILE_PREFIX)) return parseFileRoute(pathname);

  const query = search ? attempt(() => nebulaContextFromSearchParams(search)) : {};
  const legacyPath = LEGACY_PATH.test(pathname);
  const legacyHash = LEGACY_HASH.test(hash);
  const queryBoard = query.boardId ?? query.boardSlug;
  if (!legacyPath && !legacyHash && !queryBoard && !query.canvasId) return null;

  // Query first, then the old path or hash, as Nebula 1.x read them.
  const route = legacyPath || legacyHash ? attempt(() => nebulaContextFromRoute({ pathname, hash: legacyHash ? hash : '' })) : {};
  return {
    type: 'legacy',
    board: queryBoard ?? route.boardId ?? null,
    canvas: query.canvasId ?? route.canvasId ?? null,
  };
}

/** The address of a file (or of a project, with `path` null). */
export function fileUrl(projectId: string, path: string | null): string {
  const project = `${FILE_PREFIX}${encodeURIComponent(projectId)}`;
  return path ? `${project}/${path.split('/').map(encodeURIComponent).join('/')}` : project;
}

/** The project and file an old board link means now, or null when no
 * project here came from that board. */
export async function resolveLegacyRoute(
  target: LegacyTarget,
  context: { registry: BrowserRegistry; routes: LegacyRoutes },
): Promise<OpenTarget | null> {
  const { registry, routes } = context;
  const board = target.board ?? DEFAULT_NEBULA_BOARD_ID;
  const projects = await registry.list();
  // Where the migration put each canvas, kept in the browser tier itself
  // (review finding 19), so it holds even when localStorage was full. Loaded
  // here, for an old link only: the migration stays out of the first load.
  const { migratedCanvases } = await import('../files/migration');
  const recorded = (await migratedCanvases(registry)).filter((canvas) => canvas.boardId === board);
  const mapped = routes[board];
  const project =
    projects.find((record) => recorded.some((canvas) => canvas.projectId === record.id)) ??
    (mapped && projects.find((record) => record.id === mapped.project)) ??
    projects.find((record) => record.id === board) ??
    projects.find((record) => record.name.toLowerCase() === board.toLowerCase());
  if (!project) return null;
  if (!target.canvas) return { projectId: project.id, path: null };

  const files = (await (await registry.files(project.id)).list()).filter((entry) => entry.type === 'file');
  const moved = [
    recorded.find((canvas) => canvas.projectId === project.id && canvas.canvasId === target.canvas)?.path,
    mapped?.project === project.id ? mapped.canvases[target.canvas] : undefined,
  ].find((path) => path !== undefined && files.some((entry) => entry.path === path));
  if (moved) return { projectId: project.id, path: moved };

  // A canvas named in the link: its file has that name.
  const wanted = target.canvas.toLowerCase();
  const named = files.find((entry) => {
    const kind = kindFromName(entry.name);
    return (kind === 'canvas' || kind === 'note') && stem(entry.path).toLowerCase() === wanted;
  });
  return { projectId: project.id, path: named?.path ?? null };
}
