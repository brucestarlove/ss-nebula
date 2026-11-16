import { basename, isInside } from '../../../files/paths';
import type { FileStore } from '../../../files/types';

/**
 * Every open file session in this page (canvas scene stores and text
 * sessions), so that:
 *
 * - the workspace can write what's pending under a path, and hold further
 *   writes there, while it renames, moves or deletes it: nothing is written to a path that is going away;
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

/** True while an open session of the file at `path` (in this project) has a change that isn't on disk yet. */
export function hasUnsavedAt(scope: SessionScope, path: string): boolean {
  return [...sessions].some((session) => session.scope === scope && session.path() === path && session.unsaved());
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

/** Sessions opened before `session`, oldest first (a Set keeps its order). */
function openedBefore(session: OpenFileSession): Set<OpenFileSession> {
  const before = new Set<OpenFileSession>();
  for (const other of sessions) {
    if (other === session) break;
    before.add(other);
  }
  return before;
}

/** Settles once no session of this file opened before `except` has a write
 * queued or in flight: a session opened while another one is still saving
 * the same file reads what that save wrote. Only older sessions count: two
 * sessions each waiting for the other's writes would never settle (round 6,
 * close and reopen twice). */
export function writesSettled(scope: SessionScope, path: string, except?: OpenFileSession): Promise<void> {
  const older = except && sessions.has(except) ? openedBefore(except) : null;
  return settle(() => inScope(scope, (session) => session.path() === path && (older === null || older.has(session)), except));
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
 * `path`: a change heard now was made in this tab. */
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
 * written: `download` is the change as the copy would have
 * been, its name and its text in the file's own format, for the user to
 * save. `failedSave`: there was no conflict, the change's own save failed
 * as the view closed, and `download` has the file's own name.
 * The session stays unsaved, so closing the page still asks, until
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
      failedSave?: true;
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

/** A session closed while its folder was out of reach: its edit is kept as
 * a download, and this says why (S2). */
export class FolderUnreachableError extends Error {
  constructor(folder: string) {
    super(unreachableMessage(folder));
    this.name = 'FolderUnreachableError';
  }
}

/** What a view says while its folder is out of reach (S2). */
export function unreachableMessage(folder: string): string {
  return `Nebula can’t reach the folder ${folder ? `‘${folder}’` : 'this project is in'} right now. Your changes are kept here and saved when it’s back.`;
}

/** An edit a session held when its project moved to a folder (S3), waiting
 * for the session that opens the file from the folder. */
export type CarriedEdit = { text: string; base: string; done: () => void };

/** How long a carried edit waits for its file to open again before it's
 * offered as a download instead. */
export const CARRY_MS = 10_000;

const carried = new Map<string, CarriedEdit>();
const carryKey = (scope: string, path: string) => `${scope}\n${path}`;

/** Keeps an edit for the session that opens `path` in the project's new
 * home: the page stays unsaved until one takes it, and if none does within
 * CARRY_MS, it's offered as a download, never dropped. */
export function carryEdit(scope: string, path: string, edit: { text: string; base: string }): void {
  const key = carryKey(scope, path);
  // idle() gives the same promise each time: settle() waits until they stop changing.
  const settled = Promise.resolve();
  const handle = openFileSession({ scope, path: () => path, flush: () => settled, idle: () => settled, unsaved: () => true });
  handle.changed();
  const entry: CarriedEdit = {
    ...edit,
    done: () => {
      clearTimeout(timer);
      handle.close();
    },
  };
  const timer = setTimeout(() => {
    if (carried.get(key) !== entry) return;
    carried.delete(key);
    reportKeptCopy({
      scope,
      path,
      copy: null,
      error: new Error('The project moved to a folder before this change was saved.'),
      download: { filename: basename(path), text: edit.text },
      failedSave: true,
      release: () => handle.close(),
    });
  }, CARRY_MS);
  carried.get(key)?.done();
  carried.set(key, entry);
}

/** The edit carried for `path`, taken: call done() once it's applied. */
export function claimCarried(scope: SessionScope, path: string): CarriedEdit | null {
  if (typeof scope !== 'string') return null;
  const key = carryKey(scope, path);
  const entry = carried.get(key) ?? null;
  carried.delete(key);
  return entry;
}
