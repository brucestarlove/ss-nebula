import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import { slowWrites } from '../testing/slowWrites';
import { holdWrites } from './fileSessions';
import { createTextSession, type TextSession } from './textSession';

describe('file sessions, around a rename or a delete in this workspace', () => {
  let store: MemoryFileStore;
  const open: TextSession[] = [];

  async function session(path: string) {
    const created = createTextSession(store, path, { scope: 'night-sky' });
    open.push(created);
    await created.ready;
    return created;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    store = createMemoryFileStore({ 'Guides/plan.md': 'v1', 'Guides/Deep/sky.md': 'sky', 'Other/plan.md': 'other' });
  });

  afterEach(async () => {
    for (const created of open.splice(0)) await created.dispose();
    vi.useRealTimers();
  });

  it('writes the unsaved edits under a folder before it moves', async () => {
    const plan = await session('Guides/plan.md');
    const sky = await session('Guides/Deep/sky.md');
    plan.edit('v2');
    sky.edit('sky, edited');
    const release = await holdWrites('night-sky', 'Guides');
    expect(store.peek('Guides/plan.md')).toBe('v2');
    expect(store.peek('Guides/Deep/sky.md')).toBe('sky, edited');
    release();
  });

  it('holds their next writes until the move is done, then writes where the files are now', async () => {
    const plan = await session('Guides/plan.md');
    const release = await holdWrites('night-sky', 'Guides');
    plan.edit('typed during the move');
    const flushing = plan.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(store.writes).toHaveLength(0);
    await store.rename('Guides', 'Archive');
    release();
    await flushing;
    expect(store.peek('Archive/plan.md')).toBe('typed during the move');
    expect(store.peek('Guides/plan.md')).toBeUndefined();
  });

  it('leaves files outside the folder alone', async () => {
    const other = await session('Other/plan.md');
    const release = await holdWrites('night-sky', 'Guides');
    other.edit('other, edited');
    await other.flush();
    expect(store.peek('Other/plan.md')).toBe('other, edited');
    release();
  });

  it('for a delete: waits for a write in flight, writes nothing more, and the file stays deleted', async () => {
    const plan = await session('Guides/plan.md');
    const slow = slowWrites(store);
    plan.edit('v2');
    const flushing = plan.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.waiting).toBe(1);
    let held = false;
    const holding = holdWrites('night-sky', 'Guides', { flush: false }).then((release) => {
      held = true;
      return release;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(held).toBe(false);
    slow.release();
    await flushing;
    const release = await holding;
    plan.edit('v3, typed while it was being deleted');
    const late = plan.flush();
    await store.remove('Guides');
    release();
    await late;
    expect(store.peek('Guides/plan.md')).toBeUndefined();
    expect((await store.list()).map((entry) => entry.path)).toEqual(['Other', 'Other/plan.md']);
  });
});
