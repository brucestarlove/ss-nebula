/**
 * Per-file locks that reach across tabs (re-review R4, after ae71937).
 *
 * Every OPFS store takes the Web Lock `nebula:file:<place>` for a file it
 * touches, `<place>` being the file's path in the tree: shared to read it,
 * exclusive to write it, and exclusive for every file a rename moves or a
 * remove deletes. So another tab's rename or remove waits for a write in
 * flight here, and a write waits for them. A change that holds several files
 * takes them in one sorted order, so two tabs can never hold one each and
 * wait for the other's.
 */

export type FileLockMode = 'shared' | 'exclusive';

/** The part of the Web Locks API the stores use: navigator.locks, or a
 * PageLockManager. `request` resolves with what the callback gives. */
export type FileLockManager = {
  request(name: string, options: { mode: FileLockMode }, callback: () => unknown): unknown;
};

export const fileLockName = (place: string): string => `nebula:file:${place}`;

/** navigator.locks, or null when this browser (or test) has no Web Locks. */
export function browserFileLocks(): FileLockManager | null {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: unknown }).locks : undefined;
  return locks ? (locks as FileLockManager) : null;
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

/** Runs `action` holding the lock of every file in `places`, exclusively,
 * taken in sorted order. Without locks it just runs. Whatever `action`
 * returns comes back as it is, so a PageLockManager with nothing held runs a
 * synchronous action inside this call. */
export function holdingFiles<T>(locks: FileLockManager | null, places: string[], action: () => T | Promise<T>): T | Promise<T> {
  if (!locks) return action();
  const names = [...new Set(places)].sort().map(fileLockName);
  const step = (index: number): T | Promise<T> =>
    index === names.length ? action() : (locks.request(names[index], { mode: 'exclusive' }, () => step(index + 1)) as T | Promise<T>);
  return step(0);
}

function then<A, B>(value: A | Promise<A>, next: (value: A) => B | Promise<B>): B | Promise<B> {
  return isPromise(value) ? value.then(next) : next(value);
}

const RETRY = Symbol('retry');

/** holdingFiles for the files a folder change touches, listed by `list`.
 * Once the locks are held it lists again: a file another tab made in the
 * folder meanwhile has no lock yet, so it lets go and starts over, a few
 * times at most (then it goes ahead with what it holds). */
export function holdingListedFiles<T>(
  locks: FileLockManager | null,
  list: () => string[] | Promise<string[]>,
  action: () => T | Promise<T>,
): T | Promise<T> {
  if (!locks) return action();
  const attempt = (triesLeft: number): T | Promise<T> =>
    then(list(), (wanted) =>
      then(
        holdingFiles<T | typeof RETRY>(locks, wanted, () =>
          triesLeft > 0 ? then(list(), (now) => (now.every((place) => wanted.includes(place)) ? action() : RETRY)) : action(),
        ),
        (result) => (result === RETRY ? attempt(triesLeft - 1) : result),
      ),
    );
  return attempt(3);
}

type Waiter = { mode: FileLockMode; grant: () => void };
type LockState = { mode: FileLockMode | null; held: number; queue: Waiter[] };

/**
 * Web Locks' rules, inside one page: shared holders of a name together, an
 * exclusive one alone, first come first served. Memory stores and their twins
 * share one, as tabs share navigator.locks. A request that can be granted at
 * once runs its callback inside the call, and a callback that finishes inside
 * the call releases at once, so a memory store's changes still apply inside
 * the call when nothing holds them up.
 */
export class PageLockManager implements FileLockManager {
  private readonly states = new Map<string, LockState>();

  request<T>(name: string, options: { mode: FileLockMode }, callback: () => T | Promise<T>): T | Promise<T> {
    const state = this.state(name);
    if (state.queue.length === 0 && this.grantable(state, options.mode)) return this.run(name, state, options.mode, callback);
    return new Promise<void>((grant) => state.queue.push({ mode: options.mode, grant })).then(() => this.run(name, state, options.mode, callback, true));
  }

  private state(name: string): LockState {
    let state = this.states.get(name);
    if (!state) {
      state = { mode: null, held: 0, queue: [] };
      this.states.set(name, state);
    }
    return state;
  }

  private grantable(state: LockState, mode: FileLockMode): boolean {
    return state.held === 0 || (state.mode === 'shared' && mode === 'shared');
  }

  /** `granted`: the lock was already taken for this waiter by pump(). */
  private run<T>(name: string, state: LockState, mode: FileLockMode, callback: () => T | Promise<T>, granted = false): T | Promise<T> {
    if (!granted) {
      state.mode = mode;
      state.held += 1;
    }
    let result: T | Promise<T>;
    try {
      result = callback();
    } catch (error) {
      this.release(name, state);
      throw error;
    }
    if (!isPromise(result)) {
      this.release(name, state);
      return result;
    }
    return result.finally(() => this.release(name, state));
  }

  private release(name: string, state: LockState): void {
    state.held -= 1;
    if (state.held === 0) state.mode = null;
    while (state.queue.length > 0 && this.grantable(state, state.queue[0].mode)) {
      const waiter = state.queue.shift() as Waiter;
      state.mode = waiter.mode;
      state.held += 1;
      waiter.grant();
    }
    if (state.held === 0 && state.queue.length === 0) this.states.delete(name);
  }
}
