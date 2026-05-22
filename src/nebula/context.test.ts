import { afterEach, describe, expect, it } from 'vitest';

import { nebulaContextFromRoute, nebulaContextFromSearchParams, resolveNebulaContext } from './context';

function resetBrowserContext(): void {
  window.history.replaceState({}, '', '/');
  delete window.__NEBULA_CONTEXT__;
}

describe('nebulaContextFromSearchParams', () => {
  it('maps supported board, canvas, Orbit, and user aliases from the URL query', () => {
    expect(
      nebulaContextFromSearchParams(
        '?board=orbit-board&slug=mission-control&boardName=Mission%20Control&canvas=map&orbitBaseUrl=%2Forbit&userId=u1&userName=Aeva&userColor=%237c3aed',
      ),
    ).toEqual({
      boardId: 'orbit-board',
      boardSlug: 'mission-control',
      boardName: 'Mission Control',
      canvasId: 'map',
      orbitBaseUrl: '/orbit',
      user: {
        id: 'u1',
        name: 'Aeva',
        color: '#7c3aed',
      },
    });
  });

  it('leaves user unset when a user id is not present', () => {
    expect(nebulaContextFromSearchParams('?userName=No%20ID')).toMatchObject({
      user: undefined,
    });
  });

  it('accepts URLSearchParams and trims empty embed values', () => {
    const params = new URLSearchParams({
      boardId: '  board-a  ',
      canvasId: '   ',
      userId: ' user-a ',
    });

    expect(nebulaContextFromSearchParams(params)).toMatchObject({
      boardId: 'board-a',
      canvasId: undefined,
      user: { id: 'user-a' },
    });
  });
});

describe('nebulaContextFromRoute', () => {
  it('maps hash board/canvas routes for static-host direct loads', () => {
    expect(nebulaContextFromRoute({ hash: '#/b/ss-nebula/c/launch-map', pathname: '/' })).toEqual({
      boardId: 'ss-nebula',
      boardSlug: 'ss-nebula',
      canvasId: 'launch-map',
    });
  });

  it('maps path routes when no hash route is present', () => {
    expect(nebulaContextFromRoute({ hash: '', pathname: '/board/Mission%20Control/canvas/main' })).toEqual({
      boardId: 'Mission Control',
      boardSlug: 'Mission Control',
      canvasId: 'main',
    });
  });
});

describe('resolveNebulaContext', () => {
  afterEach(() => {
    resetBrowserContext();
  });

  it('uses standalone defaults when no context is provided', () => {
    resetBrowserContext();

    expect(resolveNebulaContext()).toEqual({
      boardId: 'ss-nebula',
      canvasId: 'main',
    });
  });

  it('merges search params, injected browser context, and explicit input in priority order', () => {
    window.history.replaceState({}, '', '/?boardId=query-board&canvasId=query-canvas&boardName=From%20Query');
    window.__NEBULA_CONTEXT__ = {
      boardId: 'window-board',
      boardSlug: 'window-slug',
      canvasId: 'window-canvas',
      boardName: 'From Window',
    };

    expect(
      resolveNebulaContext({
        canvasId: 'input-canvas',
        user: { id: 'input-user' },
      }),
    ).toEqual({
      boardId: 'window-board',
      boardSlug: 'window-slug',
      boardName: 'From Window',
      canvasId: 'input-canvas',
      user: { id: 'input-user' },
    });
  });

  it('uses boardSlug as the board id fallback for embedded Orbit links', () => {
    resetBrowserContext();

    expect(resolveNebulaContext({ boardSlug: 'alpha-board' })).toMatchObject({
      boardId: 'alpha-board',
      boardSlug: 'alpha-board',
      canvasId: 'main',
    });
  });

  it('normalizes whitespace-only optional host context back to safe defaults', () => {
    resetBrowserContext();

    expect(resolveNebulaContext({ boardId: ' ', boardSlug: ' ', canvasId: ' ', boardName: ' ' })).toEqual({
      boardId: 'ss-nebula',
      canvasId: 'main',
    });
  });
});
