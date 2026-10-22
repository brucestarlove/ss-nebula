/**
 * The harness pages' store wrappers, in a module of their own so the unit
 * suite runs the write-option conformance cases through them
 * (src/files/wrappers.test.ts). Each forwards a call's arguments whole: a
 * wrapper that names them drops the ones added later, as `{ exclusive }` was
 * (round 5, G4), and TypeScript accepts the narrower function.
 */
import type { FileStore } from '../../src/files/types';

/** What the workspace asked of its stores, in order. */
export type StoreCall = { op: 'write' | 'list' | 'rename' | 'remove'; path: string; to?: string; at: number };

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The sessions harness: logs the store's calls into `calls`; `slow` holds
 * each write back that long first, so a save is still in flight when the
 * next step comes. Changes `store` in place, which the registry hands on. */
export function instrumentStore(store: FileStore, calls: StoreCall[], slow = 0): FileStore {
  const { write, list, rename, remove } = store;
  store.write = async (...args) => {
    calls.push({ op: 'write', path: args[0], at: performance.now() });
    if (slow > 0) await delay(slow);
    return write.apply(store, args);
  };
  store.list = async (...args) => {
    calls.push({ op: 'list', path: '', at: performance.now() });
    return list.apply(store, args);
  };
  store.rename = async (...args) => {
    calls.push({ op: 'rename', path: args[0], to: args[1], at: performance.now() });
    return rename.apply(store, args);
  };
  store.remove = async (...args) => {
    calls.push({ op: 'remove', path: args[0], at: performance.now() });
    return remove.apply(store, args);
  };
  return store;
}

/** The storage harness: a store whose writes first run `before`, which can
 * count them, slow them, or (false) leave them hanging, as when the tab
 * closes mid-write. */
export function beforeWrites(store: FileStore, before: () => Promise<boolean> | boolean): FileStore {
  return {
    list: (...args) => store.list(...args),
    stat: (...args) => store.stat(...args),
    readText: (...args) => store.readText(...args),
    readBlob: (...args) => store.readBlob(...args),
    mkdir: (...args) => store.mkdir(...args),
    rename: (...args) => store.rename(...args),
    remove: (...args) => store.remove(...args),
    watch: (...args) => store.watch(...args),
    async write(...args) {
      if (!(await before())) return new Promise<void>(() => {});
      return store.write(...args);
    },
  };
}
