/** Test helpers for writes that take a while, as a slow disk's would. */
import type { FileStore } from '../../../files/types';

export type SlowWrites = {
  /** Writes started and not let through yet. */
  readonly waiting: number;
  /** Lets every held write through; later writes go straight through. */
  release(): void;
};

/** Holds the store's writes until release(). */
export function slowWrites(store: FileStore): SlowWrites {
  const write = store.write.bind(store);
  const queue: Array<() => void> = [];
  let holding = true;
  // The arguments whole, so no write option is dropped.
  store.write = (...args) =>
    holding ? new Promise<void>((resolve, reject) => queue.push(() => void write(...args).then(resolve, reject))) : write(...args);
  return {
    get waiting() {
      return queue.length;
    },
    release() {
      holding = false;
      for (const run of queue.splice(0)) run();
    },
  };
}
