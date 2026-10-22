import { describe, expect, it } from 'vitest';
import { beforeWrites, instrumentStore } from '../../e2e/harness/storeWrappers';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import { askToKeepOnFirstEdit } from '../app/keepOnEdit';
import { MemoryStore } from '../workspace/dev/memoryStore';
import { slowWrites } from '../workspace/views/testing/slowWrites';
import { MemoryFileStore } from './memoryStore';
import type { BrowserRegistry } from './registry';
import { scopedStore } from './scopedStore';
import { writeOptionCases } from './storeConformance';
import type { FileStore } from './types';

/**
 * Round 5, G4: every store and every wrapper around one honours the write
 * options. The conformance cases about them (`exclusive`, `ifUnchanged`) run
 * through each, so a wrapper that names its arguments and drops the ones
 * added later fails here, not silently in a browser.
 */

/** A registry whose project stores are memory stores: enough for keepOnEdit. */
function registryOf(store: FileStore): BrowserRegistry {
  const fail = () => Promise.reject(new Error('not in this test'));
  return {
    list: async () => [],
    create: fail,
    open: async () => store,
    files: async () => store,
    update: fail,
    remove: fail,
    current: async () => null,
  } as BrowserRegistry;
}

const stores: Array<[string, () => FileStore | Promise<FileStore>]> = [
  ['scopedStore', () => scopedStore(new MemoryFileStore(), 'projects/p')],
  ['askToKeepOnFirstEdit', () => askToKeepOnFirstEdit(registryOf(new MemoryFileStore()), () => {}).open('p')],
  [
    'slowWrites, released',
    () => {
      const store = new MemoryFileStore();
      slowWrites(store).release();
      return store;
    },
  ],
  ['the dev MemoryStore', () => new MemoryStore()],
  ['the views harness store', () => createMemoryFileStore()],
  ['the sessions harness instrument()', () => instrumentStore(new MemoryFileStore(), [], 0)],
  ['the storage harness beforeWrites()', () => beforeWrites(new MemoryFileStore(), () => true)],
];

for (const [label, make] of stores) {
  describe(`${label} honours the write options`, () => {
    for (const testCase of writeOptionCases) it(testCase.name, async () => testCase.run(await make()));
  });
}

describe('the write-option cases', () => {
  it('catch a wrapper that names its arguments and drops the options', async () => {
    const inner = new MemoryFileStore();
    const dropping: FileStore = Object.assign(Object.create(inner) as FileStore, {
      write: (path: string, data: string | Blob) => inner.write(path, data),
    });
    const failed: string[] = [];
    for (const testCase of writeOptionCases) {
      await testCase.run(dropping).catch(() => failed.push(testCase.name));
    }
    expect(failed).toEqual(writeOptionCases.map((testCase) => testCase.name));
  });
});
