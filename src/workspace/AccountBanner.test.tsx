/**
 * The banner that says the session has ended, and the mark of a file opened from an Orbit card:
 * when each is on the page, what Sign in again calls, and that a store with no account shows
 * neither. No sentence is asserted.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../files/account';
import { byLabel, click, render, type Rendered } from './views/testing/render';
import { AccountBanner, ContextMark } from './AccountBanner';

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  vi.restoreAllMocks();
});

function accountStore(initial: { signIn?: string } | null = null) {
  let out = initial;
  const listeners = new Set<(status: AccountStatus) => void>();
  return {
    store: {
      onAccount(listener: (status: AccountStatus) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      signedOut: () => out,
      retryAccount: async () => {},
    },
    signOut(signIn?: string) {
      out = signIn ? { signIn } : {};
      [...listeners].forEach((listener) => listener('signed-out'));
    },
    signIn() {
      out = null;
      [...listeners].forEach((listener) => listener('signed-in'));
    },
    listeners,
  };
}

const banners = () => document.querySelectorAll('.ws-account-banner');

describe('AccountBanner', () => {
  it('shows once for a store that is signed out, with Sign in again', async () => {
    const { store } = accountStore({});
    rendered = await render(<AccountBanner store={store} />);
    expect(banners()).toHaveLength(1);
    expect(document.querySelectorAll('.ws-account-banner [role="alert"], .ws-account-banner[role="alert"]')).toHaveLength(1);
    expect(byLabel(document.body, 'Sign in again')).not.toBeNull();
  });

  it('goes when the store says signed-in, and comes back if it ends again', async () => {
    const account = accountStore();
    rendered = await render(<AccountBanner store={account.store} />);
    expect(banners()).toHaveLength(0);
    await act(async () => account.signOut());
    expect(banners()).toHaveLength(1);
    await act(async () => account.signIn());
    expect(banners()).toHaveLength(0);
    await act(async () => account.signOut());
    expect(banners()).toHaveLength(1);
  });

  it('shows nothing for a store with no account (browser, folder) and for no store', async () => {
    rendered = await render(<AccountBanner store={{ list: async () => [] }} />);
    expect(banners()).toHaveLength(0);
    await rendered.rerender(<AccountBanner store={null} />);
    expect(banners()).toHaveLength(0);
  });

  it('Sign in again opens the host’s address in a new tab when unframed', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const { store } = accountStore({ signIn: 'https://suite.test/sign-in' });
    rendered = await render(<AccountBanner store={store} />);
    await click(byLabel(document.body, 'Sign in again'));
    expect(open).toHaveBeenCalledWith('https://suite.test/sign-in', '_blank', 'noopener');
  });

  it('takes the address of the store as it signs out, not the one it first rendered', async () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    const account = accountStore();
    rendered = await render(<AccountBanner store={account.store} />);
    await act(async () => account.signOut('https://suite.test/again'));
    await click(byLabel(document.body, 'Sign in again'));
    expect(open).toHaveBeenCalledWith('https://suite.test/again', '_blank', 'noopener');
  });

  it('stops listening when it goes, and listens to the store it is given next', async () => {
    const first = accountStore();
    const second = accountStore({});
    rendered = await render(<AccountBanner store={first.store} />);
    expect(first.listeners.size).toBe(1);
    await rendered.rerender(<AccountBanner store={second.store} />);
    expect(first.listeners.size).toBe(0);
    expect(second.listeners.size).toBe(1);
    expect(banners()).toHaveLength(1); // the new store is signed out
    await rendered.unmount();
    rendered = null;
    expect(second.listeners.size).toBe(0);
  });
});

describe('ContextMark', () => {
  function contextStore() {
    const contexts = new Map<string, string>();
    const listeners = new Set<() => void>();
    return {
      store: {
        setContext(path: string, context: string | null) {
          if (context === null) contexts.delete(path);
          else contexts.set(path, context);
          [...listeners].forEach((listener) => listener());
        },
        contextOf: (path: string) => contexts.get(path),
        onContext(listener: () => void) {
          listeners.add(listener);
          return () => void listeners.delete(listener);
        },
      },
      listeners,
    };
  }
  const marks = () => document.querySelectorAll('.ws-context-mark');

  it('shows a small mark for a file with a context, and none for one without, and follows it', async () => {
    const { store, listeners } = contextStore();
    store.setContext('a.md', 'orbit:card/board/1');
    rendered = await render(<ContextMark store={store} path="a.md" />);
    expect(marks()).toHaveLength(1);
    expect(marks()[0].getAttribute('title')).toBe('orbit:card/board/1');
    expect(document.querySelectorAll('[role="alert"], [role="status"]')).toHaveLength(0); // never a banner

    await rendered.rerender(<ContextMark store={store} path="b.md" />);
    expect(marks()).toHaveLength(0);
    await act(async () => store.setContext('b.md', 'https://orbit.test/c/2'));
    expect(marks()).toHaveLength(1);
    await act(async () => store.setContext('b.md', null));
    expect(marks()).toHaveLength(0);
    await rendered.unmount();
    rendered = null;
    expect(listeners.size).toBe(0);
  });

  it('shows nothing with no path, and nothing for a store that has no context', async () => {
    const { store } = contextStore();
    store.setContext('a.md', 'orbit:card/board/1');
    rendered = await render(<ContextMark store={store} path={null} />);
    expect(marks()).toHaveLength(0);
    await rendered.rerender(<ContextMark store={{ list: async () => [] }} path="a.md" />);
    expect(marks()).toHaveLength(0);
  });
});
