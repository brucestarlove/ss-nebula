/**
 * The right panel's History (HistoryPanel.tsx) against a stub store: when it asks the server, what
 * a restore calls (and over which version), what a 412 does, paging, and what a server without
 * versions or a project that keeps none gets. Controls are found by their short names or classes;
 * no sentence is asserted.
 */
import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { FileChangedError } from '../../files/errors';
import type { ChangeRecord } from '../../files/history';
import type { VersionInfo, VersionsPage } from '../../files/serverContract';
import type { Actor, FileEntry, FileStore } from '../../files/types';
import { render, type Rendered } from '../views/testing/render';
import { HistoryPanel, SETTLE_MS, type HistoryProps } from './HistoryPanel';

beforeAll(() => {
  const proto = HTMLDialogElement.prototype as { showModal?: () => void; close?: () => void };
  proto.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
  };
  proto.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute('open');
    this.dispatchEvent(new Event('close'));
  };
});

const you: Actor = { type: 'human', id: 'u-1', name: 'Bruce' };
const lear: Actor = { type: 'agent', id: 'lear', name: 'Lear' };
const NOW = Date.parse('2026-11-21T12:00:00.000Z');

const version = (id: string, patch: Partial<VersionInfo> = {}): VersionInfo => ({ version: id, at: '2026-11-21T10:00:00.000Z', size: 100, current: false, path: 'Notes/a.md', ...patch });
const entry = (patch: Partial<FileEntry> = {}): FileEntry => ({ path: 'Notes/a.md', name: 'a.md', type: 'file', size: 100, modified: NOW - 60_000, ...patch });

/** Three versions: the current one (yours), one by an agent, the oldest by no one Nebula knows. */
const THREE: VersionsPage = {
  versions: [
    version('v3', { current: true, actor: you, size: 130, at: '2026-11-21T11:00:00.000Z' }),
    version('v2', { actor: lear, size: 100, at: '2026-11-21T10:00:00.000Z' }),
    version('v1', { size: 70, at: '2026-11-20T10:00:00.000Z' }),
  ],
  next: null,
};

function stub(pages: VersionsPage | ((options?: { before?: string; limit?: number }) => Promise<VersionsPage>) = THREE) {
  return {
    versions: vi.fn(async (_path: string, options?: { before?: string; limit?: number }) => (typeof pages === 'function' ? pages(options) : pages)),
    readVersion: vi.fn(async () => new Blob(['old'])),
    restore: vi.fn(async (): Promise<FileEntry> => entry()),
    changes: vi.fn(async (): Promise<ChangeRecord[]> => []),
  };
}

let rendered: Rendered | null = null;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  vi.useRealTimers();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

function props(store: ReturnType<typeof stub> | FileStore | null, patch: Partial<HistoryProps> = {}): HistoryProps {
  return { projectId: 'night-sky', entry: entry(), kind: 'note', store: store as FileStore | null, tier: 'server', versions: true, you, ...patch };
}

async function show(store: ReturnType<typeof stub>, patch: Partial<HistoryProps> = {}) {
  const p = props(store, patch);
  rendered = await render(<HistoryPanel {...p} />);
  return { p, again: (next: Partial<HistoryProps>) => rendered!.rerender(<HistoryPanel {...{ ...p, ...next }} />) };
}

const rows = () => [...document.querySelectorAll<HTMLElement>('.ws-history-row')];
const buttons = (row: Element) => [...row.querySelectorAll('button')].map((button) => button.textContent);
const openDialog = () => document.querySelector<HTMLDialogElement>('dialog[open]');
const confirmOpen = async () => {
  await act(async () => document.querySelector<HTMLButtonElement>('dialog[open] .welcome-dialog-cta')!.click());
};
const clickIn = async (row: Element, label: string) => {
  await act(async () => [...row.querySelectorAll('button')].find((button) => button.textContent === label)!.click());
};

describe('HistoryPanel: the versions', () => {
  it('lists the file’s versions newest first, marks the current one, and offers Preview and Restore on every other', async () => {
    const store = stub();
    await show(store);
    await advance(200);
    expect(rows()).toHaveLength(3);
    expect(rows().map((row) => row.hasAttribute('data-current'))).toEqual([true, false, false]);
    expect(rows().map(buttons)).toEqual([[], ['Preview', 'Restore'], ['Preview', 'Restore']]);
    expect(store.versions).toHaveBeenCalledWith('Notes/a.md', { limit: 20 });
  });

  it('says who: you by that word and not by name, another by name; the full time is in the time element', async () => {
    await show(stub());
    await advance(200);
    const who = rows().map((row) => row.querySelector('.ws-history-who')?.textContent ?? '');
    expect(who[0]).not.toContain('Bruce');
    expect(who[0]).not.toBe('');
    expect(who[1]).toBe('Lear');
    expect(who[2]).not.toBe('');
    expect(who[2]).not.toBe('Lear');
    const time = rows()[1].querySelector('time')!;
    expect(time.getAttribute('datetime')).toBe('2026-11-21T10:00:00.000Z');
    expect(time.getAttribute('title')).toBeTruthy();
    expect(time.getAttribute('title')).not.toBe(time.textContent);
  });

  it('shows the size change from the version below it, and the oldest known by its size', async () => {
    await show(stub());
    await advance(200);
    const notes = rows().map((row) => row.querySelector('.ws-history-note')?.textContent ?? '');
    expect(notes[0]).toContain('+'); // 130 B over 100 B
    expect(notes[1]).toContain('+'); // 100 B over 70 B
    expect(notes[2]).not.toMatch(/^[+−]/); // the oldest has nothing below it: its own size
    await rendered!.unmount();
    rendered = null;
    const smaller = stub({ versions: [version('v2', { current: true, size: 70 }), version('v1', { size: 100 })], next: null });
    await show(smaller);
    await advance(200);
    expect(rows()[0].querySelector('.ws-history-note')?.textContent).toContain('−');
  });

  it('a version made by restoring another says which, and one from a card says so', async () => {
    const store = stub({
      versions: [version('v3', { current: true, restoredFrom: 'v1' }), version('v2', { restoredFrom: 'gone' }), version('v1', { context: 'orbit:card/b/1' })],
      next: null,
    });
    await show(store);
    await advance(200);
    const notes = rows().map((row) => [...row.querySelectorAll('.ws-history-note')].length);
    expect(notes).toEqual([2, 2, 2]); // the size line, then the restored-from or the card
    expect(rows()[2].querySelector('.ws-history-context')).not.toBeNull();
    expect(rows()[0].querySelector('.ws-history-context')).toBeNull();
    // a restoredFrom that is in the list names its time; one that isn't doesn't
    const [inList, notInList] = [rows()[0], rows()[1]].map((row) => row.querySelectorAll('.ws-history-note')[1].textContent ?? '');
    expect(inList).not.toBe(notInList);
  });
});

describe('HistoryPanel: when it asks', () => {
  it('asks once when the file opens, after 150 ms, and not again for a re-render', async () => {
    const store = stub();
    const { again } = await show(store);
    await advance(149);
    expect(store.versions).not.toHaveBeenCalled();
    await advance(1);
    expect(store.versions).toHaveBeenCalledTimes(1);
    await again({ you: { ...you } });
    await advance(5_000);
    expect(store.versions).toHaveBeenCalledTimes(1);
  });

  it('a new modified or size on the same file asks once, 600 ms after the last change', async () => {
    const store = stub();
    const { again } = await show(store);
    await advance(200);
    expect(store.versions).toHaveBeenCalledTimes(1);
    await again({ entry: entry({ modified: NOW + 1_000 }) });
    await advance(100);
    await again({ entry: entry({ modified: NOW + 2_000, size: 140 }) });
    await advance(SETTLE_MS - 1);
    expect(store.versions).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(store.versions).toHaveBeenCalledTimes(2);
    await advance(5_000);
    expect(store.versions).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['its modified time', { modified: NOW + 5_000 }],
    ['its size', { size: 4_000 }],
    ['who last changed it', { modifiedBy: lear }],
  ])('a change in %s alone asks again', async (_name, patch) => {
    const store = stub();
    const { again } = await show(store);
    await advance(200);
    await again({ entry: entry(patch) });
    await advance(SETTLE_MS);
    expect(store.versions).toHaveBeenCalledTimes(2);
  });

  it('switching file asks for that file and drops the old list at once; a slow answer for the old file never fills the new one', async () => {
    let answerOld!: (page: VersionsPage) => void;
    const store = stub(() => new Promise<VersionsPage>(() => {}));
    store.versions.mockImplementationOnce(() => new Promise<VersionsPage>((resolve) => (answerOld = resolve)));
    const { again } = await show(store);
    await advance(200); // asked for a.md: not answered yet
    const other = entry({ path: 'Notes/b.md', name: 'b.md' });
    store.versions.mockImplementationOnce(async () => ({ versions: [version('b1', { current: true, path: 'Notes/b.md' })], next: null }));
    await again({ entry: other });
    expect(rows()).toHaveLength(0); // nothing of a.md's under b.md
    await advance(200);
    expect(store.versions).toHaveBeenLastCalledWith('Notes/b.md', { limit: 20 });
    expect(rows()).toHaveLength(1);
    await act(async () => answerOld(THREE)); // the answer for a.md arrives late
    expect(rows()).toHaveLength(1);
  });

  it('a list that was loaded is dropped when another file opens, before the new answer', async () => {
    const store = stub();
    const { again } = await show(store);
    await advance(200);
    expect(rows()).toHaveLength(3);
    store.versions.mockImplementation(() => new Promise<VersionsPage>(() => {}));
    await again({ entry: entry({ path: 'Notes/b.md', name: 'b.md' }) });
    expect(rows()).toHaveLength(0);
  });

  it('a panel that is closed (unmounted) before the pause asks nothing', async () => {
    const store = stub();
    await show(store);
    await rendered!.unmount();
    rendered = null;
    await advance(5_000);
    expect(store.versions).not.toHaveBeenCalled();
  });

  it('a project in the browser or a folder, or no file open, asks nothing and offers nothing', async () => {
    for (const patch of [{ tier: 'browser' as const }, { tier: 'folder' as const }, { entry: null, kind: null }]) {
      const store = stub();
      await show(store, patch);
      await advance(5_000);
      expect(store.versions).not.toHaveBeenCalled();
      expect(store.changes).not.toHaveBeenCalled();
      expect(document.querySelectorAll('button')).toHaveLength(0);
      await rendered!.unmount();
      rendered = null;
    }
    const plain = { list: async () => [] } as unknown as FileStore; // a server project whose store has no history calls
    rendered = await render(<HistoryPanel {...props(plain)} />);
    await advance(5_000);
    expect(document.querySelectorAll('button')).toHaveLength(0);
  });
});

describe('HistoryPanel: paging', () => {
  it('Show earlier appears with `next`, asks before it with the page size, appends, and goes at the end', async () => {
    const page2: VersionsPage = { versions: [version('v0', { size: 50, at: '2026-11-19T10:00:00.000Z' })], next: null };
    const store = stub(async (options) => (options?.before ? page2 : { ...THREE, next: 'cursor-1' }));
    await show(store);
    await advance(200);
    const more = () => document.querySelector<HTMLButtonElement>('.ws-history-more');
    expect(more()).not.toBeNull();
    expect(rows()).toHaveLength(3);
    await act(async () => more()!.click());
    expect(store.versions).toHaveBeenLastCalledWith('Notes/a.md', { before: 'cursor-1', limit: 20 });
    expect(rows()).toHaveLength(4);
    expect(more()).toBeNull();
  });

  it('a page that fails keeps the list and the button', async () => {
    const store = stub(async (options) => {
      if (options?.before) throw new Error('down');
      return { ...THREE, next: 'cursor-1' };
    });
    await show(store);
    await advance(200);
    await act(async () => document.querySelector<HTMLButtonElement>('.ws-history-more')!.click());
    expect(rows()).toHaveLength(3);
    const button = document.querySelector<HTMLButtonElement>('.ws-history-more')!;
    expect(button).not.toBeNull();
    expect(button.disabled).toBe(false);
  });
});

describe('HistoryPanel: Restore', () => {
  it('asks first; cancelling restores nothing', async () => {
    const store = stub();
    await show(store);
    await advance(200);
    await clickIn(rows()[1], 'Restore');
    expect(openDialog()).not.toBeNull();
    expect(store.restore).not.toHaveBeenCalled();
    await act(async () => [...openDialog()!.querySelectorAll('button')].find((button) => button.textContent === 'Cancel')!.click());
    expect(openDialog()).toBeNull();
    expect(store.restore).not.toHaveBeenCalled();
  });

  it('confirming restores that version over the version the list showed as current, says so, and asks the list at once', async () => {
    const store = stub();
    const notify = vi.fn();
    await show(store, { onNotify: notify });
    await advance(200);
    store.versions.mockClear();
    await clickIn(rows()[2], 'Restore');
    await confirmOpen();
    expect(store.restore).toHaveBeenCalledTimes(1);
    expect(store.restore).toHaveBeenCalledWith('Notes/a.md', 'v1', { ifMatch: 'v3' });
    expect(notify).toHaveBeenCalledTimes(1);
    await advance(0); // no settling pause: asked again at once
    expect(store.versions).toHaveBeenCalledTimes(1);
  });

  it('with no current version in the list (the file was deleted) it restores into the gap', async () => {
    const store = stub({ versions: [version('v2', { actor: lear }), version('v1')], next: null });
    await show(store);
    await advance(200);
    await clickIn(rows()[0], 'Restore');
    await confirmOpen();
    expect(store.restore).toHaveBeenCalledWith('Notes/a.md', 'v2', { ifAbsent: true });
  });

  it('a 412 opens its own question, and Look again asks the list again', async () => {
    const store = stub();
    store.restore.mockRejectedValueOnce(new FileChangedError('Notes/a.md'));
    const notify = vi.fn();
    await show(store, { onNotify: notify });
    await advance(200);
    await clickIn(rows()[1], 'Restore');
    await confirmOpen();
    expect(notify).not.toHaveBeenCalled();
    expect(openDialog()).not.toBeNull(); // the changed-meanwhile question
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(0);
    store.versions.mockClear();
    await confirmOpen();
    expect(openDialog()).toBeNull();
    await advance(0);
    expect(store.versions).toHaveBeenCalledTimes(1);
  });

  it('any other failure shows an alert and leaves the list', async () => {
    const store = stub();
    store.restore.mockRejectedValueOnce(new Error('The server said no'));
    const notify = vi.fn();
    await show(store, { onNotify: notify });
    await advance(200);
    await clickIn(rows()[1], 'Restore');
    await confirmOpen();
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    expect(openDialog()).toBeNull();
    expect(rows()).toHaveLength(3);
    expect(notify).not.toHaveBeenCalled();
  });

  it('Preview and Restore are off while a restore runs', async () => {
    let finish!: () => void;
    const store = stub();
    store.restore.mockImplementationOnce(() => new Promise<FileEntry>((resolve) => (finish = () => resolve(entry()))));
    await show(store);
    await advance(200);
    await clickIn(rows()[1], 'Restore');
    await confirmOpen();
    const disabled = [...document.querySelectorAll<HTMLButtonElement>('.ws-history-actions button')].map((button) => button.disabled);
    expect(disabled).toEqual([true, true, true, true]);
    await act(async () => finish());
    expect([...document.querySelectorAll<HTMLButtonElement>('.ws-history-actions button')].some((button) => button.disabled)).toBe(false);
  });
});

describe('HistoryPanel: a server that keeps no versions', () => {
  const change = (cursor: string, type: ChangeRecord['type'], extra: Partial<ChangeRecord> = {}): ChangeRecord => ({ seq: Number(cursor), cursor, at: '2026-11-21T10:00:00.000Z', project: 'night-sky', type, path: 'Notes/a.md', ...extra });

  it('lists who changed the file from its log, writes removes and renames only, with no Preview or Restore, and never asks for versions', async () => {
    const store = stub();
    store.changes.mockResolvedValue([
      change('4', 'rename', { path: undefined, from: 'Notes/a.md', to: 'Notes/b.md', actor: lear }),
      change('3', 'mkdir'),
      change('2', 'write', { actor: you }),
      change('1', 'remove'),
    ]);
    await show(store, { versions: false });
    await advance(200);
    expect(store.versions).not.toHaveBeenCalled();
    expect(store.changes).toHaveBeenCalledWith('Notes/a.md', { limit: 30 });
    expect(rows()).toHaveLength(3); // the mkdir isn't shown
    expect(document.querySelectorAll('button')).toHaveLength(0);
    expect(rows()[0].querySelector('.ws-history-who')?.textContent).toBe('Lear');
    const notes = rows().map((row) => row.querySelector('.ws-history-note')?.textContent ?? '');
    expect(notes[0]).toContain('Notes/b.md'); // a rename names where it went
    expect(new Set(notes).size).toBe(3);
  });

  it('a rename that brought the file here names where it came from', async () => {
    const store = stub();
    store.changes.mockResolvedValue([change('2', 'rename', { path: undefined, from: 'Old/a.md', to: 'Notes/a.md' })]);
    await show(store, { versions: false });
    await advance(200);
    expect(rows()[0].querySelector('.ws-history-note')?.textContent).toContain('Old/a.md');
  });

  it('a failed read of the log offers Try again, which asks again at once', async () => {
    const store = stub();
    store.changes.mockRejectedValueOnce(new Error('down'));
    await show(store, { versions: false });
    await advance(200);
    expect(document.querySelectorAll('[role="alert"]')).toHaveLength(1);
    store.changes.mockClear();
    await act(async () => [...document.querySelectorAll('button')].find((button) => button.textContent === 'Try again')!.click());
    await advance(0);
    expect(store.changes).toHaveBeenCalledTimes(1);
  });
});
