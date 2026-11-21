import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { createMemoryFileStore, type MemoryFileStore } from '../../../../e2e/harness/views-store';
import { blobToBytes } from '../../../files/bytes';
import { slowWrites } from '../testing/slowWrites';
import { scopedStore } from '../../../files/scopedStore';
import type { AccountStatus } from '../../../files/account';
import { SignedOutError, SpaceFullError } from '../../../files/serverStore';
import { subscribeKeptCopies, type KeptCopy } from './fileSessions';
import { createTextSession, type TextSession } from './textSession';

const PATH = 'Guides/Observing plan.md';

describe('text file session', () => {
  let store: MemoryFileStore;
  let session: TextSession;

  beforeEach(async () => {
    vi.useFakeTimers();
    store = createMemoryFileStore({ [PATH]: 'first' });
    session = createTextSession(store, PATH);
    await session.ready;
  });

  afterEach(async () => {
    await session.dispose();
    vi.useRealTimers();
  });

  /** A change made through another store or tab. */
  async function writeElsewhere(text: string) {
    await store.write(PATH, text);
    await vi.advanceTimersByTimeAsync(0);
  }

  it('loads the file', () => {
    expect(session.getState()).toMatchObject({ status: 'ready', text: 'first', dirty: false, conflict: false });
  });

  it('counts each text that comes from disk as a revision, and edits as none', async () => {
    const loaded = session.getState().revision;
    session.edit('typed');
    expect(session.getState().revision).toBe(loaded);
    await session.flush();
    await writeElsewhere('from disk');
    expect(session.getState().revision).toBe(loaded + 1);
    session.edit('mine');
    await writeElsewhere('theirs');
    await session.reload();
    expect(session.getState().revision).toBe(loaded + 2);
  });

  it('saves 500 ms after the last edit, once', async () => {
    session.edit('firs');
    await vi.advanceTimersByTimeAsync(300);
    session.edit('first!');
    expect(session.getState().dirty).toBe(true);
    await vi.advanceTimersByTimeAsync(499);
    expect(store.writes).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    expect(store.writes).toEqual([{ path: PATH, data: 'first!' }]);
    expect(session.getState()).toMatchObject({ text: 'first!', dirty: false });
  });

  it('saves at once when flushed, as when leaving the tab', async () => {
    session.edit('changed');
    await session.flush();
    expect(store.peek(PATH)).toBe('changed');
    expect(session.getState().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.writes).toHaveLength(1);
  });

  it('is not dirty when an edit returns to the saved text', async () => {
    session.edit('other');
    session.edit('first');
    expect(session.getState().dirty).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.writes).toHaveLength(0);
  });

  it('reloads a change made elsewhere when nothing is unsaved', async () => {
    await writeElsewhere('from another tab');
    expect(session.getState()).toMatchObject({ text: 'from another tab', dirty: false, conflict: false });
  });

  it('ignores the echo of its own saves', async () => {
    session.edit('mine');
    await vi.advanceTimersByTimeAsync(500);
    session.edit('mine, more');
    await vi.advanceTimersByTimeAsync(0);
    expect(session.getState()).toMatchObject({ text: 'mine, more', dirty: true, conflict: false });
  });

  it('asks before overwriting a change made elsewhere while edits are unsaved', async () => {
    session.edit('mine');
    await writeElsewhere('theirs');
    expect(session.getState()).toMatchObject({ text: 'mine', dirty: true, conflict: true });

    await vi.advanceTimersByTimeAsync(2000);
    expect(store.peek(PATH)).toBe('theirs');

    await session.reload();
    expect(session.getState()).toMatchObject({ text: 'theirs', dirty: false, conflict: false });
  });

  it('keeps mine over theirs when asked to', async () => {
    session.edit('first');
    session.edit('mine');
    await writeElsewhere('theirs');
    await session.keepMine();
    expect(store.peek(PATH)).toBe('mine');
    expect(session.getState()).toMatchObject({ text: 'mine', dirty: false, conflict: false });
  });

  it('keeps mine even when mine is what was on disk before theirs', async () => {
    session.edit('mine');
    await writeElsewhere('theirs');
    session.edit('first');
    await session.keepMine();
    expect(store.peek(PATH)).toBe('first');
    expect(session.getState()).toMatchObject({ text: 'first', dirty: false, conflict: false });
  });

  it('reloads when the edits went back to the saved text', async () => {
    session.edit('other');
    session.edit('first');
    await writeElsewhere('theirs');
    expect(session.getState()).toMatchObject({ text: 'theirs', conflict: false });
  });

  it('flushes pending edits when disposed, then stops listening', async () => {
    session.edit('unsaved');
    await session.dispose();
    expect(store.peek(PATH)).toBe('unsaved');

    await writeElsewhere('later');
    expect(session.getState().text).toBe('unsaved');
  });

  it('follows a rename, and never writes a removed file back', async () => {
    await store.rename(PATH, 'Guides/Renamed.md');
    session.edit('after rename');
    await session.flush();
    expect(store.peek('Guides/Renamed.md')).toBe('after rename');
    expect(store.peek(PATH)).toBeUndefined();

    await store.remove('Guides/Renamed.md');
    session.edit('after remove');
    await session.flush();
    expect(store.peek('Guides/Renamed.md')).toBeUndefined();
    expect(session.getState().removed).toBe(true);
  });

  it('follows a rename of its folder: unsaved edits land in the new folder, and the old one doesn’t come back', async () => {
    session.edit('after the move');
    await store.rename('Guides', 'Archive');
    await session.dispose();
    expect(store.peek('Archive/Observing plan.md')).toBe('after the move');
    expect(store.peek(PATH)).toBeUndefined();
  });

  it('writes the edit again where the file is now when it was renamed during the write', async () => {
    const slow = slowWrites(store);
    session.edit('mine');
    const flushing = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.waiting).toBe(1);
    await store.rename(PATH, 'Guides/Renamed.md');
    // The write lands where it was aimed, at the old path (this store doesn't
    // make a rename wait for writes in flight).
    slow.release();
    await flushing;
    await session.flush();
    expect(store.peek('Guides/Renamed.md')).toBe('mine');
    expect(session.getState()).toMatchObject({ dirty: false });
  });

  it('writes nothing more once its whole project folder is removed', async () => {
    const tree = createMemoryFileStore({ 'projects/p1/Guides/plan.md': 'first' });
    const scoped = createTextSession(scopedStore(tree, 'projects/p1'), 'Guides/plan.md');
    await scoped.ready;
    scoped.edit('second');
    await tree.remove('projects/p1');
    await vi.advanceTimersByTimeAsync(0);
    await scoped.flush();
    expect(tree.peek('projects/p1/Guides/plan.md')).toBeUndefined();
    expect(scoped.getState().removed).toBe(true);
    await scoped.dispose();
  });

  it('a write queued when its folder is deleted is never made', async () => {
    const slow = slowWrites(store);
    session.edit('one');
    const first = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    session.edit('two');
    const second = session.flush();
    await vi.advanceTimersByTimeAsync(0);
    expect(slow.waiting).toBe(1);
    await store.remove('Guides');
    slow.release();
    await first;
    await second;
    // Neither lands. The write in flight expects the file's text,
    // and the file is gone, so even this store, which would make the folder
    // again, writes nothing.
    expect(store.writes.map((write) => write.data)).toEqual([]);
    expect(session.getState().removed).toBe(true);
  });

  it('reopened while its last save is still being written, the file opens with that text', async () => {
    const slow = slowWrites(store);
    session.edit('mine');
    // The view's cleanup doesn't wait for dispose().
    void session.dispose();
    const reopened = createTextSession(store, PATH);
    let opened = false;
    void reopened.ready.then(() => {
      opened = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(false);
    slow.release();
    await reopened.ready;
    expect(reopened.getState()).toMatchObject({ text: 'mine', dirty: false, conflict: false });
    await reopened.dispose();
  });

  it('doesn’t write over another tab’s save it hasn’t heard about yet: it asks first', async () => {
    const quiet = createMemoryFileStore({ [PATH]: 'first' });
    let holding = false;
    const held: Array<() => void> = [];
    // This tab hears what other tabs do only once their message arrives.
    const late = {
      ...quiet,
      watch: (listener: Parameters<typeof quiet.watch>[0]) =>
        quiet.watch((change) => (holding ? held.push(() => listener(change)) : listener(change))),
    };
    const local = createTextSession(late, PATH);
    await local.ready;
    holding = true;
    await quiet.write(PATH, 'theirs, a little longer');
    local.edit('mine');
    await local.flush();
    expect(quiet.peek(PATH)).toBe('theirs, a little longer');
    expect(local.getState()).toMatchObject({ conflict: true, dirty: true });
    holding = false;
    for (const run of held.splice(0)) run();
    await local.keepMine();
    expect(quiet.peek(PATH)).toBe('mine');
    expect(local.getState()).toMatchObject({ conflict: false, dirty: false });
    await local.dispose();
  });

  it('doesn’t write back a file deleted in another tab before the message arrives', async () => {
    const quiet = createMemoryFileStore({ [PATH]: 'first' });
    let holding = false;
    const held: Array<() => void> = [];
    const late = {
      ...quiet,
      watch: (listener: Parameters<typeof quiet.watch>[0]) =>
        quiet.watch((change) => (holding ? held.push(() => listener(change)) : listener(change))),
    };
    const local = createTextSession(late, PATH);
    await local.ready;
    holding = true;
    await quiet.remove(PATH);
    local.edit('mine');
    await local.flush();
    expect(quiet.peek(PATH)).toBeUndefined();
    holding = false;
    for (const run of held.splice(0)) run();
    expect(local.getState().removed).toBe(true);
    await local.dispose();
    expect(quiet.peek(PATH)).toBeUndefined();
  });

  describe('bytes that must not change', () => {
    async function bytesOf(target: MemoryFileStore, path: string): Promise<number[]> {
      return Array.from(await blobToBytes(await target.readBlob(path)));
    }

    it('opens a file that isn’t UTF-8 read-only, and never writes it', async () => {
      // 'café' in Latin-1: E9 isn't valid UTF-8 on its own.
      const latin1 = [0x63, 0x61, 0x66, 0xe9, 0x0a];
      const local = createMemoryFileStore({ 'notes/old.txt': new Blob([new Uint8Array(latin1)]) });
      const opened = createTextSession(local, 'notes/old.txt');
      await opened.ready;
      expect(opened.getState()).toMatchObject({ status: 'ready', readOnly: true, text: 'caf\uFFFD\n' });
      opened.edit('café\n');
      await opened.flush();
      await opened.dispose();
      expect(local.writes).toHaveLength(0);
      expect(await bytesOf(local, 'notes/old.txt')).toEqual(latin1);
    });

    it('keeps a file’s CRLF line ends when it’s edited', async () => {
      const local = createMemoryFileStore({ 'win.txt': 'one\r\ntwo\r\n' });
      const opened = createTextSession(local, 'win.txt');
      await opened.ready;
      // The editor hands text back with \n line ends.
      opened.edit('one\ntwo\nthree\n');
      await opened.flush();
      expect(local.peek('win.txt')).toBe('one\r\ntwo\r\nthree\r\n');
      await opened.dispose();
    });

    it('takes the editor’s LF copy of a CRLF file for what it is: no change, no write', async () => {
      const local = createMemoryFileStore({ 'win.txt': 'one\r\ntwo\r\n' });
      const opened = createTextSession(local, 'win.txt');
      await opened.ready;
      opened.edit('one\ntwo\n');
      expect(opened.getState().dirty).toBe(false);
      await local.write('win.txt', 'one\r\ntwo, from elsewhere\r\n');
      await vi.advanceTimersByTimeAsync(0);
      expect(opened.getState().text).toBe('one\r\ntwo, from elsewhere\r\n');
      opened.edit('one\ntwo, from elsewhere\n');
      await vi.advanceTimersByTimeAsync(1000);
      await opened.dispose();
      expect(local.writes).toHaveLength(1);
    });
  });

  it('reports a file it cannot read', async () => {
    store.unreadable.add('broken.md');
    const broken = createTextSession(store, 'broken.md');
    await broken.ready;
    expect(broken.getState().status).toBe('error');
    expect(String(broken.getState().error)).toContain('broken.md');
    await broken.dispose();
  });

  it('reports a failed save and keeps the edit', async () => {
    const failing = createMemoryFileStore({ [PATH]: 'first' });
    failing.write = async () => {
      throw new Error('Disk full');
    };
    const local = createTextSession(failing, PATH);
    await local.ready;
    local.edit('mine');
    await local.flush();
    expect(local.getState()).toMatchObject({ text: 'mine', dirty: true });
    expect(String(local.getState().saveError)).toContain('Disk full');
    await local.dispose();
  });
});

describe('a text session whose save meets the account (signed out, space full)', () => {
  /** A store with an account, as a server project's has: its writes can be refused as one. */
  function accountStore() {
    const store = createMemoryFileStore({ [PATH]: 'first' });
    const listeners = new Set<(status: AccountStatus) => void>();
    const stored = store.write.bind(store);
    let refusing: Error | null = null;
    store.write = async (path, data, options) => {
      if (refusing) throw refusing;
      await stored(path, data, options);
    };
    Object.assign(store, {
      onAccount(listener: (status: AccountStatus) => void) {
        listeners.add(listener);
        return () => void listeners.delete(listener);
      },
      signedOut: () => (refusing instanceof SignedOutError ? {} : null),
      retryAccount: async () => {},
    });
    return {
      store,
      /** The store refuses writes as this, or accepts them again (null). */
      refuse(error: Error | null) {
        refusing = error;
      },
      /** Another tab's save, which the account doesn't refuse. */
      elsewhere: (path: string, text: string) => stored(path, text),
      say(status: AccountStatus) {
        for (const listener of [...listeners]) listener(status);
      },
      listeners,
    };
  }

  const kept: KeptCopy[] = [];
  let stop: () => void;
  beforeEach(() => {
    vi.useFakeTimers();
    kept.length = 0;
    stop = subscribeKeptCopies((copy) => kept.push(copy));
  });
  afterEach(() => {
    for (const copy of kept) if (copy.copy === null) copy.release();
    stop();
    vi.useRealTimers();
  });

  it.each([
    ['signed out', () => new SignedOutError()],
    ['space full', () => new SpaceFullError({ used: 1000, limit: 1000 })],
  ])('keeps the edit when the save is refused: %s', async (_name, make) => {
    const { store, refuse } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(make());
    session.edit('mine');
    await session.flush();
    expect(session.getState()).toMatchObject({ text: 'mine', dirty: true, conflict: false, removed: false });
    expect(session.getState().saveError).toBeInstanceOf(make().constructor);
    expect(store.peek(PATH)).toBe('first');
    expect(store.writes).toHaveLength(0);
    await session.dispose();
  });

  it('closing the view still offers the edit as a download, as a failed save', async () => {
    const { store, refuse } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SignedOutError());
    session.edit('mine');
    await session.dispose();
    expect(kept).toHaveLength(1);
    const copy = kept[0];
    if (copy.copy !== null) throw new Error('expected a download, got a copy');
    expect(copy.failedSave).toBe(true);
    expect(copy.path).toBe(PATH);
    expect(copy.download).toEqual({ filename: 'Observing plan.md', text: 'mine' });
    expect(copy.error).toBeInstanceOf(SignedOutError);
    expect(store.peek(PATH)).toBe('first');
  });

  it('a space-full close offers the download with the space error', async () => {
    const { store, refuse } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SpaceFullError({ used: 5, limit: 5 }));
    session.edit('mine');
    await session.dispose();
    const copy = kept[0];
    if (copy.copy !== null) throw new Error('expected a download, got a copy');
    expect(copy.error).toBeInstanceOf(SpaceFullError);
    expect(copy.download.text).toBe('mine');
  });

  it('once the store says signed-in, a kept edit is written by the normal path', async () => {
    const { store, refuse, say } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SignedOutError());
    session.edit('mine');
    await session.flush();
    expect(session.getState().saveError).toBeDefined();
    refuse(null);
    say('signed-in');
    await vi.advanceTimersByTimeAsync(0);
    expect(store.peek(PATH)).toBe('mine');
    expect(store.writes).toEqual([{ path: PATH, data: 'mine' }]);
    expect(session.getState()).toMatchObject({ text: 'mine', dirty: false, saveError: undefined });
    await session.dispose();
  });

  it('signed-out heard after a refused save writes nothing', async () => {
    const { store, refuse, say } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SignedOutError());
    session.edit('mine');
    await session.flush();
    refuse(null);
    say('signed-out');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.writes).toHaveLength(0);
    await session.dispose();
  });

  it('a file changed meanwhile is asked about, never written over', async () => {
    const { store, refuse, say, elsewhere } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SignedOutError());
    session.edit('mine');
    await session.flush();
    await elsewhere(PATH, 'theirs');
    await vi.advanceTimersByTimeAsync(0);
    refuse(null);
    say('signed-in');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.peek(PATH)).toBe('theirs');
    expect(session.getState()).toMatchObject({ text: 'mine', conflict: true });
    await session.reload();
    await session.dispose();
  });

  it('with no refused save, signed-in writes nothing ahead of the usual delay, and with no edit nothing at all', async () => {
    const { store, say } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    say('signed-in');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.writes).toHaveLength(0);
    session.edit('typing');
    say('signed-in');
    await vi.advanceTimersByTimeAsync(100);
    expect(store.writes).toHaveLength(0); // still inside the 500 ms: this edit's save has not failed
    await vi.advanceTimersByTimeAsync(500);
    expect(store.writes).toHaveLength(1);
    await session.dispose();
  });

  it('a session that was closed takes no part when the store says signed-in', async () => {
    const { store, refuse, say, listeners } = accountStore();
    const session = createTextSession(store, PATH);
    await session.ready;
    refuse(new SignedOutError());
    session.edit('mine');
    await session.dispose();
    expect(listeners.size).toBe(0);
    refuse(null);
    say('signed-in');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(store.writes).toHaveLength(0);
  });
});
