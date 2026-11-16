import { afterEach, describe, expect, it } from 'vitest';
import { OpfsFileStore } from './opfsStore';
import type { FileChange } from './types';

/** Move to a folder… is said on the project's channel (S3): every store of
 * the project, in every tab, tells its watchers. */
const stops: Array<() => void> = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop();
});

describe('a project store hears its project moving', () => {
  it('turns moving, moved and move-failed on the channel into changes', async () => {
    const store = new OpfsFileStore({} as FileSystemDirectoryHandle, { channel: 'nebula:project:moving-test', fileLocks: null });
    const heard: FileChange[] = [];
    stops.push(store.watch((change) => heard.push(change)));
    const channel = new BroadcastChannel('nebula:project:moving-test');
    for (const state of ['moving', 'moved', 'move-failed', 'nonsense']) channel.postMessage({ nebulaMove: 1, state });
    channel.close();
    const end = Date.now() + 2000;
    while (heard.length < 3 && Date.now() < end) await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(heard).toEqual([{ type: 'moving' }, { type: 'moved' }, { type: 'move-failed' }]);
  });
});
