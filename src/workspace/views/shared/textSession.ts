import { blobToBytes } from '../../../files/bytes';
import { watchAccount } from '../../../files/account';
import { errorName, type FileChangedError } from '../../../files/errors';
import { basename, isInside } from '../../../files/paths';
import type { FileChange, FileEntry, FileStore } from '../../../files/types';
import { conflictCopyName, writeConflictCopy } from './conflictCopy';
import { FolderUnreachableError, carryEdit, claimCarried, heldHere, openFileSession, reportKeptCopy, writeAllowed, writesSettled, type OpenFileSession, type SessionScope } from './fileSessions';
export { unreachableMessage } from './fileSessions';

/**
 * One open text file: what the editor holds, what's on disk, and the rules
 * between them:
 *
 * - edits save 500 ms after the last keystroke, and at once on flush();
 * - a change made elsewhere (store.watch) reloads when nothing is unsaved,
 *   and otherwise waits for "Reload" or "Keep mine", never saving over it;
 * - the bytes it doesn't change stay as they were: a file that isn't UTF-8
 *   opens read-only, and a file with CRLF line ends keeps them;
 * - the session follows a rename of the file or of any folder above it,
 *   never writes a removed file back, and waits while the workspace renames,
 *   moves or deletes it (fileSessions.ts).
 *
 * Framework-free; useTextSession binds it to React.
 */
export type TextSessionState = {
  status: 'loading' | 'ready' | 'error';
  /** What the editor holds. */
  text: string;
  /** True while `text` isn't on disk yet. */
  dirty: boolean;
  /** Changed elsewhere while edits were unsaved: waiting for Reload or Keep mine. */
  conflict: boolean;
  /** The file was deleted; nothing more is written. */
  removed: boolean;
  /** The folder the file is in can't be reached right now (S2): its name
   * ('' when unknown), or null. Edits stay unsaved and are saved once it's
   * back. */
  unreachable: string | null;
  /** Another tab is moving the project to a folder (S3): saves wait. */
  moving: boolean;
  /** The file isn't UTF-8 text: `text` shows it as well as it can, and
   * nothing is ever written, since saving would change its bytes. */
  readOnly: boolean;
  /** Why the file couldn't be read (status 'error'). */
  error?: unknown;
  /** Why the last save failed; cleared by the next good save. */
  saveError?: unknown;
  /** When the file last changed, as far as this session knows. */
  modified?: number;
  /** Counts the times `text` was replaced from disk (load, reload), so an
   * editor knows to take it; edits don't count. */
  revision: number;
};

export type TextSession = {
  /** Settles once the first read finishes, well or badly. */
  readonly ready: Promise<void>;
  getState(): TextSessionState;
  subscribe(listener: () => void): () => void;
  /** The editor's new text. Schedules a save. */
  edit(text: string): void;
  /** Saves now if anything is unsaved (leaving the tab, hiding the page). */
  flush(): Promise<void>;
  /** "Reload": drop unsaved edits and take what's on disk. */
  reload(): Promise<void>;
  /** "Keep mine": write the editor's text over the change made elsewhere. */
  keepMine(): Promise<void>;
  /** Flushes and stops listening. */
  dispose(): Promise<void>;
};

export type TextSessionOptions = {
  /** Quiet time after the last edit before saving. */
  saveDelayMs?: number;
  /** Which project the file belongs to (its id), so sessions of the same
   * file, and the workspace's renames and deletes, find each other. Defaults
   * to the store. */
  scope?: SessionScope;
  /** How long a save that found its file gone waits for the rename before
   * it looks again, and, still gone, shows the file as deleted elsewhere
   * (H7). */
  goneCheckMs?: number;
};

export const SAVE_DELAY_MS = 500;
/** Another tab's rename reaches this one within milliseconds; a file still
 * gone after this long was deleted or moved out of reach (H7). */
export const GONE_CHECK_MS = 2000;

const strictUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const lossyUtf8 = new TextDecoder('utf-8', { ignoreBOM: true });

/** The file's text, and whether its bytes are UTF-8 (when they aren't, the
 * text has U+FFFD where they didn't decode). A byte-order mark is kept. The
 * bytes are checked only when the text has a U+FFFD, which is rare. */
export async function readFileText(store: FileStore, path: string): Promise<{ text: string; utf8: boolean }> {
  const text = await store.readText(path);
  if (!text.includes('\uFFFD')) return { text, utf8: true };
  const bytes = await blobToBytes(await store.readBlob(path));
  try {
    return { text: strictUtf8.decode(bytes), utf8: true };
  } catch {
    return { text: lossyUtf8.decode(bytes), utf8: false };
  }
}

/** CRLF when every line end in the text is CRLF; otherwise LF, which is
 * also what editors hand back. */
export function lineBreakOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') && !/(?:^|[^\r])\n/.test(text) ? '\r\n' : '\n';
}

export function createTextSession(store: FileStore, initialPath: string, options: TextSessionOptions = {}): TextSession {
  const saveDelayMs = options.saveDelayMs ?? SAVE_DELAY_MS;
  const goneCheckMs = options.goneCheckMs ?? GONE_CHECK_MS;
  const scope = options.scope ?? store;
  let path = initialPath;
  let state: TextSessionState = { status: 'loading', text: '', dirty: false, conflict: false, removed: false, unreachable: null, moving: false, readOnly: false, revision: 0 };
  /** The text known to be on disk. */
  let saved = '';
  /** The file's line end: edits come back with it (an editor hands back \n). */
  let lineBreak: '\r\n' | '\n' = '\n';
  /** The text being written right now, so its echo isn't mistaken for a change. */
  let inFlight: string | null = null;
  /** The file's text as this session last saw it at its path: written, or
   * read and accepted. Every write expects exactly this, so a save
   * from another tab landing after the check is refused, never overwritten. */
  let known = '';
  /** The text a write put at the path the file was renamed from, which the
   * rename may have carried to where it is now: its own, too. Only an
   * optimisation since round 5: a mistake here can only show a conflict. */
  let carried: string | null = null;
  /** A write found the file gone (moved or deleted elsewhere) before this
   * session heard of it: the edit waits for the rename (or the delete). */
  let awaitingMove = false;
  /** Reload has begun: the edit it drops is never written, also by a write
   * queued meanwhile (a rename's re-aim, a flush). */
  let reloading = false;
  /** What was found on disk when a conflict began. */
  let theirs: string | null = null;
  /** The file's size and time when this session last read or wrote it;
   * null when it doesn't know. */
  let seen: Pick<FileEntry, 'size' | 'modified'> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** Looks again at a file a save found gone (H7). */
  let goneTimer: ReturnType<typeof setTimeout> | null = null;
  /** Every write, one after another; it never rejects. */
  let writing: Promise<void> = Promise.resolve();
  /** dispose() has begun: changes made elsewhere aren't taken any more, but
   * renames and deletes still are until the last write is done. */
  let closing = false;
  /** Removed by another tab (not by this one, nor with its project): an
   * edit not saved yet is written beside where the file was when the view
   * goes. */
  let deletedElsewhere = false;
  /** The folder is out of reach (S2): nothing is written until it's back. */
  let paused = false;
  /** `removed` was set by the gone check, not by a delete heard: a folder
   * going out of reach looks the same to a stat, so it's undone if
   * `unreachable` follows. */
  let removedByGoneCheck = false;
  /** The project is moving to a folder (S3): nothing is written meanwhile. */
  let moving = false;
  /** It moved: an edit still unsaved goes with it (carryEdit). */
  let movedAway = false;
  /** Writes wait: the folder is out of reach, or the project is moving. */
  const waiting = () => paused || moving;
  const listeners = new Set<() => void>();

  const session: OpenFileSession = {
    scope,
    path: () => path,
    flush: () => flush(),
    idle: () => writing,
    unsaved: () => state.dirty,
  };
  const handle = openFileSession(session);

  const update = (patch: Partial<TextSessionState>) => {
    state = { ...state, ...patch };
    state.dirty = state.status === 'ready' && state.text !== saved;
    for (const listener of [...listeners]) listener();
    handle.changed();
  };

  const cancelTimer = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };

  const cancelGoneTimer = () => {
    if (goneTimer !== null) clearTimeout(goneTimer);
    goneTimer = null;
  };

  /** A write found the file gone, and no rename has been heard: the edit
   * waits for one. If none comes and the file is still gone a little later,
   * it was deleted (or moved out of reach) elsewhere: say so, and keep the
   * edit for a copy where it was. */
  const awaitMove = () => {
    awaitingMove = true;
    if (goneTimer !== null) return;
    goneTimer = setTimeout(() => {
      goneTimer = null;
      void (async () => {
        if (!awaitingMove || closing || state.removed || waiting()) return;
        const target = path;
        const now = await store.stat(target).catch(() => undefined);
        if (now !== null || !awaitingMove || closing || state.removed || waiting() || path !== target) return;
        awaitingMove = false;
        deletedElsewhere = true;
        removedByGoneCheck = true;
        cancelTimer();
        update({ removed: true });
      })();
    }, goneCheckMs);
  };

  // Another session of this file may still be saving it (a tab closed and
  // opened again at once): read what that save writes, not what was there.
  const ready = writesSettled(scope, path, session)
    .then(async () => {
      // The stat first: a change landing between the two shows as one.
      seen = await store.stat(path).catch(() => null);
      return readFileText(store, path);
    })
    .then(
      ({ text, utf8 }) => {
        saved = text;
        known = text;
        lineBreak = lineBreakOf(text);
        update({ status: 'ready', text, readOnly: !utf8, error: undefined, revision: state.revision + 1 });
        // An edit that came with the project from where it was (S3): saved
        // over the bytes it was made on, else asked about.
        const brought = utf8 ? claimCarried(scope, path) : null;
        if (brought) {
          update({ text: brought.text });
          if (text === brought.base) schedule();
          else startConflict(text);
          brought.done();
        }
      },
      (error: unknown) => {
        update({ status: 'error', error });
      },
    );

  const checkDisk = async () => {
    await ready;
    // A change heard while this session's own write is in flight is judged
    // once that write has landed or failed: landed, and nothing else unsaved,
    // the change is simply taken, never a conflict with nothing to keep (round
    // 6, found by the long interleaving run).
    for (let last = writing; ; last = writing) {
      await last;
      if (last === writing) break;
    }
    if (closing || state.status !== 'ready' || state.removed) return;
    let disk: string;
    let utf8: boolean;
    try {
      ({ text: disk, utf8 } = await readFileText(store, path));
    } catch {
      return;
    }
    if (closing) return;
    // Its own write's echo, also when the rename carried it (G5).
    if (disk === saved || disk === inFlight || disk === carried) return;
    seen = null;
    if (disk === state.text) {
      saved = disk;
      known = disk;
      update({ modified: Date.now(), readOnly: !utf8 });
      return;
    }
    if (!state.dirty && inFlight === null) {
      saved = disk;
      known = disk;
      lineBreak = lineBreakOf(disk);
      // Nothing of this session's is unsaved: there's nothing to ask about.
      theirs = null;
      update({ text: disk, readOnly: !utf8, conflict: false, modified: Date.now(), revision: state.revision + 1 });
      return;
    }
    startConflict(disk);
  };

  /** Every check of the disk, one after another, so an older read never
   * applies after a newer one. */
  let checking: Promise<void> = Promise.resolve();
  const check = () => {
    const run = () => checkDisk();
    checking = checking.then(run, run);
  };

  /** Changed elsewhere while edits are unsaved: ask. `disk` is the file's
   * text as found (null: gone, or not known). */
  const startConflict = (disk: string | null) => {
    theirs = disk;
    // What was carried belongs to before the conflict (G6).
    carried = null;
    cancelTimer();
    update({ conflict: true });
  };

  const onChange = (change: FileChange) => {
    if (change.type === 'unreachable') {
      // Not removed (S2): the edit stays, unsaved, until the folder is back.
      paused = true;
      cancelTimer();
      if (removedByGoneCheck) {
        // That "gone" was this folder going out of reach.
        removedByGoneCheck = false;
        deletedElsewhere = false;
        awaitingMove = true;
        update({ removed: false, unreachable: change.folder ?? '' });
      } else update({ unreachable: change.folder ?? '' });
      return;
    }
    if (change.type === 'reachable') {
      if (!paused) return;
      paused = false;
      awaitingMove = false;
      cancelGoneTimer();
      update({ unreachable: null });
      // Through the normal path: a file changed on disk meanwhile is a conflict.
      if (state.dirty && !closing && !waiting()) void queueWrite();
      return;
    }
    if (change.type === 'moving') {
      moving = true;
      cancelTimer();
      update({ moving: true });
      return;
    }
    if (change.type === 'move-failed') {
      if (!moving) return;
      moving = false;
      update({ moving: false });
      if (state.dirty && !closing && !waiting()) void queueWrite();
      return;
    }
    if (change.type === 'moved') {
      // The workspace opens the project again from the folder; this view
      // goes, and what it holds unsaved goes with it.
      movedAway = true;
      return;
    }
    if (change.type === 'rename') {
      // The file itself, or a folder above it.
      if (isInside(path, change.from)) {
        path = change.to + path.slice(change.from.length);
        // A change heard just before it may have failed its read at the old
        // path: look at the file where it is now (N2). Only look: after an
        // ABA landing the change stays in the new file at the old path, and
        // nothing is written here on a guess (N5, R7-1).
        check();
        // A write that found the file gone was waiting for this.
        if (awaitingMove) {
          awaitingMove = false;
          cancelGoneTimer();
          void queueWrite();
        }
      }
    } else if (change.type === 'remove' && (change.path === '' || isInside(path, change.path))) {
      // A delete made here holds this session's writes, and means to drop
      // the edit; so does the project going.
      deletedElsewhere = change.path !== '' && !heldHere(scope, path);
      removedByGoneCheck = false;
      awaitingMove = false;
      cancelGoneTimer();
      cancelTimer();
      update({ removed: true });
    } else if (change.type === 'write' && change.path === path) {
      check();
    }
  };
  const unwatch = store.watch(onChange);
  // The session ended and is back: an edit a refused save kept is saved now, by the normal path
  // (a file changed meanwhile is asked about, never written over). Nothing was dropped or marked
  // saved when the save was refused, so there's nothing to rebuild.
  const unaccount = watchAccount(store, (status) => {
    if (status === 'signed-in' && state.dirty && state.saveError !== undefined && !closing && !waiting()) void queueWrite();
  });

  /** The file as it is now (null: gone) when it isn't what this session
   * last saw, else undefined. Another tab's save or delete can land before
   * its message does, and a write now would silently undo it. Cheap when
   * nothing changed: one stat. */
  const changedElsewhere = async (target: string): Promise<string | null | undefined> => {
    let now: FileEntry | null;
    try {
      now = await store.stat(target);
    } catch {
      return undefined;
    }
    if (now === null) return null;
    if (seen && now.size === seen.size && now.modified === seen.modified) return undefined;
    let disk: string;
    try {
      disk = await store.readText(target);
    } catch {
      return undefined;
    }
    if (disk === saved || disk === state.text || disk === carried) {
      known = disk;
      seen = now;
      return undefined;
    }
    return disk;
  };

  /** One write, decided when its turn comes: where the file is then, and
   * nothing at all once it's deleted or changed elsewhere. It writes only
   * over the text its check accepted. */
  const writeOnce = async (): Promise<void> => {
    // A rename, move or delete in this workspace holds writes until it's done.
    await writeAllowed(scope, () => path);
    for (let attempt = 1; ; attempt += 1) {
      if (waiting() || reloading || state.status !== 'ready' || state.removed || state.conflict || state.readOnly) return;
      if (state.text === saved) return;
      const target = path;
      const disk = await changedElsewhere(target);
      if (disk === null && !closing && !state.removed && path === target) {
        // Moved or deleted elsewhere, not heard about yet: the edit waits
        // for the rename (or is kept for a copy on the delete).
        awaitMove();
        return;
      }
      if (disk !== undefined && path === target) {
        // Changed (or, closing, gone) elsewhere: ask, as for a change heard about.
        if (!state.removed) startConflict(disk);
        return;
      }
      if (state.removed || state.conflict || path !== target) {
        if (path !== target) void queueWrite();
        return;
      }
      const text = state.text;
      if (text === saved || reloading) return;
      const expected = known;
      inFlight = text;
      try {
        await store.write(target, text, { ifUnchanged: { text: expected } });
      } catch (saveError: unknown) {
        if (errorName(saveError) === 'FileChangedError') {
          // Not what the check saw: it changed in between (or went).
          seen = null;
          if (path !== target) {
            void queueWrite();
            return;
          }
          if ((saveError as FileChangedError).absent) {
            // Moved or deleted elsewhere, not heard about yet. Closing, it
            // can't wait: it's kept as a copy now.
            if (closing) startConflict(null);
            else awaitMove();
            return;
          }
          // The check decides again: its own text in other hands, or a conflict.
          if (attempt < 3) continue;
          startConflict(await store.readText(target).catch(() => null));
          return;
        }
        update({ saveError });
        return;
      } finally {
        inFlight = null;
      }
      if (path !== target) {
        // Renamed while the write was in flight, so it landed where the file
        // was: write it again where the file is now. A rename in another tab
        // waits for this write and carries the text there: it's this
        // session's own, not a change made elsewhere.
        carried = text;
        void queueWrite();
        return;
      }
      saved = text;
      known = text;
      carried = null;
      seen = await store.stat(target).catch(() => null);
      update({ saveError: undefined, modified: Date.now() });
      return;
    }
  };

  /** Queues a write of what's unsaved, after the writes before it. */
  const queueWrite = (): Promise<void> => {
    cancelTimer();
    const run = writing.then(() => ready).then(writeOnce);
    writing = run;
    return run;
  };

  /** Writes what's unsaved and settles once the writes stop changing: a
   * write aimed again after a rename is queued after this one (re-review
   * R8). */
  const flush = async (): Promise<void> => {
    await queueWrite();
    for (let last = writing; ; last = writing) {
      await last;
      if (last === writing) return;
    }
  };

  /** On dispose, in a conflict or deleted by another tab: writes the
   * editor's text beside the file (or where it was) and reports it. False
   * when it couldn't. */
  const keepConflictCopy = async (): Promise<boolean> => {
    if (!state.dirty || state.readOnly) return true;
    if (state.removed ? !deletedElsewhere : !state.conflict) return true;
    const text = state.text;
    try {
      await writeAllowed(scope, () => path);
      const original = path;
      const copy = await writeConflictCopy(store, original, text);
      saved = text;
      update({ conflict: false });
      reportKeptCopy(state.removed ? { scope, path: original, copy, deleted: true } : { scope, path: original, copy });
      return true;
    } catch (error: unknown) {
      // Not written: hand the edit to the user as a download.
      const download = { filename: conflictCopyName(path, [], new Date()), text };
      reportKeptCopy({ scope, path, copy: null, error, download, release: () => handle.close() });
      return false;
    }
  };

  /** On dispose, an edit still unsaved after the flush, with no conflict and
   * no delete elsewhere: its write failed (a full store, an I/O error). It's
   * handed to the user as a download under the file's own name, and the
   * page keeps warning until they take it or let it go (H3). */
  const offerFailedSave = () => {
    const error = paused ? new FolderUnreachableError(state.unreachable ?? '') : (state.saveError ?? new Error('The change could not be saved.'));
    reportKeptCopy({ scope, path, copy: null, error, download: { filename: basename(path), text: state.text }, failedSave: true, release: () => handle.close() });
  };

  const schedule = () => {
    cancelTimer();
    if (!state.dirty || state.conflict || state.removed || waiting()) return;
    timer = setTimeout(() => {
      timer = null;
      void queueWrite();
    }, saveDelayMs);
  };

  return {
    ready,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    edit(edited) {
      if (closing || state.status !== 'ready' || state.readOnly) return;
      // The file's own line ends, whatever the editor hands back.
      const text = lineBreak === '\r\n' ? edited.replace(/\r?\n/g, '\r\n') : edited;
      if (text === state.text) return;
      update({ text });
      schedule();
    },
    flush,
    async reload() {
      cancelTimer();
      // Only a write already in flight lands (and is read below); nothing
      // queued meanwhile (a rename's re-aim, a flush) writes the edit Reload
      // drops.
      reloading = true;
      let failed = false;
      try {
        for (let last = writing; ; last = writing) {
          await last;
          if (last === writing) break;
        }
        let disk: string;
        let utf8: boolean;
        try {
          ({ text: disk, utf8 } = await readFileText(store, path));
        } catch (error) {
          failed = true;
          update({ saveError: error });
          return;
        }
        saved = disk;
        known = disk;
        lineBreak = lineBreakOf(disk);
        theirs = null;
        // What was carried belongs to before (G6).
        carried = null;
        seen = null;
        awaitingMove = false;
        cancelGoneTimer();
        update({ text: disk, readOnly: !utf8, conflict: false, modified: Date.now(), revision: state.revision + 1 });
      } finally {
        reloading = false;
        // An edit made while it read is saved as any other: its own timer
        // came while Reload held writes (N7).
        if (failed) schedule();
      }
    },

    async keepMine() {
      // Mine goes over the change the bar showed, and only that: a change
      // landing after it is asked about again.
      if (theirs !== null) {
        saved = theirs;
        known = theirs;
      }
      theirs = null;
      carried = null;
      seen = null;
      update({ conflict: false });
      await flush();
    },
    async dispose() {
      if (closing) return;
      closing = true;
      cancelGoneTimer();
      await flush();
      // An edit held in a conflict isn't dropped: it goes beside the file
      // (re-review R1). Nothing unsaved (Reload, say), no copy.
      const kept = await keepConflictCopy();
      unwatch();
      unaccount();
      listeners.clear();
      // A copy that couldn't be written stays unsaved, so the page still asks.
      if (!kept) return;
      // The project moved to a folder with this edit unsaved: it goes with
      // it, to the session that opens the file there (S3).
      if (movedAway && typeof scope === 'string' && state.dirty && !state.readOnly && !state.removed && !state.conflict) {
        carryEdit(scope, path, { text: state.text, base: known });
        handle.close();
        return;
      }
      // Still unsaved with no conflict and no delete elsewhere: the write failed.
      if (state.dirty && !state.readOnly && !state.removed && !state.conflict) {
        offerFailedSave();
        return;
      }
      handle.close();
    },
  };
}
