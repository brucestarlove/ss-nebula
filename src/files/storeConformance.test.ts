import { describe, expect, it } from 'vitest';
import { MemoryFileStore } from './memoryStore';
import { fileStoreConformanceCases, runFileStoreConformance } from './storeConformance';
import type { FileChange, FileEntry, WriteOptions } from './types';

// Stores with one deliberate fault each: the suite must catch every one.
class UnsortedStore extends MemoryFileStore {
  async list(): Promise<FileEntry[]> {
    return (await super.list()).reverse();
  }
}

class DeafStore extends MemoryFileStore {
  watch(listener: (change: FileChange) => void): () => void {
    void listener;
    return () => {};
  }
}

class OverwritingStore extends MemoryFileStore {
  async rename(from: string, to: string): Promise<void> {
    if (await this.stat(to)) await this.remove(to);
    return super.rename(from, to);
  }
}

class ShowsNebulaStore extends MemoryFileStore {
  private readonly hidden: FileEntry[] = [];

  async write(path: string, data: string | Blob, options?: WriteOptions): Promise<void> {
    await super.write(path, data, options);
    if (path.startsWith('.nebula/')) this.hidden.push({ path: '.nebula', name: '.nebula', type: 'dir' });
  }

  async list(): Promise<FileEntry[]> {
    return [...this.hidden.slice(0, 1), ...(await super.list())];
  }
}

// Writes take a while, and nothing makes a rename or a remove wait for them.
class UnorderedStore extends MemoryFileStore {
  async write(path: string, data: string | Blob, options?: WriteOptions): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 2));
    return super.write(path, data, options);
  }
}

// Takes the write option and ignores it: an exclusive write overwrites.
class CarelessStore extends MemoryFileStore {
  async write(path: string, data: string | Blob): Promise<void> {
    return super.write(path, data);
  }
}

// Checks ifUnchanged by size alone, as a size-and-time check does when two
// writes land in one millisecond: a different text of the same size passes.
class StampStore extends MemoryFileStore {
  async write(path: string, data: string | Blob, options: WriteOptions = {}): Promise<void> {
    const { ifUnchanged, ...rest } = options;
    if (ifUnchanged === undefined || ifUnchanged === 'absent') return super.write(path, data, options);
    const now = await this.stat(path);
    if (!now || now.size !== new TextEncoder().encode(ifUnchanged.text).length) throw Object.assign(new Error('changed'), { name: 'FileChangedError' });
    return super.write(path, data, rest);
  }
}

async function failures(factory: () => MemoryFileStore): Promise<string[]> {
  return (await runFileStoreConformance(factory)).filter((result) => !result.ok).map((result) => result.name);
}

describe('runFileStoreConformance', () => {
  it('passes a correct store on every case, each on a fresh store, cleaning up after each', async () => {
    const made: MemoryFileStore[] = [];
    const cleaned: unknown[] = [];
    const results = await runFileStoreConformance(
      () => {
        const store = new MemoryFileStore();
        made.push(store);
        return store;
      },
      (store) => {
        cleaned.push(store);
      },
    );
    expect(results.filter((result) => !result.ok)).toEqual([]);
    expect(results.map((result) => result.name)).toEqual(fileStoreConformanceCases.map((testCase) => testCase.name));
    expect(new Set(made).size).toBe(fileStoreConformanceCases.length);
    expect(cleaned).toEqual(made);
  });

  it('catches a store that lists out of order', async () => {
    expect(await failures(() => new UnsortedStore())).toContain('lists every file and folder sorted by path, folder before its contents');
  });

  it('catches a store whose watchers hear nothing', async () => {
    expect(await failures(() => new DeafStore())).toEqual([
      'tells watchers about each change, once, as it completes',
      'stops telling a watcher once it unsubscribes',
      'tells watchers about a write in flight before the rename that waited for it',
    ]);
  });

  it('catches a store that renames over an existing entry', async () => {
    expect(await failures(() => new OverwritingStore())).toContain('refuses to rename onto anything that exists');
  });

  it('catches a store that lists .nebula', async () => {
    expect(await failures(() => new ShowsNebulaStore())).toEqual(["hides the project's .nebula folder from list, but reaches it by path"]);
  });

  it('catches a store whose renames and removes do not wait for writes in flight', async () => {
    expect(await failures(() => new UnorderedStore())).toEqual([
      'renames a folder only once a write in flight inside it has landed',
      'renames a file only once a write in flight to it has landed',
      'removes a folder only once a write in flight inside it has landed, so nothing comes back',
      'removes a file only once a write in flight to it has landed',
      'tells watchers about a write in flight before the rename that waited for it',
    ]);
  });

  it('catches a store that drops the write options: exclusive writes overwrite (round 4, F1), conditional ones too (round 5)', async () => {
    expect(await failures(() => new CarelessStore())).toEqual([
      'refuses an exclusive write where anything exists, and makes a new file with one',
      'lets exactly one of two exclusive writes to one new path through',
      'writes with ifUnchanged only while the file holds exactly the text given, or nothing (round 5)',
      'lets exactly one of two writes expecting the same text through, whatever their size and time (round 5)',
    ]);
  });

  it('catches a store that compares only size and time (round 5)', async () => {
    expect(await failures(() => new StampStore())).toEqual([
      'writes with ifUnchanged only while the file holds exactly the text given, or nothing (round 5)',
      'lets exactly one of two writes expecting the same text through, whatever their size and time (round 5)',
    ]);
  });

  it('reports the reason for a failure', async () => {
    const [result] = (await runFileStoreConformance(() => new DeafStore())).filter((entry) => !entry.ok);
    expect(result.error).toMatch(/^ConformanceFailure: after write/);
  });
});
