import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeFolders, type FakeFolders } from './dev/fakeFolders';
import { createFakeRegistry, fakeFolder, type FakeRegistry } from './dev/fakeRegistry';
import { MemoryStore } from './dev/memoryStore';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Starting a project in a folder on this computer: New project
// says where it lives, and the project menu opens a folder. Only where the
// browser can (Chromium on a desktop); elsewhere nothing about folders shows.

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

async function show(options: { supported?: boolean; persistent?: boolean } = {}): Promise<{ registry: FakeRegistry; folders: FakeFolders }> {
  const registry = createFakeRegistry({ projects: 1 });
  const folders = createFakeFolders(registry, { supported: options.supported ?? true });
  rendered = await render(<Workspace registry={registry} persistent={options.persistent ?? true} viewFor={probeView} folders={folders} />);
  await settle(30);
  return { registry, folders };
}

const click = (element: HTMLElement | null | undefined) => act(async () => element!.click());
const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim() === text);
const switcher = () => rendered!.container.querySelector<HTMLButtonElement>('.ws-switcher')!;
const menu = () => document.querySelector<HTMLElement>('.ws-menu[aria-label="Projects"]');
const dialog = () => document.querySelector<HTMLDialogElement>('dialog.ws-np');
const tree = () => rendered!.container.querySelector<HTMLElement>('.ws-filetree')?.textContent ?? '';
const title = () => rendered!.container.querySelector('.ws-switcher .page-sidebar-title')?.textContent;

async function openNewProject(): Promise<HTMLDialogElement> {
  await click(switcher());
  await click(byText(menu()!, 'button', 'New project'));
  await waitFor(() => expect(dialog()).not.toBeNull());
  return dialog()!;
}

describe('New project, where the browser can open folders', () => {
  it('asks where the files live: in this browser (chosen), or in a folder on this computer', async () => {
    await show();
    const np = await openNewProject();
    const where = np.querySelector<HTMLElement>('[role="radiogroup"][aria-label="Where its files live"]');
    expect(where, 'the choice').not.toBeNull();
    const options = [...where!.querySelectorAll<HTMLElement>('[role="radio"]')].map((radio) => [radio.textContent?.trim(), radio.getAttribute('aria-checked')]);
    expect(options).toEqual([
      ['In this browser', 'true'],
      ['In a folder on this computer', 'false'],
    ]);
  });

  it('makes the project in the folder picked, opening the files already there as they are', async () => {
    const { registry, folders } = await show();
    folders.picks.push(fakeFolder('Field notes', new MemoryStore({ 'Iceland.md': 'north', 'Maps/route.png': 'png' })));
    const np = await openNewProject();
    await click(byText(np, '[role="radio"]', 'In a folder on this computer'));
    expect(np.textContent).toContain('You’ll choose the folder next.');
    const input = np.querySelector<HTMLInputElement>('input.ws-input')!;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      set.call(input, 'Field notes');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(byText(np, 'button', 'Choose folder…'));
    await waitFor(() => expect(tree()).toContain('Iceland'));
    expect(folders.picked).toBe(1);
    expect(title()).toBe('Field notes');
    const made = (await registry.list()).find((project) => project.name === 'Field notes');
    expect(made).toMatchObject({ tier: 'folder', folder: { name: 'Field notes', access: 'granted' } });
    expect(dialog()).toBeNull();
  });

  it('changes nothing when the picker is cancelled: no project, and the dialog stays as it was', async () => {
    const { registry, folders } = await show();
    folders.picks.push(null);
    const np = await openNewProject();
    await click(byText(np, '[role="radio"]', 'In a folder on this computer'));
    await click(byText(np, 'button', 'Choose folder…'));
    await settle(20);
    expect(folders.picked).toBe(1);
    expect(await registry.list()).toHaveLength(1);
    expect(dialog()).not.toBeNull();
  });

  it('still makes a project in this browser, as before', async () => {
    const { registry, folders } = await show();
    const np = await openNewProject();
    await click(byText(np, 'button', 'Create project'));
    await settle(20);
    expect(folders.picked).toBe(0);
    expect((await registry.list()).map((project) => project.tier).sort()).toEqual(['browser', 'browser']);
  });
});

describe('Open a folder…, in the project menu', () => {
  it('opens a folder as a project named after it', async () => {
    const { registry, folders } = await show();
    folders.picks.push(fakeFolder('Recipes', new MemoryStore({ 'Bread.md': 'flour' })));
    await click(switcher());
    await click(byText(menu()!, 'button', 'Open a folder…'));
    await waitFor(() => expect(tree()).toContain('Bread'));
    expect(title()).toBe('Recipes');
    expect((await registry.list()).find((project) => project.name === 'Recipes')?.tier).toBe('folder');
  });

  it('opens a folder that already is a project here as that project, not a second one', async () => {
    const { registry, folders } = await show();
    const recipes = fakeFolder('Recipes', new MemoryStore({ 'Bread.md': 'flour' }));
    folders.picks.push(recipes, recipes);
    await click(switcher());
    await click(byText(menu()!, 'button', 'Open a folder…'));
    await waitFor(() => expect(title()).toBe('Recipes'));
    await click(switcher());
    await click([...menu()!.querySelectorAll<HTMLElement>('[data-project]')].find((item) => item.querySelector('b')?.textContent === 'Night Sky'));
    await waitFor(() => expect(title()).toBe('Night Sky'));
    await click(switcher());
    await click(byText(menu()!, 'button', 'Open a folder…'));
    await waitFor(() => expect(title()).toBe('Recipes'));
    expect((await registry.list()).map((project) => project.name).sort()).toEqual(['Night Sky', 'Recipes']);
  });

  it('changes nothing when the picker is cancelled', async () => {
    const { registry, folders } = await show();
    folders.picks.push(null);
    await click(switcher());
    await click(byText(menu()!, 'button', 'Open a folder…'));
    await settle(20);
    expect(folders.picked).toBe(1);
    expect(await registry.list()).toHaveLength(1);
    expect(title()).toBe('Night Sky');
  });
});

describe('where the browser can’t open folders (Firefox, Safari, phones)', () => {
  it('offers no folder, and says in New project which browsers can (Bruce, 2026-11-14: he looked for it and found nothing)', async () => {
    await show({ supported: false });
    await click(switcher());
    expect(byText(menu()!, 'button', 'Open a folder…')).toBeUndefined();
    await click(byText(menu()!, 'button', 'New project'));
    await waitFor(() => expect(dialog()).not.toBeNull());
    expect(dialog()!.querySelector('[aria-label="Where its files live"]')).toBeNull();
    expect(dialog()!.textContent).toContain('To keep a project in a folder on your computer, use Chrome, Edge or Opera on a desktop.');
  });

  it('nor where the browser keeps nothing (a private window)', async () => {
    await show({ persistent: false });
    await click(switcher());
    expect(byText(menu()!, 'button', 'Open a folder…')).toBeUndefined();
  });
});
