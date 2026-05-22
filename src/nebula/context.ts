export type NebulaUserContext = {
  id: string;
  name?: string;
  color?: string;
};

export type NebulaContext = {
  /** Stable Orbit board id or standalone board key that owns this canvas. */
  boardId: string;
  /** Optional human/stable slug supplied by Orbit or an embedding host. */
  boardSlug?: string;
  boardName?: string;
  /** Board-local canvas id. Standalone Nebula defaults to `main`. */
  canvasId: string;
  user?: NebulaUserContext;
  /** Optional Orbit API/app origin for embedded persistence adapters. */
  orbitBaseUrl?: string;
};

export type NebulaContextInput = Partial<NebulaContext>;
export type NebulaHostContext = NebulaContextInput;

type BrowserLikeContext = {
  location?: Pick<Location, 'hash' | 'pathname' | 'search'>;
  __NEBULA_CONTEXT__?: NebulaHostContext;
};

export const DEFAULT_NEBULA_BOARD_ID = 'ss-nebula';
export const DEFAULT_NEBULA_CANVAS_ID = 'main';

function getBrowserContext(): BrowserLikeContext | undefined {
  return typeof window !== 'undefined' ? window : undefined;
}

function optionalParam(params: URLSearchParams, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = params.get(name)?.trim();
    if (value) return value;
  }

  return undefined;
}

export function resolveNebulaContext(input: NebulaContextInput = {}): NebulaContext {
  const browser = getBrowserContext();
  const browserContext = browser?.__NEBULA_CONTEXT__ ?? {};
  const routeContext = browser?.location ? nebulaContextFromRoute(browser.location) : {};
  const searchContext = browser?.location?.search ? nebulaContextFromSearchParams(browser.location.search) : {};
  const merged = {
    ...routeContext,
    ...searchContext,
    ...browserContext,
    ...input,
  };

  const context: NebulaContext = {
    boardId: merged.boardId?.trim() || merged.boardSlug?.trim() || DEFAULT_NEBULA_BOARD_ID,
    canvasId: merged.canvasId?.trim() || DEFAULT_NEBULA_CANVAS_ID,
  };
  const boardSlug = merged.boardSlug?.trim();
  const boardName = merged.boardName?.trim();
  const orbitBaseUrl = merged.orbitBaseUrl?.trim();

  if (boardSlug) context.boardSlug = boardSlug;
  if (boardName) context.boardName = boardName;
  if (merged.user) context.user = merged.user;
  if (orbitBaseUrl) context.orbitBaseUrl = orbitBaseUrl;

  return context;
}

export function nebulaContextFromSearchParams(search: string | URLSearchParams): NebulaContextInput {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search;
  const userId = optionalParam(params, 'userId');

  return {
    boardId: optionalParam(params, 'boardId', 'board'),
    boardSlug: optionalParam(params, 'boardSlug', 'slug'),
    boardName: optionalParam(params, 'boardName'),
    canvasId: optionalParam(params, 'canvasId', 'canvas'),
    orbitBaseUrl: optionalParam(params, 'orbitBaseUrl'),
    user: userId
      ? {
          id: userId,
          name: optionalParam(params, 'userName'),
          color: optionalParam(params, 'userColor'),
        }
      : undefined,
  };
}

type RouteLikeLocation = Pick<Location, 'hash' | 'pathname'>;

function firstRouteValue(segments: string[], ...keys: string[]): string | undefined {
  for (const key of keys) {
    const index = segments.indexOf(key);
    const value = index >= 0 ? segments[index + 1]?.trim() : undefined;
    if (value) return decodeURIComponent(value);
  }

  return undefined;
}

function normalizeRouteSegments(path: string): string[] {
  return path
    .replace(/^#/, '')
    .replace(/^\//, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter(Boolean);
}

/**
 * Parse standalone routes without requiring a router dependency. Supported
 * shapes intentionally mirror Orbit-ish shorthand while staying static-host
 * friendly:
 *
 * - `#/b/:boardSlug`
 * - `#/b/:boardSlug/c/:canvasId`
 * - `/b/:boardSlug/c/:canvasId`
 *
 * Query params still win when both are present, and embedded host context wins
 * over both. This keeps package mounts deterministic while letting the Vite app
 * survive direct URL loads for launch.
 */
export function nebulaContextFromRoute(location: RouteLikeLocation): NebulaContextInput {
  const hashSegments = normalizeRouteSegments(location.hash || '');
  const pathSegments = normalizeRouteSegments(location.pathname || '');
  const segments = hashSegments.length > 0 ? hashSegments : pathSegments;
  const boardSlug = firstRouteValue(segments, 'b', 'board');
  const canvasId = firstRouteValue(segments, 'c', 'canvas');

  return {
    boardId: boardSlug,
    boardSlug,
    canvasId,
  };
}

declare global {
  interface Window {
    __NEBULA_CONTEXT__?: NebulaHostContext;
  }
}
