/**
 * Locks that reach across tabs: Web Locks when the browser has them (every
 * engine with OPFS and createWritable does), and otherwise a queue per name
 * in this page, which still keeps this page's callers in order.
 */

/** The part of the Web Locks API Nebula uses; tests pass their own. */
export type LockManagerLike = {
  request<T>(name: string, callback: () => Promise<T>): Promise<T>;
};

const pageQueues = new Map<string, Promise<unknown>>();

/** navigator.locks, or null when this browser has no Web Locks. */
export function webLocks(): LockManagerLike | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: unknown }).locks : undefined;
  return locks ? (locks as LockManagerLike) : null;
}

/** Runs `action` while holding the lock `name`: with `locks` (Web Locks by
 * default) across tabs; with null, in this page only. */
export function withLock<T>(name: string, action: () => Promise<T>, locks: LockManagerLike | null = webLocks()): Promise<T> {
  if (locks) return locks.request(name, () => action());
  const run = (pageQueues.get(name) ?? Promise.resolve()).then(action, action);
  pageQueues.set(name, run.catch(() => {}));
  return run;
}
