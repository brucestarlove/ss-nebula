/**
 * Contracts shared by the storage layer (src/files) and the workspace UI
 * (src/workspace).
 *
 * Paths are POSIX-style and relative to a project's root, with no leading or
 * trailing slash: 'Guides/Observing plan.md'. The root itself is ''.
 * Each project keeps its own settings in `.nebula/` (like `.obsidian/`):
 * list() hides it, while read and write reach it by path.
 */

export type EntryType = 'file' | 'dir';

export type FileEntry = {
  path: string;
  /** The last path segment. */
  name: string;
  type: EntryType;
  /** Bytes. Files only. */
  size?: number;
  /** Milliseconds since the epoch. Files only, when the store knows it. */
  modified?: number;
};

/** A change to a store. A remove whose path is '' means the project was
 * removed on purpose (or moved to a folder): treat everything in it as
 * gone. A scoped store says so (src/files/scopedStore.ts).
 *
 * `unreachable` and `reachable` are a folder project's folder going out of
 * reach (moved, a drive unplugged, permission taken back) and coming back: nothing in it is gone, so edits stay unsaved and
 * saves wait until it's back. `folder` is the folder's name, to say so. */
export type FileChange =
  | { type: 'write'; path: string }
  | { type: 'mkdir'; path: string }
  | { type: 'remove'; path: string }
  | { type: 'rename'; from: string; to: string }
  | { type: 'unreachable'; folder?: string }
  | { type: 'reachable' }
  /** Move to a folder…, said on the project's channel by the tab moving it
   * (S3): saves wait while it's `moving`; once `moved`, the project opens
   * again from the folder; `move-failed`, it stays here and saves resume. */
  /** A folder project's folder holds more than Nebula shows (S8): it's
   * not looked at again until the page reloads. */
  | { type: 'too-big'; folder?: string }
  | { type: 'moving' }
  | { type: 'moved' }
  | { type: 'move-failed' };

/** A change to a path: every FileChange but a folder's reach. */
export type PathChange = Extract<FileChange, { type: 'write' | 'mkdir' | 'remove' | 'rename' }>;

/** True for a change that names no path: a folder's reach, a move. */
export function isProjectSignal(change: FileChange): change is Exclude<FileChange, PathChange> {
  return change.type === 'unreachable' || change.type === 'reachable' || change.type === 'too-big' || change.type === 'moving' || change.type === 'moved' || change.type === 'move-failed';
}

export type WriteOptions = {
  /** Create the file, never replace one: a conflict copy. */
  exclusive?: boolean;
  /** Write only if the file is still what the caller last saw:
   * `{ text }`, exactly that content, or 'absent', nothing at the path.
   * Checked under the same lock as the write itself, so no other write, in
   * this tab or another, lands between the check and the write. On a
   * mismatch the write rejects with FileChangedError and changes nothing.
   * The content is compared, not the size and time: two writes of one size
   * can land in one millisecond. */
  ifUnchanged?: { text: string } | 'absent';
};

/** One project's files. The browser tier (OPFS) implements it in slice 3;
 * the server tier and the folder tier implement it later. */
export interface FileStore {
  /** Every file and folder under the root except `.nebula/`, sorted by path. */
  list(): Promise<FileEntry[]>;
  /** null when nothing exists at the path. */
  stat(path: string): Promise<FileEntry | null>;
  readText(path: string): Promise<string>;
  readBlob(path: string): Promise<Blob>;
  /** Creates missing parent folders. Replaces the whole file at once, so a
   * reader never sees a half-written file. With `exclusive`, only creates:
   * rejects with FileExistsError when anything exists at the path, checked
   * and written as one step, so two writers (in this tab or another) can't
   * both create the file. With `ifUnchanged`, writes only over what the
   * caller saw; otherwise rejects with FileChangedError (`absent` true when
   * nothing, or a folder, was there instead of the text expected). */
  write(path: string, data: string | Blob, options?: WriteOptions): Promise<void>;
  mkdir(path: string): Promise<void>;
  /** Moves a file or a folder. Rejects when something already exists at `to`. */
  rename(from: string, to: string): Promise<void>;
  /** Removes a file, or a folder and everything in it. */
  remove(path: string): Promise<void>;
  /** Changes made to this project through any store, in this tab or another
   * tab of the same origin. Returns the unsubscribe function. */
  watch(listener: (change: FileChange) => void): () => void;
}

/** What Nebula opens a file as. A plain `.md` can still be a canvas when its
 * content says so (Obsidian Excalidraw frontmatter); see src/files/kinds.ts. */
export type FileKind = 'note' | 'canvas' | 'image' | 'pdf' | 'audio' | 'video' | 'text' | 'other';

/** Where a project's files live: the browser's own storage (OPFS), a
 * folder on this computer the person picked (slice 7; Chromium on a desktop),
 * or a folder on the Nebula server that served the app. */
export type ProjectTier = 'browser' | 'folder' | 'server';

/** Whether Nebula can open a folder project's folder now:
 * - 'granted': it can;
 * - 'prompt': the browser forgot the permission and must ask again, from a click;
 * - 'denied': the person said no;
 * - 'missing': the folder was moved, deleted or is on a drive that isn't
 *   connected, or this browser no longer knows which folder it was. */
export type FolderAccess = 'granted' | 'prompt' | 'denied' | 'missing';

/** The part of a picked folder (FileSystemDirectoryHandle) the folder tier
 * relies on; tests pass a stand-in whose permission they control. */
export type FolderHandle = {
  readonly kind: 'directory';
  readonly name: string;
  queryPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  requestPermission?(descriptor: { mode: 'read' | 'readwrite' }): Promise<PermissionState>;
  isSameEntry?(other: FolderHandle): Promise<boolean>;
};

/** `.nebula/project.json`. It travels with the folder. */
export type ProjectMeta = {
  id: string;
  name: string;
  /** '#rrggbb': the project's planet. */
  color: string;
  /** ISO 8601. */
  created: string;
  /** Who made it: 'nebula' in the browser tier until accounts exist. */
  createdBy: string;
};

/** A project the registry knows, and where it lives. */
export type ProjectRecord = ProjectMeta & {
  tier: ProjectTier;
  /** ISO 8601. */
  lastOpened?: string;
  /** A folder project's folder: its name as the computer shows it, and
   * whether Nebula can open it now. Absent for the browser tier. */
  folder?: { name: string; access: FolderAccess };
  /** A server project: what the server calls itself ('vps-starscape'), and
   * the project's folder there. Absent for the other tiers. */
  server?: { label: string; folder: string };
};

/** What New project and Open a folder… give the registry. With `folder`,
 * the project lives in that folder: one that already holds a
 * `.nebula/project.json` keeps its id, name and colour. */
export type NewProject = {
  name: string;
  color: string;
  folder?: FolderHandle;
  /** With `folder`: Move to a folder…, for this browser project. Every file
   * is copied into the (empty) folder and checked before the project
   * switches to it, keeping its id, and its browser copy is deleted. */
  from?: string;
};

/** `.nebula/workspace.json`: what was open, restored when you come back. */
export type WorkspaceState = {
  /** Open files, in tab order. */
  tabs: string[];
  /** The active tab's path. */
  active: string | null;
  /** Expanded folders. */
  expanded: string[];
  /** Starred files and folders, in the order they were starred. */
  starred: string[];
};

export interface ProjectRegistry {
  /** Most recently opened first. */
  list(): Promise<ProjectRecord[]>;
  create(input: NewProject): Promise<ProjectRecord>;
  /** Opens the project's files and records it as the last one opened. A
   * folder project Nebula can't open now rejects with FolderUnavailableError. */
  open(id: string): Promise<FileStore>;
  update(id: string, patch: Partial<Pick<ProjectMeta, 'name' | 'color'>>): Promise<ProjectRecord>;
  /** A browser project: deletes it and all its files. A folder project:
   * forgets it, and never touches the folder or its files. */
  remove(id: string): Promise<void>;
  /** The project opened last, for startup; null when there are none. */
  current(): Promise<string | null>;
}

/** Per-device preferences (localStorage), never per project: two people
 * opening the same folder keep their own. Theme, background and motion keep
 * their existing keys and hooks in src/nebula/ui. */
export type Preferences = {
  style: 'sheet' | 'pane';
  width: 'fixed' | 'stretch';
  body: 'sans' | 'serif';
  dock: boolean;
};

export const DEFAULT_PREFERENCES: Preferences = {
  style: 'sheet',
  width: 'fixed',
  body: 'sans',
  dock: false,
};

/** A person's first project: what Nebula 1.x's default
 * board is called once it moves in, and what New project suggests while
 * there are no projects, or from the welcome's Start empty. */
export const FIRST_PROJECT_NAME = 'My First Project';

/** Props every file view receives (src/workspace/views). */
export type FileViewProps = {
  /** The project's id: canvases key their Excalidraw library by it. */
  projectId: string;
  store: FileStore;
  /** The open file. */
  entry: FileEntry;
  kind: FileKind;
  /** Text for the status line: '76 words', '29 elements', '1.2 MB'. */
  onStatus?: (text: string) => void;
  /** True while edits are unsaved; the tab shows it. */
  onDirty?: (dirty: boolean) => void;
};
