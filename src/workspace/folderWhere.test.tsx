import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeFolders, type FakeFolders } from './dev/fakeFolders';
import { createFakeRegistry, fakeFolder, type FakeRegistry } from './dev/fakeRegistry';
import { MemoryStore } from './dev/memoryStore';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Where a folder project's files live, said where people look (slice 7,
// keeping the 10-25 rules): the rail's status, Settings, the confirms, Help.

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}
const probeView = () => Probe;

const originalStorage = Object.getOwnPropertyDescriptor(navigator, 'storage');

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
  if (originalStorage) Object.defineProperty(navigator, 'storage', originalStorage);
  else delete (navigator as { storage?: unknown }).storage;
});

/** The browser hasn't promised to keep this site's storage: a browser
 * project's status says "May be cleared"; a folder's must not. */
function browserWontPromise() {
  Object.defineProperty(navigator, 'storage', {
    configurable: true,
    value: { persisted: async () => false, persist: async () => false, estimate: async () => ({ usage: 1, quota: 2 }) },
  });
}

type Shown = { registry: FakeRegistry; folders: FakeFolders; id: string; files: MemoryStore };

/** Night Sky in the browser, and Notes in a folder, open. */
async function showFolderProject(options: { supported?: boolean } = {}): Promise<Shown> {
  browserWontPromise();
  const registry = createFakeRegistry({ projects: 1 });
  const files = new MemoryStore({ 'Today.md': '# Today', 'Trips/Iceland.md': 'north' });
  const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: fakeFolder('Notes', files) });
  await registry.open(id);
  const folders = createFakeFolders(registry, { supported: options.supported ?? true });
  rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} folders={folders} downloadProject={async () => {}} />);
  await waitFor(() => expect(rendered!.container.querySelector('.ws-filetree')?.textContent).toContain('Today'));
  await settle(20);
  return { registry, folders, id, files };
}

const footer = () => rendered!.container.querySelector<HTMLElement>('.ws-rail-footer')!;
const panel = () => document.querySelector<HTMLElement>('#ws-settings-panel-project')!;
const click = (element: HTMLElement | null | undefined) => act(async () => element!.click());
const byText = (root: ParentNode, selector: string, text: string) =>
  [...root.querySelectorAll<HTMLElement>(selector)].find((element) => element.textContent?.trim() === text);

describe('the rail’s status, for a folder project', () => {
  it('shows the folder’s name, On this computer, and the calm dot: the browser can’t clear a folder', async () => {
    await showFolderProject();
    expect(footer().querySelector('.page-sidebar-footer-name')?.textContent).toBe('Notes');
    expect(footer().querySelector('.page-sidebar-footer-meta')?.textContent).toBe('On this computer');
    expect(footer().textContent).not.toContain('May be cleared');
    const dot = footer().querySelector('.ws-store-dot')!;
    expect(dot.hasAttribute('data-attention')).toBe(false);
    expect(dot.hasAttribute('data-ephemeral')).toBe(false);
    expect(rendered!.container.querySelector('.ws-switcher .page-sidebar-subtitle')?.textContent).toBe('On this computer');
  });

  it('the status line under the files says saves go to this computer, not the browser', async () => {
    await showFolderProject();
    const status = rendered!.container.querySelector<HTMLElement>('.ws-status')!.textContent ?? '';
    expect(status).toContain('Saved on this computer');
    expect(status).not.toContain('in this browser');
  });

  it('opens Settings at the project’s files', async () => {
    await showFolderProject();
    await click(footer().querySelector<HTMLButtonElement>('button.ws-rail-where'));
    await settle(20);
    expect(document.querySelector('#ws-settings-tab-project')?.getAttribute('aria-selected')).toBe('true');
    expect(panel().textContent).toContain('In the folder ‘Notes’, on this computer');
  });

  it('is said project by project in the project menu', async () => {
    await showFolderProject();
    await click(rendered!.container.querySelector<HTMLButtonElement>('.ws-switcher'));
    const rows = [...document.querySelectorAll<HTMLElement>('.ws-menu [data-project]')].map((row) => [row.querySelector('b')?.textContent, row.querySelector('.ws-menu-item-text > span')?.textContent]);
    expect(rows.sort()).toEqual([
      ['Night Sky', 'In this browser'],
      ['Notes', 'On this computer'],
    ]);
  });
});

describe('Settings → Project → Files, for a folder project', () => {
  async function openFiles(): Promise<Shown> {
    const shown = await showFolderProject();
    await click(rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]'));
    await click(document.querySelector<HTMLButtonElement>('#ws-settings-tab-project'));
    await settle(20);
    return shown;
  }

  it('says which folder, what that means, and how it’s backed up; Download as .zip is still there', async () => {
    await openFiles();
    const text = panel().textContent ?? '';
    expect(text).toContain('In the folder ‘Notes’, on this computer');
    expect(text).toContain('These are ordinary files: other apps can open and change them, and Nebula shows their changes.');
    expect(text).toContain('Backing up the folder backs up the project, and a folder inside Dropbox, Google Drive, iCloud Drive, OneDrive or Proton Drive is backed up by that service’s own app.');
    expect(byText(panel(), 'button', 'Download as .zip')).toBeDefined();
    expect(text).not.toContain('This browser may clear');
    expect(panel().querySelector('.ws-set-warn')).toBeNull();
  });

  it('doesn’t ask for a .zip as a browser project does: the files are already on this computer', async () => {
    await openFiles();
    expect(panel().textContent).not.toContain('Not downloaded yet');
    expect(panel().querySelector('.ws-set-downloaded')).toBeNull();
  });

  it('says removing it leaves the folder and its files where they are', async () => {
    await openFiles();
    expect(panel().textContent).toContain('Removes Notes from Nebula. The folder ‘Notes’ and its files stay on this computer.');
  });
});

describe('the confirms, for a folder project', () => {
  it('Remove says Nebula forgets it and never deletes the folder or its files, and keeps that promise', async () => {
    const { registry, files, id } = await showFolderProject();
    await click(rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]'));
    await click(document.querySelector<HTMLButtonElement>('#ws-settings-tab-project'));
    // Not red: nothing is deleted.
    const remove = byText(panel(), 'button', 'Remove from Nebula…');
    expect(remove?.classList.contains('ws-btn-danger')).toBe(false);
    await click(remove);
    await waitFor(() => expect(document.querySelector('dialog[open] .ws-dialog-foot')).not.toBeNull());
    const confirm = document.querySelector('dialog[open] .ws-dialog-foot')!.closest('dialog')!;
    expect(confirm.textContent).toContain('Remove “Notes” from Nebula?');
    expect(confirm.textContent).toContain('Nebula forgets this project. It never deletes the folder ‘Notes’ or the files in it: they stay on this computer.');
    await click(byText(confirm, 'button', 'Remove from Nebula'));
    await waitFor(async () => expect((await registry.list()).map((project) => project.id)).not.toContain(id));
    expect(await files.readText('Today.md')).toBe('# Today');
  });

  it('deleting says it goes from the folder on this computer', async () => {
    await showFolderProject();
    const row = rendered!.container.querySelector<HTMLElement>('.ws-filetree [data-path="Trips"]');
    expect(row).toBeDefined();
    await act(async () => {
      row!.focus();
      row!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await waitFor(() => expect(document.querySelector('dialog[open]')?.textContent).toContain('The folder and the 1 file in it will be deleted from the folder ‘Notes’ on this computer. It won’t go to your computer’s bin, so this can’t be undone.'));
  });

  it('says a deleted file doesn’t go to the bin either', async () => {
    await showFolderProject();
    // The tree's keys act on the row that has focus: Trips first, one down is Today.md.
    const first = rendered!.container.querySelector<HTMLElement>('.ws-filetree [role="treeitem"][data-path="Trips"]')!;
    await act(async () => {
      first.focus();
      first.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    });
    await act(async () => {
      document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    await waitFor(() => expect(document.querySelector('dialog[open]')?.textContent).toContain('It will be deleted from the folder ‘Notes’ on this computer. It won’t go to your computer’s bin, so this can’t be undone.'));
  });
});

describe('Help', () => {
  async function helpText(supported: boolean): Promise<string> {
    await showFolderProject({ supported });
    await click(rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Help"]'));
    return document.querySelector<HTMLDialogElement>('dialog.ws-help')?.textContent ?? '';
  }

  it('says a project can live in a folder, where this browser can do it', async () => {
    expect(await helpText(true)).toContain(
      'This browser can also keep a project in a folder on your computer: New project → In a folder on this computer, or Open a folder… in the project menu.',
    );
  });

  it('says which browsers can keep a project in a folder, where this one can’t', async () => {
    const text = await helpText(false);
    expect(text).not.toContain('Open a folder…');
    expect(text).toContain('To keep a project in a folder on your computer, use Chrome, Edge or Opera on a desktop.');
  });
});
