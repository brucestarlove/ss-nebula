// What a Nebula server answers beyond the FileStore calls, and the messages between a host that
// frames the app (the Suite) and the app: history, removed projects, the account's space, signing
// in. Types only. The server's side is cli/nebula-files.mjs and cli/backend.mjs; how a host uses
// them is docs/hosting.md.
import type { Actor } from './types';

export type { Actor };

/** One kept version of a file. A file keeps its history through renames, so `path` is the path it
 * had when this version was written. */
export type VersionInfo = {
  /** Opaque, the server's own. The current version's is the file's ETag without its quotes. */
  version: string;
  /** When it was written: ISO time with milliseconds. */
  at: string;
  /** Bytes. */
  size: number;
  /** Who wrote it; absent for a write made outside Nebula. */
  actor?: Actor;
  /** The link the writer named (`orbit:card/<board>/<n>`), as given. */
  context?: string;
  /** Whether this is the file as it is now. */
  current: boolean;
  path: string;
  /** On a version made by restoring an earlier one: that one's version. */
  restoredFrom?: string;
};

/** `GET <api>/projects/<id>/versions?path=&limit=&before=`: newest first; `next` is the `before`
 * for the next page, null at the end. */
export type VersionsPage = { versions: VersionInfo[]; next: string | null };

/** A project removed on purpose, restorable until `purgeAfter`. */
export type RemovedProject = {
  id: string;
  name: string;
  color: string;
  /** When it was removed: ISO time. */
  removed: string;
  removedBy?: Actor;
  /** When it goes for good: ISO time. */
  purgeAfter: string;
};

/** The account's space, in `GET <api>/place` as `space`, when the host sets an allowance. */
export type SpaceInfo = {
  /** Bytes the account's current files take (earlier versions aren't counted). */
  used: number;
  /** The allowance in bytes; absent when there is none. */
  limit?: number;
  /** Where the person can get more space, as the host gives it. */
  upgrade?: string;
};

/** A host's answer when the session has ended (401). */
export type SignedOutProblem = { error: 'signed-out'; message: string; signIn?: string };

/** A write that would pass the account's allowance (507). */
export type SpaceFullProblem = { error: 'space-full'; message: string; used: number; limit: number; upgrade?: string };

// --- in a frame ------------------------------------------------------------------------------
// Every message carries `starscape: 1`, and goes only between the app and its own parent window
// on the same origin. The same messages serve Orbit, Nebula, Pulse and games in the Suite.

/** From the host to the app. */
export type HostMessage =
  /** Which keys the host keeps for itself: the app sends them on (`shortcut`) instead of acting. */
  | { starscape: 1; type: 'hello'; shortcuts?: string[] }
  /** The frame is shown or hidden. Hidden, the app lets go of its live connections. */
  | { starscape: 1; type: 'visibility'; visible: boolean }
  /** Open this project and file; `context` is the link its writes then name. */
  | { starscape: 1; type: 'navigate'; project?: string; path?: string; context?: string };

/** From the app to the host. */
export type AppMessage =
  | { starscape: 1; type: 'ready'; app: string; version: string }
  | { starscape: 1; type: 'title'; title: string }
  | { starscape: 1; type: 'shortcut'; key: string }
  /** The session ended: the host signs the person in again (the app keeps unsaved edits). */
  | { starscape: 1; type: 'sign-in' };
