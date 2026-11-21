// What the app asks of a store that keeps history (a server project; HttpFileStore): the calls the
// History panel makes, and the shape of a change as the server's log gives it. Types and one
// check, so the workspace never loads the server tier's code to ask.
import type { Actor, FileEntry, FileStore } from './types';
import type { VersionsPage } from './serverContract';

/** One record of the server's log, as `GET <api>/changes` gives it (cli/backend.mjs ChangeRecord). */
export type ChangeRecord = {
  seq: number;
  cursor: string;
  /** ISO time, with milliseconds. */
  at: string;
  project: string;
  type: 'write' | 'mkdir' | 'remove' | 'rename';
  /** For write, mkdir and remove. */
  path?: string;
  /** For rename. */
  from?: string;
  to?: string;
  /** Absent when the change was made outside Nebula. */
  actor?: Actor;
  context?: string;
  /** On a write that restored an earlier version: that one's version. */
  restoredFrom?: string;
};

/** The change a restore asks to replace: the version the caller holds, or a file that is gone. */
export type RestoreCondition = { ifMatch: string } | { ifAbsent: true };

export type HistoryStore = {
  /** A file's versions, newest first; `before` is a page's `next`. */
  versions(path: string, options?: { before?: string; limit?: number }): Promise<VersionsPage>;
  /** The bytes of one version. */
  readVersion(path: string, version: string): Promise<Blob>;
  /** Makes an earlier version the file again; the one it replaces stays in history. */
  restore(path: string, version: string, condition: RestoreCondition): Promise<FileEntry>;
  /** Who changed a path and when, newest first (`GET <api>/changes?project=&path=`): the log every
   * server backend keeps, whether or not it keeps versions. */
  changes(path: string, options?: { limit?: number }): Promise<ChangeRecord[]>;
};

/** A file deleted from a project, as `GET <api>/projects/<id>/deleted` lists it: still restorable
 * from `version`, the last the file had. `deletedBy` is absent when the server doesn't know who. */
export type DeletedFile = {
  path: string;
  /** The version before the delete: what Restore brings back (`restore(path, version, { ifAbsent: true })`). */
  version: string;
  size: number;
  /** When it was deleted: ISO time. */
  deletedAt: string;
  deletedBy?: Actor;
};

/** Newest first; `more` is true when the server held back older ones past `limit`. */
export type DeletedFilesPage = { files: DeletedFile[]; more: boolean };

/** What the app asks of a server that lists deleted files (`capabilities.deletedFiles`). */
export type DeletedFilesStore = {
  deletedFiles(options?: { limit?: number }): Promise<DeletedFilesPage>;
};

export function hasDeletedFiles(store: FileStore | null): store is FileStore & HistoryStore & DeletedFilesStore {
  return hasHistory(store) && typeof (store as Partial<DeletedFilesStore>).deletedFiles === 'function';
}

export function hasHistory(store: FileStore | null): store is FileStore & HistoryStore {
  const candidate = store as Partial<HistoryStore> | null;
  return typeof candidate?.versions === 'function' && typeof candidate.readVersion === 'function' && typeof candidate.restore === 'function' && typeof candidate.changes === 'function';
}

const HISTORY_CALLS = ['versions', 'readVersion', 'restore', 'changes'] as const;

/** `wrapped` with the history calls of the store it wraps, where it has them: a store that wraps a
 * server project's (src/app/keepOnEdit.ts) keeps what only that kind of store can do. */
export function withHistoryCalls(inner: FileStore, wrapped: FileStore): FileStore {
  if (!hasHistory(inner)) return wrapped;
  const calls = wrapped as FileStore & Record<(typeof HISTORY_CALLS)[number], unknown>;
  for (const name of HISTORY_CALLS) calls[name] = inner[name].bind(inner);
  if (hasDeletedFiles(inner)) (wrapped as FileStore & Partial<DeletedFilesStore>).deletedFiles = inner.deletedFiles.bind(inner);
  return wrapped;
}
