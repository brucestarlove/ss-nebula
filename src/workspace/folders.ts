/**
 * What the workspace does with folders on this computer: pick one,
 * and ask the browser again for one it forgot. Chromium on a desktop has the
 * File System Access API (`showDirectoryPicker`); elsewhere `supported` is
 * false and nothing about folders is shown.
 */
import { indexedDbFolderHandles, type FolderHandleStore } from '../files/folderHandles';
import { requestFolderAccess } from '../files/folderTier';
import type { FolderAccess, FolderHandle } from '../files/types';

export type FolderActions = {
  /** Whether this browser can open a folder on this computer. */
  readonly supported: boolean;
  /** Shows the browser's folder picker: the folder chosen, or null when
   * the picker was cancelled. Call it from a click. */
  pick(): Promise<FolderHandle | null>;
  /** Asks the browser again for a folder project's folder (it shows a
   * prompt, so call it from a click), and says where that leaves it. */
  request(projectId: string): Promise<FolderAccess>;
};

type Picker = (options: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FolderHandle>;

function picker(): Picker | null {
  const found = typeof window !== 'undefined' ? (window as { showDirectoryPicker?: unknown }).showDirectoryPicker : undefined;
  return typeof found === 'function' ? (found as Picker) : null;
}

/** The browser's own: showDirectoryPicker, and the folders the registry
 * keeps in IndexedDB. */
export function browserFolders(handles: FolderHandleStore = indexedDbFolderHandles()): FolderActions {
  return {
    get supported() {
      return picker() !== null;
    },
    async pick() {
      const show = picker();
      if (!show) return null;
      try {
        // `id` lets the browser open the picker where the last one was.
        return await show.call(window, { id: 'nebula-project', mode: 'readwrite' });
      } catch (error) {
        if (error instanceof DOMException && error.name === 'AbortError') return null;
        throw error;
      }
    },
    async request(projectId) {
      return requestFolderAccess(await handles.get(projectId));
    },
  };
}

let shared: FolderActions | null = null;

/** One per page, so every workspace shares it. */
export function defaultFolders(): FolderActions {
  shared ??= browserFolders();
  return shared;
}

/** What a browser without the File System Access API is told, in Help and in
 * New project: where the folder choice is, since it isn't shown there. */
export const FOLDERS_NEED_CHROMIUM = 'To keep a project in a folder on your computer, use Chrome, Edge or Opera on a desktop.';
