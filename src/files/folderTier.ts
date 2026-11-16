/**
 * The folder tier's pieces the registry uses: where the
 * picked folders are kept, how a folder becomes a FileStore, and whether
 * Nebula can open one now.
 */
import { errorName } from './errors';
import type { FolderHandleStore } from './folderHandles';
import type { FileStore, FolderAccess, FolderHandle } from './types';

export type FolderTier = {
  /** The picked folders, by project id (IndexedDB in the browser). */
  handles: FolderHandleStore;
  /** The project's files in that folder. */
  store(handle: FolderHandle, id: string): FileStore | Promise<FileStore>;
  /** Whether the folder is still there, asked once Nebula has permission.
   * Defaults to reading its first entry. */
  exists?(handle: FolderHandle): Promise<boolean>;
};

/** A folder project Nebula can't open now: the browser needs the person's
 * OK again ('prompt'), they said no ('denied'), or the folder is gone. */
export class FolderUnavailableError extends Error {
  readonly access: Exclude<FolderAccess, 'granted'>;

  constructor(folder: string, access: Exclude<FolderAccess, 'granted'>) {
    super(
      access === 'missing'
        ? `The folder ‘${folder}’ isn’t where it was`
        : access === 'denied'
          ? `This browser isn’t allowed to open the folder ‘${folder}’`
          : `This browser needs your OK to open the folder ‘${folder}’ again`,
    );
    this.name = 'FolderUnavailableError';
    this.access = access;
  }
}

const READWRITE = { mode: 'readwrite' } as const;

type Listable = FolderHandle & { keys?: () => AsyncIterableIterator<string> };

/** Whether a folder is still there: reading its first entry throws
 * NotFoundError once it was moved or deleted, or its drive is gone. */
export async function folderExists(handle: FolderHandle): Promise<boolean> {
  const keys = (handle as Listable).keys;
  if (typeof keys !== 'function') return true;
  try {
    const iterator = keys.call(handle);
    await iterator.next();
    await iterator.return?.();
    return true;
  } catch (error) {
    if (errorName(error) === 'NotFoundError' || errorName(error) === 'NotReadableError' || errorName(error) === 'InvalidStateError') return false;
    throw error;
  }
}

/** Whether Nebula can open the folder now, without asking anyone. */
export async function folderAccess(handle: FolderHandle | null, exists: (handle: FolderHandle) => Promise<boolean> = folderExists): Promise<FolderAccess> {
  if (!handle) return 'missing';
  let state: PermissionState = 'granted';
  if (typeof handle.queryPermission === 'function') {
    try {
      state = await handle.queryPermission(READWRITE);
    } catch (error) {
      // Chrome throws for a handle whose folder is gone.
      if (errorName(error) === 'NotFoundError') return 'missing';
      throw error;
    }
  }
  if (state !== 'granted') return state;
  return (await exists(handle).catch(() => false)) ? 'granted' : 'missing';
}

/** Asks the browser again for a folder's permission. It shows a prompt, so
 * call it from a click. */
export async function requestFolderAccess(handle: FolderHandle | null, exists: (handle: FolderHandle) => Promise<boolean> = folderExists): Promise<FolderAccess> {
  if (!handle) return 'missing';
  if (typeof handle.requestPermission === 'function') {
    let state: PermissionState;
    try {
      state = await handle.requestPermission(READWRITE);
    } catch (error) {
      if (errorName(error) === 'NotFoundError') return 'missing';
      throw error;
    }
    if (state !== 'granted') return state;
  }
  return folderAccess(handle, exists);
}

/** OS metadata files, compared in lower case. */
const OS_FILES = new Set(['thumbs.db', 'desktop.ini']);

/** The names the folder tier never lists, watches, shows or counts, nor
 * asks for their details (S1, S8): dot-entries (`.git`, `.obsidian`,
 * `.DS_Store`, Nebula's own `.nebula-write-*`), `node_modules`, Windows'
 * `Thumbs.db` and `desktop.ini`, and Chrome's `*.crswap`. The root's
 * `.nebula` is reached by path, as ever. */
export function isSkippedInFolder(name: string): boolean {
  return name.startsWith('.') || name.endsWith('.crswap') || name === 'node_modules' || OS_FILES.has(name.toLowerCase());
}

/** A path with a skipped name in it. */
export function isSkippedPathInFolder(path: string): boolean {
  return path.split('/').some(isSkippedInFolder);
}
