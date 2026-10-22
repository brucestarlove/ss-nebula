import { describe, expect, it } from 'vitest';
import { openBrowserRegistry, probeOpfs } from './opfsRegistry';

type FakeFile = { data: string };

/** Just enough of OPFS for the probe: one folder level, text files. */
function fakeOpfs(options: { writable?: boolean; corrupt?: boolean } = {}) {
  const files = new Map<string, FakeFile>();
  const removed: string[] = [];
  const folder = {
    kind: 'directory' as const,
    name: '',
    async getFileHandle(name: string, init?: { create?: boolean }) {
      if (!files.has(name)) {
        if (!init?.create) throw new DOMException('missing', 'NotFoundError');
        files.set(name, { data: '' });
      }
      const file = files.get(name) as FakeFile;
      const handle: Record<string, unknown> = {
        kind: 'file',
        name,
        async getFile() {
          return new Blob([options.corrupt ? 'garbled' : file.data]);
        },
      };
      if (options.writable !== false) {
        handle.createWritable = async () => {
          let pending = '';
          return {
            async write(data: string) {
              pending += data;
            },
            async close() {
              file.data = pending;
            },
            async abort() {},
          };
        };
      }
      return handle;
    },
    async getDirectoryHandle() {
      return folder;
    },
    async removeEntry(name: string) {
      removed.push(name);
      files.delete(name);
    },
  };
  const storage = { getDirectory: async () => folder } as unknown as StorageManager;
  return { storage, files, removed };
}

describe('probeOpfs', () => {
  it('says no when the browser has no origin private file system', async () => {
    expect(await probeOpfs(undefined)).toEqual({ ok: false, reason: expect.stringMatching(/no origin private file system/i) });
    expect(await probeOpfs({} as StorageManager)).toMatchObject({ ok: false });
  });

  it("says no, with the browser's reason, when getDirectory() fails, as in WebKit's ephemeral contexts", async () => {
    const storage = {
      getDirectory: () => Promise.reject(new DOMException('The operation failed for an unknown transient reason', 'UnknownError')),
    } as unknown as StorageManager;
    expect(await probeOpfs(storage)).toEqual({ ok: false, reason: expect.stringContaining('UnknownError: The operation failed for an unknown transient reason') });
  });

  it('says no when files cannot be written with createWritable', async () => {
    expect(await probeOpfs(fakeOpfs({ writable: false }).storage)).toEqual({ ok: false, reason: expect.stringContaining('createWritable') });
  });

  it('says no when a written file does not read back', async () => {
    expect(await probeOpfs(fakeOpfs({ corrupt: true }).storage)).toMatchObject({ ok: false, reason: expect.stringMatching(/read back/) });
  });

  it('says yes after a round trip on a scratch file, and removes the scratch file', async () => {
    const opfs = fakeOpfs();
    const probe = await probeOpfs(opfs.storage);
    expect(probe.ok).toBe(true);
    expect(opfs.removed).toHaveLength(1);
    expect(opfs.files.size).toBe(0);
  });
});

describe('openBrowserRegistry without OPFS', () => {
  it('keeps projects in memory, says nothing will be kept, and still works', async () => {
    const { registry, persistent, reason } = await openBrowserRegistry({ storage: undefined });
    expect(persistent).toBe(false);
    expect(reason).toMatch(/no origin private file system/i);

    const project = await registry.create({ name: 'Scratch', color: '#7c8cff' });
    const store = await registry.open(project.id);
    await store.write('note.md', 'kept until the tab closes');
    expect(await store.readText('note.md')).toBe('kept until the tab closes');
    expect((await registry.list()).map((entry) => entry.name)).toEqual(['Scratch']);
  });
});

describe('openBrowserRegistry without Web Locks (review finding 10)', () => {
  const locks = { request: <T>(_name: string, callback: () => Promise<T>) => callback() };

  it('keeps nothing when the browser has OPFS but no Web Locks, and says why', async () => {
    const opfs = fakeOpfs();
    const { registry, persistent, reason } = await openBrowserRegistry({ storage: opfs.storage, locks: null });
    expect(persistent).toBe(false);
    expect(reason).toMatch(/Web Locks/);
    await registry.create({ name: 'Scratch', color: '#7c8cff' });
    // Nothing reached OPFS but the probe's scratch file, which is gone again.
    expect(opfs.files.size).toBe(0);
  });

  it('uses OPFS when the browser has both', async () => {
    const { persistent, reason } = await openBrowserRegistry({ storage: fakeOpfs().storage, locks });
    expect(persistent).toBe(true);
    expect(reason).toBeUndefined();
  });
});
