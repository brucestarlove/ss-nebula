import type { FileChange } from './types';

type Listener = (change: FileChange) => void;

/** The watchers of one store. A watcher that throws is reported, and neither
 * the other watchers nor the change that triggered it are affected. */
export class ChangeListeners {
  private readonly listeners = new Set<Listener>();

  add(listener: Listener): () => void {
    // Wrap, so the same function can be added twice and removed once.
    const entry: Listener = (change) => listener(change);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  get size(): number {
    return this.listeners.size;
  }

  emit(change: FileChange): void {
    for (const listener of [...this.listeners]) {
      try {
        listener(change);
      } catch (error) {
        console.error('A file watcher failed', error);
      }
    }
  }
}
