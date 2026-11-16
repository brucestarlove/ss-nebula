import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeFolders, type FakeFolders } from './dev/fakeFolders';
import { createFakeRegistry, fakeFolder, type FakeRegistry } from './dev/fakeRegistry';
import { MemoryStore } from './dev/memoryStore';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Move to a folder…, in Settings: a browser project's files go to
// an empty folder on this computer, and the project with them. The copy, the
// check and the refusals are the registry's (src/files/folderRegistry.test.ts).

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}
const probeView = () => Probe;

beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
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
});

async function show(options: { supported?: boolean } = {}): Promise<{ registry: FakeRegistry; folders: FakeFolders }> {
  const registry = createFakeRegistry({ projects: 1 });
  const folders = createFakeFolders(registry, { supported: options.supported ?? true });
  rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} folders={folders} downloadProject={async () => {}} />);
  await waitFor(() => expect(rendered!.container.querySelector('.ws-filetree')?.textContent).toContain('Observing plan'));
  await act(async () => rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]')!.click());
  await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
  await settle(20);
  return { registry, folders };
}

const panel = () => document.querySelector<HTMLElement>('#ws-settings-panel-project')!;
const move = () => [...panel().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.trim() === 'Move to a folder…');
const said = () => rendered!.container.querySelector('[role="status"]')?.textContent ?? '';

describe('Move to a folder…', () => {
  it('is offered for a project in this browser, saying what it does', async () => {
    await show();
    expect(move()).toBeDefined();
    expect(panel().textContent).toContain('Move to a folder… copies its files into an empty folder on this computer, checks each one, and only then deletes the copy in this browser.');
  });

  it('moves the project, which then lives in the folder', async () => {
    const { registry, folders } = await show();
    const target = fakeFolder('Night Sky', new MemoryStore());
    folders.picks.push(target);
    await act(async () => move()!.click());
    await waitFor(() => expect(panel().textContent).toContain('In the folder ‘Night Sky’, on this computer'));
    expect((await registry.list())[0]).toMatchObject({ id: 'night-sky', tier: 'folder' });
    expect(said()).toContain('Moved Night Sky to the folder ‘Night Sky’. Its copy in this browser is deleted.');
    expect((await target.files!.list()).map((entry) => entry.path)).toContain('Guides/Observing plan.md');
    expect(move()).toBeUndefined();
  });

  it('says why when the folder isn’t empty, and the project stays in this browser', async () => {
    const { registry, folders } = await show();
    folders.picks.push(fakeFolder('Busy', new MemoryStore({ 'theirs.md': 'x' })));
    await act(async () => move()!.click());
    await waitFor(() => expect(said()).toContain('The folder ‘Busy’ isn’t empty.'));
    expect((await registry.list())[0].tier).toBe('browser');
    expect(panel().textContent).toContain('In this browser');
  });

  it('changes nothing when the picker is cancelled', async () => {
    const { registry, folders } = await show();
    folders.picks.push(null);
    await act(async () => move()!.click());
    await settle(20);
    expect(folders.picked).toBe(1);
    expect((await registry.list())[0].tier).toBe('browser');
  });

  it('isn’t offered where the browser can’t open folders', async () => {
    await show({ supported: false });
    expect(move()).toBeUndefined();
    expect(panel().textContent).not.toContain('folder');
  });

  it('offers no New or Upload while the move runs (S3)', async () => {
    const { registry, folders } = await show();
    const create = registry.create.bind(registry);
    let finish!: () => void;
    const gate = new Promise<void>((resolve) => (finish = resolve));
    registry.create = async (input) => {
      await gate;
      return create(input);
    };
    await act(async () => document.querySelector<HTMLButtonElement>('dialog [aria-label="Close"]')?.click());
    folders.picks.push(fakeFolder('Night Sky', new MemoryStore()));
    await act(async () => move()!.click());
    await settle(20);
    const newNote = () => rendered!.container.querySelector('.ws-rail .ws-section-actions [aria-label="New note"]');
    expect(newNote()).toBeNull();
    finish();
    await waitFor(() => expect(said()).toContain('Moved Night Sky'));
  });

  it('offers no New while another tab moves the project, and again once that move failed (S3)', async () => {
    const { registry } = await show();
    await act(async () => document.querySelector<HTMLButtonElement>('dialog [aria-label="Close"]')?.click());
    const newNote = () => rendered!.container.querySelector('.ws-rail .ws-section-actions [aria-label="New note"]');
    await waitFor(() => expect(newNote()).not.toBeNull());
    const files = registry.stores.get('night-sky') as unknown as { emit(change: unknown): void };
    await act(async () => files.emit({ type: 'moving' }));
    await waitFor(() => expect(newNote()).toBeNull());
    await act(async () => files.emit({ type: 'move-failed' }));
    await waitFor(() => expect(newNote()).not.toBeNull());
  });

  it('turns Convert image… off while the project moves, and on again once that move failed (2.1.0: conversion meets the folder tier)', async () => {
    const { registry } = await show();
    await act(async () => document.querySelector<HTMLButtonElement>('dialog [aria-label="Close"]')?.click());
    const convertOff = async () => {
      const row = rendered!.container.querySelector<HTMLElement>('[data-path="Photos/Orion Nebula.jpg"]')!;
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="File"] [role^="menuitem"]')].find((each) => each.textContent?.trim() === 'Convert image…');
      return item?.disabled;
    };
    await waitFor(() => expect(rendered!.container.querySelector('[data-path="Photos/Orion Nebula.jpg"]')).not.toBeNull());
    expect(await convertOff()).toBe(false);
    const files = registry.stores.get('night-sky') as unknown as { emit(change: unknown): void };
    await act(async () => files.emit({ type: 'moving' }));
    await settle(20);
    expect(await convertOff()).toBe(true);
    await act(async () => files.emit({ type: 'move-failed' }));
    await settle(20);
    expect(await convertOff()).toBe(false);
  });
});

