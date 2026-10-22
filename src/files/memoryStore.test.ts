import { describe, expect, it, vi } from 'vitest';
import { MemoryFileStore } from './memoryStore';
import { registerFileStoreConformance, registerFileStoreTwinConformance } from './storeConformance';

registerFileStoreConformance({ describe, it }, 'MemoryFileStore', () => new MemoryFileStore());
registerFileStoreTwinConformance({ describe, it }, 'MemoryFileStore and its twin', () => {
  const here = new MemoryFileStore();
  return [here, here.twin()];
});

// The same store with every change taking a moment, writes longest, as on a
// real disk: the order of overlapping changes must hold up when they are in
// flight together.
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
registerFileStoreConformance({ describe, it }, 'MemoryFileStore with slow changes', () => new MemoryFileStore({ delay: (change) => pause(change.type === 'write' ? 4 : 1) }));

describe('MemoryFileStore', () => {
  it('applies a change at once when nothing delays it, as tests elsewhere expect', async () => {
    const store = new MemoryFileStore();
    void store.write('a.md', 'A');
    expect(await store.readText('a.md')).toBe('A');
  });

  it('lets a test hold a change in flight, and tells the delay what is about to change', async () => {
    const seen: unknown[] = [];
    let release = () => {};
    const store = new MemoryFileStore({
      delay: (change) => {
        seen.push(change);
        return change.type === 'write' ? new Promise<void>((resolve) => (release = resolve)) : undefined;
      },
    });
    const writing = store.write('Guides/a.md', 'A');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await store.stat('Guides/a.md')).toBeNull();
    release();
    await writing;
    expect(await store.readText('Guides/a.md')).toBe('A');
    await store.rename('Guides', 'Notes');
    expect(seen).toEqual([
      { type: 'write', path: 'Guides/a.md' },
      { type: 'rename', from: 'Guides', to: 'Notes' },
    ]);
  });
});

// Re-review R4: path locks keep one store's changes in order, and per-file
// locks reach the other stores (tabs). A write in flight here holds its file,
// so another store's rename or remove of it, or of a folder around it, waits.
describe('MemoryFileStore twins: another store waits for a write in flight here (R4)', () => {
  async function heldWrite(path: string) {
    let hold = false;
    let release = () => {};
    let entered = () => {};
    const inside = new Promise<void>((resolve) => (entered = resolve));
    const here = new MemoryFileStore({
      delay: (change) => {
        if (!hold || change.type !== 'write') return undefined;
        entered();
        return new Promise<void>((resolve) => (release = resolve));
      },
    });
    const there = here.twin();
    await here.write(path, 'v1');
    hold = true;
    const writing = here.write(path, 'v2');
    await inside;
    return { here, there, writing, release: () => release() };
  }

  async function waitsFor(change: Promise<void>, release: () => void, writing: Promise<void>) {
    let settled = false;
    void change.then(() => (settled = true), () => (settled = true));
    await pause(20);
    expect(settled, 'the other store went ahead while the write was in flight').toBe(false);
    release();
    await Promise.all([writing, change]);
  }

  const listed = async (store: MemoryFileStore) => (await store.list()).map((entry) => (entry.type === 'dir' ? `${entry.path}/` : entry.path));

  it('a rename of the file leaves nothing at the old path, and the new path has the write', async () => {
    const { there, writing, release } = await heldWrite('Sketches/plan.md');
    await waitsFor(there.rename('Sketches/plan.md', 'Drawings/plan.md'), release, writing);
    expect(await listed(there)).toEqual(['Drawings/', 'Drawings/plan.md', 'Sketches/']);
    expect(await there.readText('Drawings/plan.md')).toBe('v2');
  });

  it('a rename of its folder leaves nothing at the old path', async () => {
    const { there, writing, release } = await heldWrite('Sketches/plan.md');
    await waitsFor(there.rename('Sketches', 'Drawings'), release, writing);
    expect(await listed(there)).toEqual(['Drawings/', 'Drawings/plan.md']);
    expect(await there.readText('Drawings/plan.md')).toBe('v2');
  });

  it('a remove of the file does not bring it back', async () => {
    const { there, writing, release } = await heldWrite('Sketches/plan.md');
    await waitsFor(there.remove('Sketches/plan.md'), release, writing);
    expect(await listed(there)).toEqual(['Sketches/']);
  });

  it('a remove of its folder does not bring it back', async () => {
    const { there, writing, release } = await heldWrite('Old/Deep/plan.md');
    await there.write('Old/other.md', 'other');
    await waitsFor(there.remove('Old'), release, writing);
    expect(await listed(there)).toEqual([]);
  });
});

// Round 5: a write's ifUnchanged compares the content, so two writes of one
// size in one millisecond, which a size-and-time check can't tell apart,
// still are.
describe('MemoryFileStore: ifUnchanged within one millisecond', () => {
  it('refuses a write expecting the older of two same-size texts written in the same millisecond', async () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const here = new MemoryFileStore();
      const there = here.twin();
      await here.write('a.md', 'mine');
      const before = await here.stat('a.md');
      await there.write('a.md', 'them');
      // Same size, same time: the stat can't see the change.
      expect(await here.stat('a.md')).toEqual(before);
      await expect(here.write('a.md', 'mine 2', { ifUnchanged: { text: 'mine' } })).rejects.toMatchObject({ name: 'FileChangedError', absent: false });
      expect(await here.readText('a.md')).toBe('them');
    } finally {
      now.mockRestore();
    }
  });
});
