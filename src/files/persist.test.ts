import { describe, expect, it, vi } from 'vitest';
import { formatBytes, onPersistenceAnswer, requestPersistentStorage, storageStatus } from './persist';

function fakeStorage(options: { persisted?: boolean; grant?: boolean; estimate?: StorageEstimate | Error; persistThrows?: boolean } = {}) {
  const persist = vi.fn(async () => {
    if (options.persistThrows) throw new Error('nope');
    return options.grant ?? false;
  });
  const storage = {
    persisted: vi.fn(async () => options.persisted ?? false),
    persist,
    estimate: vi.fn(async () => {
      if (options.estimate instanceof Error) throw options.estimate;
      return options.estimate ?? { usage: 0, quota: 0 };
    }),
  } as unknown as StorageManager;
  return { storage, persist };
}

describe('requestPersistentStorage', () => {
  it('answers null where the browser has no storage manager', async () => {
    expect(await requestPersistentStorage(undefined)).toBeNull();
    expect(await requestPersistentStorage({} as StorageManager)).toBeNull();
  });

  it("doesn't ask again once storage is persistent", async () => {
    const { storage, persist } = fakeStorage({ persisted: true });
    expect(await requestPersistentStorage(storage)).toBe(true);
    expect(persist).not.toHaveBeenCalled();
  });

  it("asks, and reports the browser's answer", async () => {
    const granted = fakeStorage({ grant: true });
    expect(await requestPersistentStorage(granted.storage)).toBe(true);
    expect(granted.persist).toHaveBeenCalledTimes(1);
    expect(await requestPersistentStorage(fakeStorage({ grant: false }).storage)).toBe(false);
  });

  it('treats a failing request as not persistent, without throwing', async () => {
    expect(await requestPersistentStorage(fakeStorage({ persistThrows: true }).storage)).toBe(false);
  });
});

describe('onPersistenceAnswer', () => {
  it('tells whoever listens what the browser answered, until they stop listening', async () => {
    const storage = { persisted: async () => false, persist: async () => true } as unknown as StorageManager;
    const heard: Array<boolean | null> = [];
    const stop = onPersistenceAnswer((answer) => heard.push(answer));
    await requestPersistentStorage(storage);
    stop();
    await requestPersistentStorage(storage);
    expect(heard).toEqual([true]);
  });

  it('tells them a refusal too, and a failed request as one', async () => {
    const heard: Array<boolean | null> = [];
    const stop = onPersistenceAnswer((answer) => heard.push(answer));
    await requestPersistentStorage({ persisted: async () => false, persist: async () => false } as unknown as StorageManager);
    await requestPersistentStorage({ persisted: async () => false, persist: async () => Promise.reject(new Error('no')) } as unknown as StorageManager);
    stop();
    expect(heard).toEqual([false, false]);
  });
});

describe('storageStatus', () => {
  it('reports persistence and the usage estimate', async () => {
    const { storage } = fakeStorage({ persisted: true, estimate: { usage: 1_234_567, quota: 5_000_000_000 } });
    expect(await storageStatus(storage)).toEqual({ persisted: true, usage: 1_234_567, quota: 5_000_000_000 });
  });

  it('leaves out what the browser cannot tell', async () => {
    expect(await storageStatus(undefined)).toEqual({ persisted: null });
    expect(await storageStatus(fakeStorage({ estimate: new Error('denied') }).storage)).toEqual({ persisted: false });
    expect(await storageStatus({ estimate: async () => ({ usage: 10 }) } as unknown as StorageManager)).toEqual({ persisted: null, usage: 10 });
  });
});

describe('formatBytes', () => {
  it('writes sizes the way the status line shows them', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(999)).toBe('999 B');
    expect(formatBytes(1_234)).toBe('1.2 KB');
    expect(formatBytes(1_200_000)).toBe('1.2 MB');
    expect(formatBytes(15_400_000)).toBe('15 MB');
    expect(formatBytes(2_000_000_000)).toBe('2 GB');
  });
});
