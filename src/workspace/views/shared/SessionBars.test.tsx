/**
 * The save bars when a save met the account: which controls are there and what they call. A
 * signed-out failure offers Sign in again and Try again; a full space offers Get more space (only
 * for a web address) and Try again; any other failure offers Try again alone. No sentence is
 * asserted: the words are checked by eye.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../../../files/account';
import { SignedOutError, SpaceFullError } from '../../../files/serverStore';
import { byLabel, click, render, type Rendered } from '../testing/render';
import { SaveFailure } from './SaveFailure';
import { SessionBars } from './SessionBars';
import type { TextSession, TextSessionState } from './textSession';

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});

const SIGN_IN = 'Sign in again';
const MORE_SPACE = 'Get more space';
const TRY_AGAIN = 'Try again';

function controls(): string[] {
  return [...document.querySelectorAll('button, a')].map((element) => (element.textContent ?? '').trim());
}

describe('SaveFailure', () => {
  it('a signed-out failure offers Sign in again and Try again, and no link to more space', async () => {
    rendered = await render(<SaveFailure error={new SignedOutError()} onTryAgain={() => {}} />);
    expect(controls()).toEqual([SIGN_IN, TRY_AGAIN]);
  });

  it('Sign in again, unframed, opens the host’s sign-in address in a new tab, noopener', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    rendered = await render(<SaveFailure error={new SignedOutError({ signIn: 'https://suite.test/sign-in' })} onTryAgain={() => {}} />);
    await click(byLabel(rendered.container, SIGN_IN));
    expect(open).toHaveBeenCalledWith('https://suite.test/sign-in', '_blank', 'noopener');
  });

  it('Sign in again with an address that isn’t http(s) opens the app’s own instead', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    rendered = await render(<SaveFailure error={new SignedOutError({ signIn: 'javascript:alert(1)' })} onTryAgain={() => {}} />);
    await click(byLabel(rendered.container, SIGN_IN));
    expect(open).toHaveBeenCalledTimes(1);
    expect(String(open.mock.calls[0][0])).not.toMatch(/^javascript:/i);
    expect(String(open.mock.calls[0][0])).toMatch(/^https?:/);
  });

  it('a full space offers Get more space for an http(s) address, as a link that opens beside the app, and Try again', async () => {
    rendered = await render(<SaveFailure error={new SpaceFullError({ used: 120, limit: 1000, upgrade: 'https://suite.test/plans' })} onTryAgain={() => {}} />);
    expect(controls()).toEqual([MORE_SPACE, TRY_AGAIN]);
    const link = byLabel(rendered.container, MORE_SPACE) as HTMLAnchorElement;
    expect(link.tagName).toBe('A');
    expect(link.getAttribute('href')).toBe('https://suite.test/plans');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it.each([['javascript:alert(1)'], ['data:text/html,x'], ['ftp://x.test/plans'], [undefined], ['']])('a full space with the address %s offers no link, only Try again', async (upgrade) => {
    rendered = await render(<SaveFailure error={new SpaceFullError({ used: 1, limit: 1, upgrade })} onTryAgain={() => {}} />);
    expect(controls()).toEqual([TRY_AGAIN]);
    expect(document.querySelectorAll('a')).toHaveLength(0);
  });

  it('any other failure offers Try again alone', async () => {
    rendered = await render(<SaveFailure error={new Error('Disk on fire')} onTryAgain={() => {}} />);
    expect(controls()).toEqual([TRY_AGAIN]);
  });

  it('Try again calls what it was given, once per press', async () => {
    const again = vi.fn();
    rendered = await render(<SaveFailure error={new SignedOutError()} onTryAgain={again} />);
    await click(byLabel(rendered.container, TRY_AGAIN));
    expect(again).toHaveBeenCalledTimes(1);
  });
});

describe('SaveFailure with a store that can say it’s signed in again (the canvas)', () => {
  function account() {
    const listeners = new Set<(status: AccountStatus) => void>();
    return {
      store: {
        onAccount(listener: (status: AccountStatus) => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
        signedOut: () => ({}),
        retryAccount: async () => {},
      },
      say: (status: AccountStatus) => [...listeners].forEach((listener) => listener(status)),
      listeners,
    };
  }

  it('saves again by itself once signed in, and once for each time', async () => {
    const { store, say } = account();
    const again = vi.fn();
    rendered = await render(<SaveFailure error={new SignedOutError()} onTryAgain={again} store={store} />);
    say('signed-out');
    expect(again).not.toHaveBeenCalled();
    say('signed-in');
    expect(again).toHaveBeenCalledTimes(1);
  });

  it('calls the latest Try again, not the one it first rendered with', async () => {
    const { store, say } = account();
    const first = vi.fn();
    const second = vi.fn();
    rendered = await render(<SaveFailure error={new SignedOutError()} onTryAgain={first} store={store} />);
    await rendered.rerender(<SaveFailure error={new SignedOutError()} onTryAgain={second} store={store} />);
    say('signed-in');
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it('a full space or another failure never saves by itself, and a bar that goes stops listening', async () => {
    const { store, say, listeners } = account();
    const again = vi.fn();
    rendered = await render(<SaveFailure error={new SpaceFullError({ used: 1, limit: 1 })} onTryAgain={again} store={store} />);
    expect(listeners.size).toBe(0);
    say('signed-in');
    expect(again).not.toHaveBeenCalled();
    await rendered.rerender(<SaveFailure error={new SignedOutError()} onTryAgain={again} store={store} />);
    expect(listeners.size).toBe(1);
    await rendered.unmount();
    rendered = null;
    expect(listeners.size).toBe(0);
  });
});

describe('SessionBars', () => {
  const base: TextSessionState = { status: 'ready', text: 'x', dirty: true, conflict: false, removed: false, unreachable: null, moving: false, readOnly: false, revision: 1 };
  const fakeSession = (): TextSession => ({ flush: vi.fn(async () => {}), reload: vi.fn(async () => {}), keepMine: vi.fn(async () => {}) }) as unknown as TextSession;

  it('a refused save shows its own alert with Try again calling the session’s flush', async () => {
    const session = fakeSession();
    rendered = await render(<SessionBars session={session} state={{ ...base, saveError: new SignedOutError() }} />);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(controls()).toEqual([SIGN_IN, TRY_AGAIN]);
    await click(byLabel(rendered.container, TRY_AGAIN));
    expect(session.flush).toHaveBeenCalledTimes(1);
  });

  it('a full space and a plain failure get their own controls in the same bar', async () => {
    const session = fakeSession();
    rendered = await render(<SessionBars session={session} state={{ ...base, saveError: new SpaceFullError({ used: 1, limit: 2, upgrade: 'https://suite.test/p' }) }} />);
    expect(controls()).toEqual([MORE_SPACE, TRY_AGAIN]);
    await rendered.rerender(<SessionBars session={session} state={{ ...base, saveError: new Error('nope') }} />);
    expect(controls()).toEqual([TRY_AGAIN]);
  });

  it('with no failure there is no bar for it', async () => {
    rendered = await render(<SessionBars session={fakeSession()} state={base} />);
    expect(document.querySelectorAll('button, a')).toHaveLength(0);
  });

  it('a changed-elsewhere conflict is its own bar and wins over a kept edit’s', async () => {
    const session = fakeSession();
    rendered = await render(<SessionBars session={session} state={{ ...base, conflict: true, saveError: new SignedOutError() }} />);
    expect(controls()).toEqual(['Reload', 'Keep mine']);
  });
});
