/**
 * Asking the browser to keep Nebula's files (persistent storage).
 * Firefox shows a prompt for it, so Nebula doesn't ask on the first load: it
 * asks once there is something worth keeping, after the first edit or the
 * first project made here. Saves Nebula makes for itself (`.nebula/`, such as
 * which tabs are open) don't count.
 */
import type { BrowserRegistry } from '../files/registry';
import type { FileStore } from '../files/types';

function isNebulaSettings(path: string): boolean {
  return path === '.nebula' || path.startsWith('.nebula/');
}

/** The registry, unchanged, except that `ask` runs once, after the first edit
 * made through it. A refusal (or an error) changes nothing. */
export function askToKeepOnFirstEdit(registry: BrowserRegistry, ask: () => unknown): BrowserRegistry {
  let asked = false;
  const edited = () => {
    if (asked) return;
    asked = true;
    try {
      void Promise.resolve(ask()).catch(() => {});
    } catch {
      // The browser said no: the files are still saved, just not protected.
    }
  };

  const wrap = (store: FileStore): FileStore => ({
    list: () => store.list(),
    stat: (path) => store.stat(path),
    readText: (path) => store.readText(path),
    readBlob: (path) => store.readBlob(path),
    watch: (listener) => store.watch(listener),
    // The arguments whole, so no write option is dropped.
    async write(...args) {
      await store.write(...args);
      if (!isNebulaSettings(args[0])) edited();
    },
    async mkdir(path) {
      await store.mkdir(path);
      if (!isNebulaSettings(path)) edited();
    },
    async rename(from, to) {
      await store.rename(from, to);
      edited();
    },
    async remove(path) {
      await store.remove(path);
      if (!isNebulaSettings(path)) edited();
    },
  });

  return {
    // The tree (the migration's) and read-only (re-review R5) as the
    // registry has them; readOnly turns true only once registry.json is read.
    tree: registry.tree,
    get readOnly() {
      return registry.readOnly;
    },
    list: () => registry.list(),
    current: () => registry.current(),
    remove: (id) => registry.remove(id),
    open: async (id) => wrap(await registry.open(id)),
    files: async (id) => wrap(await registry.files(id)),
    async create(input) {
      const project = await registry.create(input);
      edited();
      return project;
    },
    async update(id, patch) {
      const project = await registry.update(id, patch);
      edited();
      return project;
    },
  };
}
