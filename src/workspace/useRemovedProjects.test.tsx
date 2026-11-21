/**
 * "Recently deleted": the hook that asks the server for deleted projects and restores them, and
 * the list that shows them. What is asked and when, what a restore calls and in what order, and
 * which controls are there and disabled: no sentence is asserted.
 */
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemovedProjects } from '../files/places';
import type { RemovedProject } from '../files/serverContract';
import { RecentlyDeleted } from './components/RecentlyDeleted';
import { useRemovedProjects, type RecentlyDeleted as State } from './useRemovedProjects';
import { byLabel, click, render, settle, waitFor, type Rendered } from './views/testing/render';

const removed = (id: string, name = id): RemovedProject => ({ id, name, color: '#7c8cff', removed: '2026-11-21T10:00:00.000Z', purgeAfter: '2026-12-05T10:00:00.000Z' });

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
});

/** A server's removed projects: restoring one takes it from the list. */
function source(initial: RemovedProject[]) {
  let held = [...initial];
  const order: string[] = [];
  let hold: Promise<void> | null = null;
  const api = {
    list: vi.fn(async () => {
      order.push('list');
      return [...held];
    }),
    restore: vi.fn(async (id: string) => {
      order.push(`restore ${id}`);
      if (hold) await hold;
      if (!held.some((item) => item.id === id)) throw Object.assign(new Error('That project has been deleted for good'), { code: 'no-project' });
      held = held.filter((item) => item.id !== id);
    }),
  } satisfies RemovedProjects;
  return {
    api,
    order,
    purge: (id: string) => void (held = held.filter((item) => item.id !== id)),
    holdRestores() {
      let release!: () => void;
      hold = new Promise<void>((resolve) => (release = resolve));
      return () => {
        hold = null;
        release();
      };
    },
  };
}

function Probe({ src, wanted, restored, into }: { src: RemovedProjects | undefined; wanted: boolean; restored: (project: RemovedProject) => Promise<void> | void; into: { state?: State } }) {
  into.state = useRemovedProjects(src, wanted, restored);
  return null;
}

async function probe(src: RemovedProjects | undefined, wanted: boolean, restored: (project: RemovedProject) => Promise<void> | void = () => {}) {
  const into: { state?: State } = {};
  rendered = await render(<Probe src={src} wanted={wanted} restored={restored} into={into} />);
  return {
    into,
    again: (next: { src?: RemovedProjects | undefined; wanted?: boolean }) =>
      rendered!.rerender(<Probe src={'src' in next ? next.src : src} wanted={next.wanted ?? wanted} restored={restored} into={into} />),
  };
}

describe('useRemovedProjects', () => {
  it('asks nothing while it isn’t wanted, or where the host gives no source', async () => {
    const { api } = source([removed('a')]);
    const closed = await probe(api, false);
    await settle(10);
    expect(api.list).not.toHaveBeenCalled();
    expect(closed.into.state?.projects).toBeNull();
    await rendered!.unmount();
    const none = await probe(undefined, true);
    await settle(10);
    expect(none.into.state?.projects).toBeNull();
  });

  it('asks when it is wanted, and each time it is wanted again, showing nothing stale between', async () => {
    const server = source([removed('a')]);
    const hook = await probe(server.api, true);
    await waitFor(() => expect(hook.into.state?.projects?.map((item) => item.id)).toEqual(['a']));
    expect(server.api.list).toHaveBeenCalledTimes(1);

    await hook.again({ wanted: false });
    expect(hook.into.state?.projects).toBeNull(); // nothing kept while Settings is shut
    server.purge('a');
    await hook.again({ wanted: true });
    await waitFor(() => expect(hook.into.state?.projects).toEqual([]));
    expect(server.api.list).toHaveBeenCalledTimes(2);
  });

  it('a failed read sets an error and no list, and reload asks again', async () => {
    const server = source([removed('a')]);
    server.api.list.mockRejectedValueOnce(new Error('The server isn’t answering'));
    const hook = await probe(server.api, true);
    await waitFor(() => expect(hook.into.state?.error).toEqual(expect.any(String)));
    expect(hook.into.state?.projects).toBeNull();
    await act(async () => hook.into.state?.reload());
    await waitFor(() => expect(hook.into.state?.projects?.map((item) => item.id)).toEqual(['a']));
    expect(hook.into.state?.error).toBeNull();
  });

  it('restore calls the server, then the host’s restored with that project, then reads the list again, which no longer has it', async () => {
    const server = source([removed('a', 'Alpha'), removed('b', 'Beta')]);
    const restored = vi.fn(async (project: RemovedProject) => void server.order.push(`restored ${project.id}`));
    const hook = await probe(server.api, true, restored);
    await waitFor(() => expect(hook.into.state?.projects).toHaveLength(2));
    await act(async () => hook.into.state?.restore('a'));
    await waitFor(() => expect(hook.into.state?.projects?.map((item) => item.id)).toEqual(['b']));
    expect(server.order).toEqual(['list', 'restore a', 'restored a', 'list']);
    expect(restored).toHaveBeenCalledWith(expect.objectContaining({ id: 'a', name: 'Alpha' }));
    expect(hook.into.state?.busy).toBeNull();
    expect(hook.into.state?.error).toBeNull();
  });

  it('busy holds the id while a restore runs', async () => {
    const server = source([removed('a')]);
    const release = server.holdRestores();
    const hook = await probe(server.api, true);
    await waitFor(() => expect(hook.into.state?.projects).toHaveLength(1));
    await act(async () => hook.into.state?.restore('a'));
    expect(hook.into.state?.busy).toBe('a');
    await act(async () => release());
    await waitFor(() => expect(hook.into.state?.busy).toBeNull());
  });

  // Was a bug (found by this test): the refusal's error is set, and then the list read that follows
  // succeeds and `setError(null)` clears it, so the person sees "Couldn't restore" for one round trip at
  // most. src/workspace/useRemovedProjects.ts: the effect's success branch should leave a restore's
  // error alone (clear it only on a reload the person asked for). Fixed at integration.
  it('a restore the server refuses (purged meanwhile) keeps its error after the list is read again, and never calls restored', async () => {
    const server = source([removed('a', 'Alpha')]);
    const restored = vi.fn();
    const hook = await probe(server.api, true, restored);
    await waitFor(() => expect(hook.into.state?.projects).toHaveLength(1));
    server.purge('a');
    await act(async () => hook.into.state?.restore('a'));
    await waitFor(() => expect(hook.into.state?.projects).toEqual([]));
    expect(restored).not.toHaveBeenCalled();
    expect(hook.into.state?.error).toEqual(expect.any(String));
    expect(hook.into.state?.busy).toBeNull();
  });

  it('a refused restore never calls restored, frees the buttons and reads the list again', async () => {
    const server = source([removed('a', 'Alpha')]);
    const restored = vi.fn();
    const hook = await probe(server.api, true, restored);
    await waitFor(() => expect(hook.into.state?.projects).toHaveLength(1));
    server.purge('a');
    await act(async () => hook.into.state?.restore('a'));
    await waitFor(() => expect(server.api.list).toHaveBeenCalledTimes(2));
    expect(server.api.restore).toHaveBeenCalledTimes(1);
    expect(restored).not.toHaveBeenCalled();
    expect(hook.into.state?.busy).toBeNull();
  });

  it('a restore of an id that isn’t listed does nothing', async () => {
    const server = source([removed('a')]);
    const hook = await probe(server.api, true);
    await waitFor(() => expect(hook.into.state?.projects).toHaveLength(1));
    await act(async () => hook.into.state?.restore('zzz'));
    expect(server.api.restore).not.toHaveBeenCalled();
  });
});

describe('RecentlyDeleted', () => {
  const state = (patch: Partial<State> = {}): State => ({ projects: [removed('a', 'Alpha'), removed('b', 'Beta')], error: null, busy: null, restore: vi.fn(), reload: vi.fn(), ...patch });
  const rows = () => document.querySelectorAll('.ws-removed-row');
  const restoreButtons = () => [...document.querySelectorAll<HTMLButtonElement>('.ws-removed-row button')];

  it('one row per project with a Restore named for it, calling restore with its id', async () => {
    const current = state();
    rendered = await render(<RecentlyDeleted {...current} />);
    expect(rows()).toHaveLength(2);
    expect(restoreButtons().map((button) => button.getAttribute('aria-label'))).toEqual(['Restore Alpha', 'Restore Beta']);
    await click(byLabel(document.body, 'Restore Beta'));
    expect(current.restore).toHaveBeenCalledTimes(1);
    expect(current.restore).toHaveBeenCalledWith('b');
  });

  it('every Restore is disabled while one runs', async () => {
    rendered = await render(<RecentlyDeleted {...state({ busy: 'a' })} />);
    expect(restoreButtons().map((button) => button.disabled)).toEqual([true, true]);
    await rendered.rerender(<RecentlyDeleted {...state()} />);
    expect(restoreButtons().map((button) => button.disabled)).toEqual([false, false]);
  });

  it('shows the day each goes for good from purgeAfter, and none when it has no usable date', async () => {
    rendered = await render(<RecentlyDeleted {...state({ projects: [removed('a'), { ...removed('b'), purgeAfter: 'soon' }] })} />);
    const when = [...document.querySelectorAll('.ws-removed-row')].map((row) => row.querySelector('.ws-removed-when')?.textContent ?? '');
    expect(when[0]).toMatch(/5 Dec 2026/);
    expect(when[1]).toBe('');
  });

  it('with nothing deleted there are no rows, and while it waits there are no rows or Restore buttons', async () => {
    rendered = await render(<RecentlyDeleted {...state({ projects: [] })} />);
    expect(document.querySelectorAll('.ws-removed-list')).toHaveLength(0);
    await rendered.rerender(<RecentlyDeleted {...state({ projects: null })} />);
    expect(rows()).toHaveLength(0);
    expect(byLabel(document.body, 'Try again')).toBeNull();
  });

  it('a failed read shows an alert and Try again, which calls reload', async () => {
    const current = state({ projects: null, error: 'The server isn’t answering' });
    rendered = await render(<RecentlyDeleted {...current} />);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    await click(byLabel(document.body, 'Try again'));
    expect(current.reload).toHaveBeenCalledTimes(1);
  });

  it('a failed restore keeps the list and shows the alert', async () => {
    rendered = await render(<RecentlyDeleted {...state({ error: 'Couldn’t restore Alpha. Gone.' })} />);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(rows()).toHaveLength(2);
    expect(byLabel(document.body, 'Try again')).toBeNull();
  });
});
