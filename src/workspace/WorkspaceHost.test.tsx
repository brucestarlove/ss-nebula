/**
 * The workspace as a host and a server shape it: the account banner, the card's context reaching
 * the store, the frame (`ready`, `title`, the host's `navigate`), and deleting and restoring a
 * server project. Stores and registries are in memory; the page's window is given a fake parent
 * where the frame is tested. No sentence is asserted.
 */
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AccountStatus } from '../files/account';
import type { RemovedProject } from '../files/serverContract';
import type { Hosting } from '../files/places';
import type { FileViewProps, ProjectRecord } from '../files/types';
import { createFakeRegistry, type FakeRegistry } from './dev/fakeRegistry';
import type { MemoryStore } from './dev/memoryStore';
import { byLabel, render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}
const probeView = () => Probe;
const probed = (container: HTMLElement) => container.querySelector('[data-testid="probe"]')?.textContent ?? null;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({ matches: false, media: query, onchange: null, addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false }),
  });
  const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.clear();
  vi.restoreAllMocks();
});

/** A store with the account and card-context calls a server project's has. */
function withServerCalls(store: MemoryStore) {
  const listeners = new Set<(status: AccountStatus) => void>();
  let out: { signIn?: string } | null = null;
  const contexts = new Map<string, string>();
  const calls = {
    setContext: vi.fn((path: string, context: string | null) => {
      if (context === null) contexts.delete(path);
      else contexts.set(path, context);
    }),
  };
  Object.assign(store, {
    onAccount(listener: (status: AccountStatus) => void) {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    signedOut: () => out,
    retryAccount: async () => {},
    setContext: calls.setContext,
    contextOf: (path: string) => contexts.get(path),
    onContext: () => () => {},
  });
  return {
    ...calls,
    signOut() {
      out = {};
      [...listeners].forEach((listener) => listener('signed-out'));
    },
    signIn() {
      out = null;
      [...listeners].forEach((listener) => listener('signed-in'));
    },
  };
}

/** The fake registry, its projects as a server's, and projects that can be deleted and restored. */
function serverSide() {
  const base: FakeRegistry = createFakeRegistry();
  const hidden = new Set<string>();
  const removed: RemovedProject[] = [];
  const asServer = (record: ProjectRecord): ProjectRecord => ({ ...record, tier: 'server', server: { label: 'suite', folder: '' } });
  const registry = {
    ...base,
    list: vi.fn(async () => (await base.list()).filter((record) => !hidden.has(record.id)).map(asServer)),
    remove: vi.fn(async (id: string) => {
      const record = (await base.list()).find((item) => item.id === id)!;
      hidden.add(id);
      removed.push({ id, name: record.name, color: record.color, removed: '2026-11-21T10:00:00.000Z', purgeAfter: '2026-12-05T10:00:00.000Z' });
    }),
    open: base.open,
    update: base.update,
    create: base.create,
    current: base.current,
  };
  const restore = vi.fn(async (id: string) => {
    hidden.delete(id);
    removed.splice(0, removed.length, ...removed.filter((item) => item.id !== id));
  });
  const list = vi.fn(async () => [...removed]);
  const hosting: Hosting = {
    homes: ['server'],
    server: { label: 'suite', canCreate: false, versions: true, canRemove: true, removed: { list, restore } },
  };
  return { base, registry, hosting, hidden, removed, restore, list };
}

const gear = () => document.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]')!;
async function openProjectSettings() {
  await act(async () => gear().click());
  await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
}
const confirmOpen = () => act(async () => document.querySelector<HTMLButtonElement>('dialog[open] .welcome-dialog-cta')!.click());
const switcher = () => rendered!.container.querySelector('.ws-switcher')?.textContent ?? '';

describe('the account banner in the workspace', () => {
  it('shows once for a store that is signed out, whatever is open, and goes when it is signed in again', async () => {
    const base = createFakeRegistry();
    const account = withServerCalls(base.stores.get('night-sky')!);
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    expect(document.querySelectorAll('.ws-account-banner')).toHaveLength(0);
    await act(async () => account.signOut());
    expect(document.querySelectorAll('.ws-account-banner')).toHaveLength(1);
    await act(async () => account.signIn());
    expect(document.querySelectorAll('.ws-account-banner')).toHaveLength(0);
  });

  it('a project with no account (the browser, a folder) shows no banner', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    expect(document.querySelectorAll('.ws-account-banner')).toHaveLength(0);
  });
});

describe('the card a file was opened from', () => {
  it('reaches the store as setContext(path, context) when the file opens, and is kept nowhere on the device', async () => {
    const base = createFakeRegistry();
    const store = withServerCalls(base.stores.get('night-sky')!);
    const path = 'Guides/Observing plan.md';
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} initialFile={{ projectId: 'night-sky', path, context: 'orbit:card/board-1/7' }} />);
    await waitFor(() => expect(store.setContext).toHaveBeenCalledWith(path, 'orbit:card/board-1/7'));
    await waitFor(() => expect(document.querySelectorAll('.ws-context-mark')).toHaveLength(1));
    const kept = [...Array(localStorage.length).keys()].map((index) => localStorage.getItem(localStorage.key(index)!) ?? '');
    expect(kept.filter((value) => value.includes('orbit:card/board-1/7'))).toEqual([]);
    expect(window.location.search).not.toContain('orbit:card');
  });

  it('a file opened by a link with no context stops naming an earlier card’s', async () => {
    const base = createFakeRegistry();
    const store = withServerCalls(base.stores.get('night-sky')!);
    const path = 'Guides/Observing plan.md';
    store.setContext(path, 'orbit:card/board-1/7'); // an earlier card's
    store.setContext.mockClear();
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} initialFile={{ projectId: 'night-sky', path }} />);
    await waitFor(() => expect(store.setContext).toHaveBeenCalledWith(path, null));
    expect(document.querySelectorAll('.ws-context-mark')).toHaveLength(0);
  });

  it('a plain restore of the last session, with no link, sets no context at all', async () => {
    const base = createFakeRegistry();
    const store = withServerCalls(base.stores.get('night-sky')!);
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    await settle(20);
    expect(store.setContext).not.toHaveBeenCalled();
  });
});

describe('the frame', () => {
  type Sent = [message: { type: string; title?: string }, target: string];
  const parent = { postMessage: vi.fn<(message: unknown, target: string) => void>() };
  const original = Object.getOwnPropertyDescriptor(window, 'parent');

  beforeEach(() => {
    parent.postMessage.mockReset();
    Object.defineProperty(window, 'parent', { configurable: true, value: parent });
  });
  afterEach(() => {
    if (original) Object.defineProperty(window, 'parent', original);
    else delete (window as { parent?: unknown }).parent;
  });

  const sent = () => parent.postMessage.mock.calls as unknown as Sent[];
  /** The host says something, from its frame, on the app's own origin. */
  const hostSays = (data: unknown) =>
    act(async () => {
      window.dispatchEvent(Object.assign(new Event('message'), { data, source: parent, origin: window.location.origin }));
    });

  it('says ready once, to its own origin, when the project list is loaded and the open project is ready', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    await settle(30);
    expect(sent().filter(([message]) => message.type === 'ready')).toHaveLength(1);
    for (const [, target] of sent()) expect(target).toBe(window.location.origin);
  });

  it('says the title for the active file, and again only when it changes', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    await settle(30);
    const titles = () => sent().filter(([message]) => message.type === 'title').map(([message]) => message.title);
    expect(titles()).toHaveLength(1);
    expect(titles()[0]).toContain('Night Sky');
    expect(titles()[0]).toContain('Observing plan');
    const tab = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent?.includes('Winter hexagon'));
    await act(async () => tab?.click());
    await waitFor(() => expect(titles()).toHaveLength(2));
    expect(titles()[1]).not.toBe(titles()[0]);
    await settle(30);
    expect(titles()).toHaveLength(2);
  });

  it('navigate opens another project first, then the file once it is listed, with the card’s context', async () => {
    const base = createFakeRegistry();
    const pulse = withServerCalls(base.stores.get('pulse')!);
    const file = (await base.stores.get('pulse')!.list()).find((entry) => entry.type === 'file' && !entry.path.startsWith('.nebula'))!.path;
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    await hostSays({ starscape: 1, type: 'navigate', project: 'pulse', path: file, context: 'orbit:card/b/3' });
    await waitFor(() => expect(probed(rendered!.container)).toBe(file));
    expect(switcher()).toContain('Pulse');
    expect(pulse.setContext).toHaveBeenCalledWith(file, 'orbit:card/b/3');
  });

  it('navigate with a context the server would refuse still opens the file, naming nothing', async () => {
    const base = createFakeRegistry();
    const store = withServerCalls(base.stores.get('night-sky')!);
    rendered = await render(<Workspace registry={base} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    const tab = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((item) => item.textContent?.includes('Winter hexagon'));
    await act(async () => tab?.click());
    await hostSays({ starscape: 1, type: 'navigate', path: 'Guides/Observing plan.md', context: 'has a space' });
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    expect(store.setContext).toHaveBeenLastCalledWith('Guides/Observing plan.md', null);
  });

  it('navigate with neither a project nor a path does nothing, and a message from another window is ignored', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probed(rendered!.container)).toBe('Guides/Observing plan.md'));
    await hostSays({ starscape: 1, type: 'navigate' });
    await act(async () => {
      window.dispatchEvent(Object.assign(new Event('message'), { data: { starscape: 1, type: 'navigate', project: 'pulse' }, source: {}, origin: window.location.origin }));
    });
    await settle(50);
    expect(probed(rendered.container)).toBe('Guides/Observing plan.md');
    expect(switcher()).toContain('Night Sky');
  });
});

describe('deleting and restoring a server project', () => {
  it('Delete project… asks, then removes it through the registry, reloads the list and moves to another project', async () => {
    const { registry, hosting } = serverSide();
    rendered = await render(<Workspace registry={registry} hosting={hosting} persistent viewFor={probeView} />);
    await waitFor(() => expect(switcher()).toContain('Night Sky'));
    await openProjectSettings();
    await act(async () => byLabel(document.body, 'Delete project…')!.click());
    expect(registry.remove).not.toHaveBeenCalled(); // asked first
    const before = registry.list.mock.calls.length;
    await confirmOpen();
    await waitFor(() => expect(registry.remove).toHaveBeenCalledWith('night-sky'));
    await waitFor(() => expect(registry.list.mock.calls.length).toBeGreaterThan(before));
    await waitFor(() => expect(switcher()).not.toContain('Night Sky'));
    expect(switcher()).not.toBe('');
  });

  it('cancelling the question deletes nothing', async () => {
    const { registry, hosting } = serverSide();
    rendered = await render(<Workspace registry={registry} hosting={hosting} persistent viewFor={probeView} />);
    await waitFor(() => expect(switcher()).toContain('Night Sky'));
    await openProjectSettings();
    await act(async () => byLabel(document.body, 'Delete project…')!.click());
    await act(async () => [...document.querySelector('dialog[open]')!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click());
    await settle(30);
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it('a server that refuses keeps the project open', async () => {
    const { registry, hosting } = serverSide();
    registry.remove.mockRejectedValueOnce(new Error('The server said no'));
    rendered = await render(<Workspace registry={registry} hosting={hosting} persistent viewFor={probeView} />);
    await waitFor(() => expect(switcher()).toContain('Night Sky'));
    await openProjectSettings();
    await act(async () => byLabel(document.body, 'Delete project…')!.click());
    await confirmOpen();
    await waitFor(() => expect(registry.remove).toHaveBeenCalledTimes(1));
    await settle(50);
    expect(switcher()).toContain('Night Sky');
  });

  it('without canRemove there is no Delete project… in Settings, and nothing to remove', async () => {
    const { registry, hosting } = serverSide();
    const noRemove: Hosting = { ...hosting, server: { label: 'suite', canCreate: false } };
    rendered = await render(<Workspace registry={registry} hosting={noRemove} persistent viewFor={probeView} />);
    await waitFor(() => expect(switcher()).toContain('Night Sky'));
    await openProjectSettings();
    expect(byLabel(document.body, 'Delete project…')).toBeNull();
    expect(registry.remove).not.toHaveBeenCalled();
  });

  it('Recently deleted lists what the server holds when Settings opens on Project, and Restore brings the project back', async () => {
    const { registry, hosting, hidden, removed, restore, list } = serverSide();
    hidden.add('pulse');
    removed.push({ id: 'pulse', name: 'Pulse', color: '#7c8cff', removed: '2026-11-21T10:00:00.000Z', purgeAfter: '2026-12-05T10:00:00.000Z' });
    rendered = await render(<Workspace registry={registry} hosting={hosting} persistent viewFor={probeView} />);
    await waitFor(() => expect(switcher()).toContain('Night Sky'));
    expect(list).not.toHaveBeenCalled(); // nothing is asked while Settings is shut
    await openProjectSettings();
    await waitFor(() => expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(1));
    const before = registry.list.mock.calls.length;
    await act(async () => byLabel(document.body, 'Restore Pulse')!.click());
    await waitFor(() => expect(restore).toHaveBeenCalledWith('pulse'));
    await waitFor(() => expect(registry.list.mock.calls.length).toBeGreaterThan(before)); // the project list is read again
    await waitFor(() => expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(0)); // and no longer has it
    expect((await registry.list()).map((record) => record.id)).toContain('pulse');
  });

  it('Recently deleted is also there with no project open, so the last project deleted can come back', async () => {
    const server = serverSide();
    for (const id of ['night-sky', 'pulse', ...(await server.base.list()).map((record) => record.id)]) server.hidden.add(id);
    server.removed.push({ id: 'night-sky', name: 'Night Sky', color: '#7c8cff', removed: 'x', purgeAfter: '2026-12-05T10:00:00.000Z' });
    rendered = await render(<Workspace registry={server.registry} hosting={server.hosting} persistent viewFor={probeView} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-rail')).not.toBeNull());
    await act(async () => gear().click());
    await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
    await waitFor(() => expect(document.querySelectorAll('.ws-removed-row')).toHaveLength(1));
    await act(async () => byLabel(document.body, 'Restore Night Sky')!.click());
    await waitFor(() => expect(server.restore).toHaveBeenCalledWith('night-sky'));
    await waitFor(() => expect(switcher()).toContain('Night Sky')); // opened, as none was
  });

  it('where the host gives no removed projects, Settings has no Recently deleted section at all', async () => {
    const sections = async (hosting: Hosting) => {
      const { registry } = serverSide();
      rendered = await render(<Workspace registry={registry} hosting={hosting} persistent viewFor={probeView} />);
      await waitFor(() => expect(switcher()).toContain('Night Sky'));
      await openProjectSettings();
      await settle(20);
      const count = document.querySelectorAll('.ws-settings .drawer-section').length;
      await rendered.unmount();
      rendered = null;
      return count;
    };
    const { hosting } = serverSide();
    const withHost = await sections(hosting);
    const without = await sections({ ...hosting, server: { label: 'suite', canCreate: false, versions: true, canRemove: true } });
    expect(without).toBe(withHost - 1);
  });
});
