import type { FolderAccess, FolderHandle } from '../../files/types';
import type { FolderActions } from '../folders';
import type { FakeRegistry } from './fakeRegistry';

export type FakeFolders = FolderActions & {
  /** What the next pick() returns, one per pick: a folder, or null (cancelled). */
  picks: Array<FolderHandle | null>;
  /** How many times the picker was shown. */
  picked: number;
  /** The projects whose folders were asked for again. */
  requested: string[];
  /** What the browser answers when asked again. */
  answer: FolderAccess;
};

/** Folders on this computer, as a test says: a picker that returns what the
 * test queued, and a browser that answers what the test says, telling the
 * fake registry so. */
export function createFakeFolders(registry: FakeRegistry, options: { supported?: boolean } = {}): FakeFolders {
  const folders: FakeFolders = {
    supported: options.supported ?? true,
    picks: [],
    picked: 0,
    requested: [],
    answer: 'granted',
    async pick() {
      folders.picked += 1;
      return folders.picks.shift() ?? null;
    },
    async request(id) {
      folders.requested.push(id);
      registry.setAccess(id, folders.answer);
      return folders.answer;
    },
  };
  return folders;
}
