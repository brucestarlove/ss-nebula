import { describe, expect, it } from 'vitest';
import { PageLockManager, fileLockName, holdingFiles } from './fileLocks';

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('PageLockManager (Web Locks, within one page)', () => {
  it('runs exclusive holders of one name one at a time, in order', async () => {
    const locks = new PageLockManager();
    const order: string[] = [];
    const first = locks.request('a', { mode: 'exclusive' }, async () => {
      order.push('first in');
      await pause(10);
      order.push('first out');
      return 1;
    });
    const second = locks.request('a', { mode: 'exclusive' }, async () => {
      order.push('second');
      return 2;
    });
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(order).toEqual(['first in', 'first out', 'second']);
  });

  it('lets shared holders in together, and an exclusive one only after them', async () => {
    const locks = new PageLockManager();
    const order: string[] = [];
    const reader = (label: string) =>
      locks.request('a', { mode: 'shared' }, async () => {
        order.push(`${label} in`);
        await pause(10);
        order.push(`${label} out`);
      });
    await Promise.all([reader('r1'), reader('r2'), locks.request('a', { mode: 'exclusive' }, async () => void order.push('w'))]);
    expect(order).toEqual(['r1 in', 'r2 in', 'r1 out', 'r2 out', 'w']);
  });

  it('releases the lock when the holder throws', async () => {
    const locks = new PageLockManager();
    await expect(locks.request('a', { mode: 'exclusive' }, async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await locks.request('a', { mode: 'exclusive' }, async () => 'next')).toBe('next');
  });
});

describe('holdingFiles', () => {
  it('holds every named file at once, so a holder of any of them waits', async () => {
    const locks = new PageLockManager();
    const order: string[] = [];
    const folder = holdingFiles(locks, ['F/a.md', 'F/b.md'], async () => {
      order.push('folder in');
      await pause(10);
      order.push('folder out');
    });
    await pause(1);
    const write = locks.request(fileLockName('F/b.md'), { mode: 'exclusive' }, async () => void order.push('write'));
    await Promise.all([folder, write]);
    expect(order).toEqual(['folder in', 'folder out', 'write']);
  });

  it('takes the locks in one order whatever order it is given, so two holders never deadlock', async () => {
    const locks = new PageLockManager();
    const slow = async () => pause(5);
    const done = await Promise.race([
      Promise.all([
        holdingFiles(locks, ['z.md', 'a.md', 'm.md'], slow),
        holdingFiles(locks, ['a.md', 'm.md', 'z.md'].reverse(), slow),
        holdingFiles(locks, ['m.md', 'z.md', 'a.md'], slow),
      ]).then(() => 'done'),
      pause(500).then(() => 'deadlocked'),
    ]);
    expect(done).toBe('done');
  });

  it('runs the action at once when there are no Web Locks', async () => {
    expect(await holdingFiles(null, ['a.md'], async () => 'ran')).toBe('ran');
  });
});
