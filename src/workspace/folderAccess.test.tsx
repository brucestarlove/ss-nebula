import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps, FolderAccess } from '../files/types';
import { createFakeFolders, type FakeFolders } from './dev/fakeFolders';
import { createFakeRegistry, fakeFolder, type FakeRegistry } from './dev/fakeRegistry';
import { MemoryStore } from './dev/memoryStore';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// A project in a folder on this computer: the browser can forget
// the permission between visits, the person can say no, and the folder can
// go. Real folders' prompts can't be driven from a test: these use fake
// folders whose answers the test sets (src/workspace/dev/fakeFolders.ts).

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

type Setup = { registry: FakeRegistry; folders: FakeFolders; id: string; files: MemoryStore };

/** Night Sky in the browser, and Notes in a folder, opened last. */
async function setup(access: FolderAccess): Promise<Setup> {
  const registry = createFakeRegistry({ projects: 1 });
  const files = new MemoryStore({ 'Today.md': '# Today', 'Trips/Iceland.md': 'north' });
  const { id } = await registry.create({ name: 'Notes', color: '#7c8cff', folder: fakeFolder('Notes', files) });
  await registry.open(id);
  registry.setAccess(id, access);
  return { registry, folders: createFakeFolders(registry), id, files };
}

async function show({ registry, folders }: Setup): Promise<void> {
  rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} folders={folders} />);
  await settle(30);
}

const bar = () => document.querySelector<HTMLElement>('.ws-folder-bar');
const tree = () => rendered!.container.querySelector<HTMLElement>('.ws-filetree')?.textContent ?? '';
const button = (label: string) => [...(bar()?.querySelectorAll<HTMLButtonElement>('button') ?? [])].find((item) => item.textContent?.trim() === label);

describe('a folder Nebula may open', () => {
  it('opens with no bar', async () => {
    const setUp = await setup('granted');
    await show(setUp);
    await waitFor(() => expect(tree()).toContain('Today'));
    expect(bar()).toBeNull();
  });
});

describe('a folder whose permission the browser forgot', () => {
  it('asks calmly, over the project, and opens nothing until the person says yes', async () => {
    const setUp = await setup('prompt');
    await show(setUp);
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(bar()!.textContent).toContain('Nebula needs your OK to open the folder ‘Notes’ again.');
    expect(bar()!.querySelectorAll('button')).toHaveLength(1);
    expect(tree()).not.toContain('Today');
    expect(setUp.folders.requested).toEqual([]);
  });

  it('says so in the rail too: no empty project to fill, and an amber status', async () => {
    const setUp = await setup('prompt');
    await show(setUp);
    await waitFor(() => expect(bar()).not.toBeNull());
    const rail = rendered!.container.querySelector<HTMLElement>('.ws-rail')!;
    expect(rail.querySelector('.ws-files-section')?.textContent).toContain('Its files show here once Nebula can open the folder.');
    expect(rail.querySelector('.ws-files-section')?.textContent).not.toContain('No files yet');
    expect(rail.querySelector('.ws-section-actions [aria-label="New note"]')).toBeNull();
    const footer = rail.querySelector<HTMLElement>('.ws-rail-footer')!;
    expect(footer.querySelector('.page-sidebar-footer-meta')?.textContent).toBe('Needs your OK');
    expect(footer.querySelector('.ws-store-dot')?.hasAttribute('data-attention')).toBe(true);
    expect(rendered!.container.querySelector('.ws-status')?.textContent).not.toContain('Saved');
  });

  it('offers no New on the phone bar either, until the folder opens', async () => {
    const setUp = await setup('prompt');
    await show(setUp);
    await waitFor(() => expect(bar()).not.toBeNull());
    const phoneNew = () => rendered!.container.querySelector('.ws-phone-bar [aria-label="New"]');
    expect(phoneNew()).toBeNull();
    await act(async () => button('Open the folder')!.click());
    await waitFor(() => expect(tree()).toContain('Today'));
    expect(phoneNew()).not.toBeNull();
  });

  it('opens the folder once the person gives the OK, from the bar’s one button', async () => {
    const setUp = await setup('prompt');
    await show(setUp);
    await waitFor(() => expect(button('Open the folder')).toBeDefined());
    await act(async () => button('Open the folder')!.click());
    await waitFor(() => expect(tree()).toContain('Today'));
    expect(setUp.folders.requested).toEqual([setUp.id]);
    expect(bar()).toBeNull();
  });

  it('says so, and offers to choose the folder again, when the person says no', async () => {
    const setUp = await setup('prompt');
    setUp.folders.answer = 'denied';
    await show(setUp);
    await waitFor(() => expect(button('Open the folder')).toBeDefined());
    await act(async () => button('Open the folder')!.click());
    await waitFor(() => expect(bar()!.textContent).toContain('Nebula isn’t allowed to open the folder ‘Notes’.'));
    expect(button('Choose the folder again')).toBeDefined();
    expect(tree()).not.toContain('Today');
  });
});

describe('a folder Nebula isn’t allowed to open', () => {
  it('says so, with Choose the folder again', async () => {
    const setUp = await setup('denied');
    await show(setUp);
    await waitFor(() => expect(bar()?.textContent).toContain('Nebula isn’t allowed to open the folder ‘Notes’.'));
    expect(button('Choose the folder again')).toBeDefined();
    expect(rendered!.container.querySelector('.ws-rail-footer .page-sidebar-footer-meta')?.textContent).toBe('Not allowed');
  });

  it('opens once the person chooses the same folder again', async () => {
    const setUp = await setup('denied');
    const same = fakeFolder('Notes', setUp.files);
    same.projectId = setUp.id;
    setUp.folders.picks.push(same);
    await show(setUp);
    await waitFor(() => expect(button('Choose the folder again')).toBeDefined());
    await act(async () => button('Choose the folder again')!.click());
    await waitFor(() => expect(tree()).toContain('Today'));
    expect(bar()).toBeNull();
    expect((await setUp.registry.list()).map((project) => project.name).sort()).toEqual(['Night Sky', 'Notes']);
  });

  it('changes nothing when the picker is cancelled', async () => {
    const setUp = await setup('denied');
    setUp.folders.picks.push(null);
    await show(setUp);
    await waitFor(() => expect(button('Choose the folder again')).toBeDefined());
    await act(async () => button('Choose the folder again')!.click());
    await settle(20);
    expect(setUp.folders.picked).toBe(1);
    expect(bar()?.textContent).toContain('Nebula isn’t allowed to open the folder ‘Notes’.');
    expect(await setUp.registry.list()).toHaveLength(2);
  });
});

describe('a folder that’s gone', () => {
  it('says so plainly, offers to choose it again, and shows no empty project in its place', async () => {
    const setUp = await setup('missing');
    await show(setUp);
    await waitFor(() => expect(bar()).not.toBeNull());
    expect(bar()!.textContent).toContain('Nebula can’t find the folder ‘Notes’. It may have been moved, renamed or deleted, or be on a drive that isn’t connected.');
    expect(button('Choose the folder again')).toBeDefined();
    expect(tree()).not.toContain('Today');
    expect(rendered!.container.querySelector('.ws-rail-footer .page-sidebar-footer-meta')?.textContent).toBe('Can’t be found');
    // Not an empty project to start filling: no New note on the stage.
    expect(rendered!.container.querySelector('.ws-empty')?.textContent ?? '').not.toContain('New note');
  });

  it('keeps its tabs open while the folder is out of reach, says so, and lets the bar go once it’s back (S2)', async () => {
    const setUp = await setup('granted');
    await setUp.files.write('.nebula/workspace.json', JSON.stringify({ tabs: ['Today.md'], active: 'Today.md', expanded: [], starred: [] }));
    await show(setUp);
    await waitFor(() => expect(document.querySelector('[data-testid="probe"]')?.textContent).toBe('Today.md'));
    const probe = document.querySelector('[data-testid="probe"]');
    const emit = (change: unknown) => (setUp.files as unknown as { emit(change: unknown): void }).emit(change);
    setUp.registry.setAccess(setUp.id, 'missing');
    emit({ type: 'unreachable', folder: 'Notes' });
    await waitFor(() => expect(bar()?.textContent).toContain('Nebula can’t find the folder ‘Notes’.'));
    await settle(30);
    expect(tree()).toContain('Today');
    expect(document.querySelector('[data-testid="probe"]')).toBe(probe);

    setUp.registry.setAccess(setUp.id, 'granted');
    emit({ type: 'reachable' });
    await waitFor(() => expect(bar()).toBeNull());
    await settle(30);
    expect(document.querySelector('[data-testid="probe"]')).toBe(probe);
  });

  it('turns Convert image… off while the folder is out of reach, and on again once it’s back (2.1.0)', async () => {
    const setUp = await setup('granted');
    await setUp.files.write('Sky.png', new Blob(['png'], { type: 'image/png' }));
    await show(setUp);
    await waitFor(() => expect(rendered!.container.querySelector('[data-path="Sky.png"]')).not.toBeNull());
    const convertOff = async () => {
      const row = rendered!.container.querySelector<HTMLElement>('[data-path="Sky.png"]')!;
      await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
      const item = [...document.querySelectorAll<HTMLButtonElement>('[role="menu"][aria-label="File"] [role^="menuitem"]')].find((each) => each.textContent?.trim() === 'Convert image…');
      return item?.disabled;
    };
    expect(await convertOff()).toBe(false);
    const emit = (change: unknown) => (setUp.files as unknown as { emit(change: unknown): void }).emit(change);
    setUp.registry.setAccess(setUp.id, 'missing');
    emit({ type: 'unreachable', folder: 'Notes' });
    await waitFor(() => expect(bar()?.textContent).toContain('Nebula can’t find the folder ‘Notes’.'));
    expect(await convertOff()).toBe(true);
    setUp.registry.setAccess(setUp.id, 'granted');
    emit({ type: 'reachable' });
    await waitFor(() => expect(bar()).toBeNull());
    expect(await convertOff()).toBe(false);
  });

  it('says when the open folder has grown past what Nebula shows, and keeps it open (S8)', async () => {
    const setUp = await setup('granted');
    await show(setUp);
    await waitFor(() => expect(tree()).toContain('Today'));
    (setUp.files as unknown as { emit(change: unknown): void }).emit({ type: 'too-big', folder: 'Notes' });
    await waitFor(() => expect(bar()?.textContent).toContain('‘Notes’ holds more than 10,000 files, more than Nebula can show. Choose a folder of notes and drawings inside it.'));
    expect(tree()).toContain('Today');
  });

  it('says so too when the folder goes while it’s open', async () => {
    const setUp = await setup('granted');
    await show(setUp);
    await waitFor(() => expect(tree()).toContain('Today'));
    setUp.registry.setAccess(setUp.id, 'missing');
    // The folder store says its folder went: a remove of ''.
    (setUp.files as unknown as { emit(change: unknown): void }).emit({ type: 'remove', path: '' });
    await waitFor(() => expect(bar()?.textContent).toContain('Nebula can’t find the folder ‘Notes’.'));
    expect(tree()).not.toContain('Today');
  });
});
