import { isInside } from '../../../files/paths';
import type { FileStore } from '../../../files/types';

/**
 * Every open file session in this page (canvas scene stores and text
 * sessions), so that:
 *
 * - the workspace can write what's pending under a path, and hold further
 *   writes there, while it renames, moves or deletes it (review findings 1
 *   and 13): nothing is written to a path that is going away;
 * - a session opened while another one is still saving the same file waits
 *   for that save before it reads (finding 2);
 * - the page can tell whether anything isn't saved yet (finding 15).
 *
 * Sessions register themselves; the views never deal with this directly.
 */

/** Which files a session belongs to: the project's id when the view knows
 * it, else the store itself. */
export type SessionScope = string | FileStore;

export type OpenFileSession = {
  readonly scope: SessionScope;
  /** The file's path now: sessions follow renames. */
  path(): string;
  /** Writes what's pending now. */
  flush(): Promise<void>;
  /** Settles once every write this session has queued has finished. */
  idle(): Promise<void>;
  /** True while a change isn't on disk yet. */
  unsaved(): boolean;
};

export type SessionHandle = {
  /** Call whenever unsaved() may have changed. */
  changed(): void;
  /** Forgets the session, once its last write has settled. */
  close(): void;
};

type Hold = { scope: SessionScope; path: string; released: Promise<void> };

const sessions = new Set<OpenFileSession>();
const holds = new Set<Hold>();
const listeners = new Set<() => void>();
let unsavedNow = false;

function recount(): void {
  let next = false;
  for (const session of sessions) {
    if (session.unsaved()) {
      next = true;
      break;
    }
  }
  if (next === unsavedNow) return;
  unsavedNow = next;
  for (const listener of [...listeners]) listener();
}

export function openFileSession(session: OpenFileSession): SessionHandle {
  sessions.add(session);
  return {
    changed: recount,
    close() {
      sessions.delete(session);
      recount();
    },
  };
}

/** True while any open session has a change that isn't on disk yet. */
export function hasUnsavedChanges(): boolean {
  return unsavedNow;
}

export function subscribeUnsaved(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function inScope(scope: SessionScope, match: (session: OpenFileSession) => boolean, except?: OpenFileSession): OpenFileSession[] {
  return [...sessions].filter((session) => session !== except && session.scope === scope && match(session));
}

/** Waits until every listed session's queued writes have settled, including
 * writes they queue meanwhile. */
async function settle(list: () => OpenFileSession[]): Promise<void> {
  let seen: Promise<void>[] = [];
  for (;;) {
    const busy = list().map((session) => session.idle());
    if (busy.length === seen.length && busy.every((promise, index) => promise === seen[index])) return;
    seen = busy;
    await Promise.all(busy.map((promise) => promise.catch(() => {})));
  }
}

/** Settles once no other session of this file has a write queued or in
 * flight: a session opened while another one is still saving the same file
 * reads what that save wrote. */
export function writesSettled(scope: SessionScope, path: string, except?: OpenFileSession): Promise<void> {
  return settle(() => inScope(scope, (session) => session.path() === path, except));
}

/** Settles once no rename, move or delete in this workspace holds the
 * file's path. `path` is read again after each wait: the file may have
 * moved meanwhile. */
export async function writeAllowed(scope: SessionScope, path: () => string): Promise<void> {
  for (;;) {
    const hold = [...holds].find((candidate) => candidate.scope === scope && isInside(path(), candidate.path));
    if (!hold) return;
    await hold.released;
  }
}

/** True while a rename, move or delete in this workspace holds the file at
 * `path`: a change heard now was made in this tab (round 4, F5). */
export function heldHere(scope: SessionScope, path: string): boolean {
  return [...holds].some((hold) => hold.scope === scope && isInside(path, hold.path));
}

/** Before renaming, moving or deleting `path` (a file or a folder): writes
 * what the sessions at or under it have pending (unless `flush` is false, as
 * for a delete), waits for their writes in flight, and then holds their
 * writes until the returned release() is called. Call it once the store is
 * done, whether it succeeded or not. */
export async function holdWrites(scope: SessionScope, path: string, options: { flush?: boolean } = {}): Promise<() => void> {
  const under = () => inScope(scope, (session) => isInside(session.path(), path));
  if (options.flush !== false) await Promise.all(under().map((session) => session.flush().catch(() => {})));
  await settle(under);
  let release!: () => void;
  const hold: Hold = { scope, path, released: new Promise<void>((resolve) => (release = resolve)) };
  holds.add(hold);
  return () => {
    if (!holds.delete(hold)) return;
    release();
  };
}

/** A change held in a conflict when its view closed, kept beside the file
 * (re-review R1): `copy` is where. Or null with `error` when it couldn't be
 * written (round 4, F2): `download` is the change as the copy would have
 * been, its name and its text in the file's own format, for the user to
 * save. The session stays unsaved, so closing the page still asks, until
 * `release()`: call it once the user has downloaded it or chosen not to. */
export type KeptCopy =
  /** `deleted`: another tab deleted the file, and the copy is where it was. */
  | { scope: SessionScope; path: string; copy: string; deleted?: true }
  | {
      scope: SessionScope;
      path: string;
      copy: null;
      error: unknown;
      download: { filename: string; text: string };
      release: () => void;
    };

const keptListeners = new Set<(copy: KeptCopy) => void>();

/** Sessions call this for each copy they keep; the workspace says so. */
export function reportKeptCopy(copy: KeptCopy): void {
  for (const listener of [...keptListeners]) listener(copy);
}

export function subscribeKeptCopies(listener: (copy: KeptCopy) => void): () => void {
  keptListeners.add(listener);
  return () => {
    keptListeners.delete(listener);
  };
}
