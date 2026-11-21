/**
 * Nebula's addresses:
 *
 * - The app lives under a mount: `/app` on nebula.starscape.app and the
 *   tailnet copy, where `/` is the landing page; the root under `pnpm dev`
 *   and `nebula run`; and wherever a host mounts it (`/nebula` in the
 *   Suite). A Nebula server says where in the page it serves (a `<base
 *   href>`, cli/app.mjs); the site's page has none, and `/app` is read from
 *   the address. Every address below is read inside the mount.
 * - `/p/<project>/<path>` opens a file, or shows a folder in the file tree;
 *   `/p/<project>` opens a project. Each segment is URL-encoded, so any file
 *   name survives the trip. These are the links Orbit's cards carry.
 * - Nebula 1.x's `/b/…` links are no longer read: routes.json sends them to
 *   the app's front door.
 * - A file's link may carry `?context=orbit:card/<board>/<n>`: the Orbit card it was opened from.
 *   The app names it on that file's writes, from this tab only (src/files/serverStore.ts).
 *
 * routes.json serves the app for `/app` and `/app/p/*`, and sends 2.0's
 * `/p/*` there (tests/nebulaSite.test.mjs).
 */

import { isContextLink } from '../files/contextLink';

/** An address; only its pathname (and a file link's `context`) is read. */
export type RouteLocation = { pathname: string; search: string; hash: string };

/** `context`: the link an Orbit card gave this file (`?context=orbit:card/<board>/<n>`), when it passes
 * the server's rule. Only a file's link carries one. */
export type FileTarget = { type: 'file'; projectId: string; path: string | null; context?: string };

/** Where to start: a project, and maybe a file in it (and the card it was opened from). */
export type OpenTarget = { projectId: string; path: string | null; context?: string };

const FILE_PREFIX = '/p/';

/** Where the app is mounted when the site has a landing page at `/`. */
export const APP_MOUNT = '/app';

/** The app's prefix for an address on the site: `/app` inside the mount,
 * '' when the app is served at the root (`pnpm dev`). */
export function appBase(pathname: string): string {
  return pathname === APP_MOUNT || pathname.startsWith(`${APP_MOUNT}/`) ? APP_MOUNT : '';
}

/** Where the app is mounted, read from the page at run time: the path of
 * the `<base href>` a Nebula server put in it ('' for `/`, `/nebula` for
 * `/nebula/`), else appBase of the address. */
export function appMount(doc: Pick<Document, 'querySelector' | 'baseURI'> = document, pathname: string = window.location.pathname): string {
  if (!doc.querySelector('base[href]')) return appBase(pathname);
  try {
    return new URL(doc.baseURI).pathname.replace(/\/+$/, '');
  } catch {
    return appBase(pathname);
  }
}

/** An address as the app reads it, inside the mount `base`: `/app/p/x` →
 * `/p/x`, `/app` → `/`. An address outside the mount reads as it is. */
function insideApp(pathname: string, base: string): string {
  if (!base) return pathname;
  return pathname === base || pathname.startsWith(`${base}/`) ? pathname.slice(base.length) || '/' : pathname;
}

function decode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
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

/** What an address asks Nebula to open: the project and file of a `/p/…`
 * link; null for the plain front door, and for anything else, Nebula 1.x's
 * `/b/…` links included (the site sends those to the front door). */
export function parseRoute(location: RouteLocation, base: string = appBase(location.pathname)): FileTarget | null {
  const pathname = insideApp(location.pathname, base);
  if (!pathname.startsWith(FILE_PREFIX)) return null;
  const target = parseFileRoute(pathname);
  if (target?.path) {
    // Anything the server would refuse as a context is dropped here, so a file never opens with a
    // value its writes can't send.
    const context = new URLSearchParams(location.search).get('context');
    if (isContextLink(context)) target.context = context;
  }
  return target;
}

/** The address of a file or folder (or of a project, with `path` null),
 * under the app's mount `base` ('', `/app` or a host's, from appMount). */
export function fileUrl(projectId: string, path: string | null, base = ''): string {
  const project = `${base}${FILE_PREFIX}${encodeURIComponent(projectId)}`;
  return path ? `${project}/${path.split('/').map(encodeURIComponent).join('/')}` : project;
}

/** The app's own front door under `base`: `/app`, or `/` at the root. */
export function appHome(base: string): string {
  return base || '/';
}

/** One of the built app's own files (`sample/…`), as an absolute URL: the
 * build's base is './' for a server's copy (relative to the page's `<base
 * href>`) and '/' for the site's. */
export function appAsset(path: string, base: string = import.meta.env.BASE_URL, doc: Pick<Document, 'baseURI'> = document): string {
  return new URL(`${base}${path}`, doc.baseURI).href;
}
