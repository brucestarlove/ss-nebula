/**
 * Where the folder tier keeps the folders people picked: the
 * granted directory handles, kept in IndexedDB. A FileSystemDirectoryHandle
 * can be stored in IndexedDB (it's structured-cloneable) and nowhere else, so
 * each is kept there under its project's id. The project's record in
 * registry.json says it's a folder project; the folder itself says which
 * project it is (`.nebula/project.json`).
 *
 * Raw IndexedDB, no library: one database, one object store, keys are
 * project ids.
 */
import type { FolderHandle } from './types';

export interface FolderHandleStore {
  get(id: string): Promise<FolderHandle | null>;
  put(id: string, handle: FolderHandle): Promise<void>;
  delete(id: string): Promise<void>;
}

/** The folders in memory: tests, and a page that can't use IndexedDB. */
export class MemoryFolderHandles implements FolderHandleStore {
  readonly handles = new Map<string, FolderHandle>();

  async get(id: string): Promise<FolderHandle | null> {
    return this.handles.get(id) ?? null;
  }

  async put(id: string, handle: FolderHandle): Promise<void> {
    this.handles.set(id, handle);
  }

  async delete(id: string): Promise<void> {
    this.handles.delete(id);
  }
}

export const FOLDER_DB = 'nebula-folders';
const STORE = 'handles';
const VERSION = 1;

function done<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
  });
}

/** The folders in IndexedDB (`nebula-folders` → `handles`, keyed by project id). */
export function indexedDbFolderHandles(factory: IDBFactory | undefined = typeof indexedDB !== 'undefined' ? indexedDB : undefined, name = FOLDER_DB): FolderHandleStore {
  let opening: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    if (!factory) return Promise.reject(new Error('This browser has no IndexedDB, so Nebula can’t remember folders.'));
    opening ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = factory.open(name, VERSION);
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => {
        const db = request.result;
        // Another tab upgrading later closes this one; the next call reopens.
        db.onversionchange = () => {
          db.close();
          opening = null;
        };
        resolve(db);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB would not open'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
    }).catch((error: unknown) => {
      opening = null;
      throw error;
    });
    return opening;
  };
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    const transaction = db.transaction(STORE, mode);
    const result = done(action(transaction.objectStore(STORE)));
    await new Promise<void>((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'));
      transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction was aborted'));
    });
    return result;
  };
  return {
    async get(id) {
      const value = await run('readonly', (store) => store.get(id) as IDBRequest<unknown>);
      return value && typeof value === 'object' && (value as { kind?: unknown }).kind === 'directory' ? (value as FolderHandle) : null;
    },
    async put(id, handle) {
      await run('readwrite', (store) => store.put(handle, id));
    },
    async delete(id) {
      await run('readwrite', (store) => store.delete(id));
    },
  };
}
