/**
 * Keeps a store's changes to overlapping paths in the order they were asked
 * for (review findings 1 and 13): a rename or a remove waits for every write
 * in flight to the path or anywhere inside it, and anything asked for later
 * waits for the rename or remove in turn. Changes to unrelated paths still run
 * side by side.
 */
import { isInside } from './paths';

type Pending = { paths: string[]; done: Promise<void> };

function overlaps(a: string, b: string): boolean {
  return isInside(a, b) || isInside(b, a);
}

function isPromise<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof (value as { then?: unknown } | null)?.then === 'function';
}

const settled = () => {};

export class PathLocks {
  private readonly pending = new Set<Pending>();

  /** Runs `action` once every earlier change touching `paths` (or a folder
   * around them, or anything inside them) has settled. With none in flight it
   * runs at once, inside this call, and an action that finishes inside the
   * call holds nothing up. */
  run<T>(paths: string[], action: () => Promise<T> | T): Promise<T> {
    const earlier = [...this.pending].filter((other) => other.paths.some((a) => paths.some((b) => overlaps(a, b))));
    if (earlier.length === 0) {
      let result: Promise<T> | T;
      try {
        result = action();
      } catch (error) {
        return Promise.reject(error);
      }
      return isPromise(result) ? this.track(paths, result) : Promise.resolve(result);
    }
    return this.track(
      paths,
      Promise.all(earlier.map((other) => other.done)).then(() => action()),
    );
  }

  private track<T>(paths: string[], running: Promise<T>): Promise<T> {
    const entry: Pending = { paths, done: running.then(settled, settled) };
    this.pending.add(entry);
    void entry.done.then(() => this.pending.delete(entry));
    return running;
  }
}
