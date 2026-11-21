/**
 * What a server's store says beyond the FileStore calls, for the parts of the app that must not
 * load the server tier's code (the public site has none): whether the session ended, the link an
 * Orbit card gave a file, the account's space. Every function here finds its method on the store
 * it's given and does nothing when there isn't one, so a browser or folder store passes through.
 * The open server stores are kept here too, so the frame (src/app/frameBridge.ts) can pause and
 * resume every feed, and the page can ask every signed-out store to look again, without importing
 * the tier.
 */
import type { SpaceInfo } from './serverContract';

/** The session ended, or is back. Never a `FileChange`: many views switch over those. */
export type AccountStatus = 'signed-out' | 'signed-in';

export type AccountSource = {
  /** Told when the session ends and when it's back, once each time it changes. */
  onAccount(listener: (status: AccountStatus) => void): () => void;
  /** Whether the session has ended (and where the host signs people in, if it said). */
  signedOut(): { signIn?: string } | null;
  /** Looks again, and says `signed-in` if the server answers now. Quiet when signed in. */
  retryAccount(): Promise<void>;
};

export type ContextSource = {
  /** The link this tab's writes to `path` name, or null to stop naming one. */
  setContext(path: string, context: string | null): void;
  contextOf(path: string): string | undefined;
  /** Told whenever a context is set, cleared or moves with a rename. */
  onContext(listener: () => void): () => void;
};

export type SpaceSource = {
  /** The account's space as the place says it now, or undefined when it says none. */
  space(): Promise<SpaceInfo | undefined>;
};

function has<T>(store: unknown, ...methods: string[]): store is T {
  return typeof store === 'object' && store !== null && methods.every((method) => typeof (store as Record<string, unknown>)[method] === 'function');
}

export function accountOf(store: unknown): AccountSource | null {
  return has<AccountSource>(store, 'onAccount', 'signedOut', 'retryAccount') ? store : null;
}

export function contextOf(store: unknown): ContextSource | null {
  return has<ContextSource>(store, 'setContext', 'contextOf', 'onContext') ? store : null;
}

export function spaceOf(store: unknown): SpaceSource | null {
  return has<SpaceSource>(store, 'space') ? store : null;
}

/** Every method the functions above look for on a store. */
const EXTRAS = ['onAccount', 'signedOut', 'retryAccount', 'setContext', 'contextOf', 'onContext', 'space'] as const;

/**
 * `wrapped`, carrying the account, context and space methods `inner` has. A wrapper that builds a
 * plain FileStore around a server's store (src/app/keepOnEdit.ts) would otherwise hide them, and a
 * server project opened through it would never say it's signed out or name an Orbit card.
 */
export function withAccountCalls<T extends object>(inner: unknown, wrapped: T): T {
  if (typeof inner !== 'object' || inner === null) return wrapped;
  const from = inner as Record<string, unknown>;
  const to = wrapped as Record<string, unknown>;
  for (const name of EXTRAS) if (typeof from[name] === 'function') to[name] = (from[name] as (...args: unknown[]) => unknown).bind(inner);
  return wrapped;
}

/** Listens to a store's account, if it has one; the stop is a no-op otherwise. */
export function watchAccount(store: unknown, listener: (status: AccountStatus) => void): () => void {
  return accountOf(store)?.onAccount(listener) ?? (() => {});
}

// --- the open server stores ---------------------------------------------------------------------

export type OpenStore = {
  pause(): void;
  resume(): void;
  retryAccount(): Promise<void>;
};

const open = new Set<OpenStore>();

/** A server store is open until it's closed: the stop takes it out of the set. */
export function registerOpenStore(store: OpenStore): () => void {
  open.add(store);
  return () => {
    open.delete(store);
  };
}

/** Every open store lets go of its live feed (the frame is hidden, or the tab has been for a while). */
export function pauseFeeds(): void {
  for (const store of [...open]) store.pause();
}

/** Every open store takes its feed up again, from the cursor it holds, so nothing is missed. */
export function resumeFeeds(): void {
  for (const store of [...open]) store.resume();
}

/** Every signed-out store looks again (the tab is back, the frame is shown, Try again). */
export function retryAccounts(): Promise<void> {
  return Promise.all([...open].map((store) => store.retryAccount())).then(() => undefined);
}
