import { act, useContext, useEffect } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { blobToText } from '../files/bytes';
import type { FileStore, FileViewProps } from '../files/types';
import { createFakeRegistry } from './dev/fakeRegistry';
import type { TextSession } from './views/shared/textSession';
import { hasUnsavedChanges, reportKeptCopy } from './views/shared/fileSessions';
import { useTextSession } from './views/shared/useTextSession';
import { ViewActionsContext } from './views/shared/viewActions';
import { PageWidthContext } from './views/shared/pageWidth';
import { byLabel, render, settle, waitFor, type Rendered } from './views/testing/render';
import { slowWrites } from './views/testing/slowWrites';
import { Workspace } from './Workspace';

// The props the app wires (src/App.tsx): which file a link opens, the
// address following the open file, and a notice from startup.

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}
const probeView = () => Probe;

beforeAll(() => {
  // jsdom has no matchMedia: a desktop, by day, with motion.
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
});

let rendered: Rendered | null = null;
afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.clear();
});

function probe(container: HTMLElement): string | null {
  return container.querySelector('[data-testid="probe"]')?.textContent ?? null;
}

function activeTab(container: HTMLElement): string | null {
  return container.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.trim() ?? null;
}

describe('Workspace links', () => {
  it('opens the file a link names, in front of what was open', async () => {
    const registry = createFakeRegistry();
    rendered = await render(
      <Workspace registry={registry} persistent viewFor={probeView} initialFile={{ projectId: 'night-sky', path: 'Sketches/Winter hexagon.excalidraw.md' }} />,
    );
    await waitFor(() => expect(probe(rendered!.container)).toBe('Sketches/Winter hexagon.excalidraw.md'));
    expect(activeTab(rendered.container)).toContain('Winter hexagon');
  });

  it('opens the project a link names, even when another was open last', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} initialFile={{ projectId: 'pulse', path: null }} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-switcher')?.textContent).toContain('Pulse'));
  });

  it('reports the open file, so the address can follow it', async () => {
    const registry = createFakeRegistry();
    const onActiveFileChange = vi.fn();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} onActiveFileChange={onActiveFileChange} />);
    await waitFor(() => expect(onActiveFileChange).toHaveBeenLastCalledWith('night-sky', 'Guides/Observing plan.md'));
    const canvasTab = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Winter hexagon'));
    canvasTab?.click();
    await waitFor(() => expect(onActiveFileChange).toHaveBeenLastCalledWith('night-sky', 'Sketches/Winter hexagon.excalidraw.md'));
  });

  it('doesn’t report the restored file before a linked one opens', async () => {
    const registry = createFakeRegistry();
    const onActiveFileChange = vi.fn();
    rendered = await render(
      <Workspace
        registry={registry}
        persistent
        viewFor={probeView}
        initialFile={{ projectId: 'night-sky', path: 'Sketches/Winter hexagon.excalidraw.md' }}
        onActiveFileChange={onActiveFileChange}
      />,
    );
    await waitFor(() => expect(onActiveFileChange).toHaveBeenLastCalledWith('night-sky', 'Sketches/Winter hexagon.excalidraw.md'));
    await settle(20);
    expect(onActiveFileChange.mock.calls.map(([, path]) => path)).not.toContain('Guides/Observing plan.md');
  });

  it('says so when a linked file isn’t in the project', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} initialFile={{ projectId: 'night-sky', path: 'Guides/Comets.md' }} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-status')?.textContent).toContain('“Comets.md” isn’t in Night Sky'));
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
  });

  it('says so when a linked project isn’t in this browser', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} initialFile={{ projectId: 'elsewhere', path: 'notes.md' }} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-status')?.textContent).toContain('That link’s project isn’t in this browser'));
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
  });

  it('shows a notice from startup', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} notice="Nebula couldn’t move your canvases." />);
    await waitFor(() => expect(rendered!.container.querySelector('[role="alert"].ws-notice')?.textContent).toContain('Nebula couldn’t move your canvases.'));
  });
});

describe('a file deleted elsewhere', () => {
  function tabs(container: HTMLElement): string[] {
    return [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent?.trim() ?? '');
  }

  it('keeps the open file on screen, so its view can say so', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await registry.stores.get('night-sky')!.remove('Guides/Observing plan.md');
    await settle(150);
    expect(probe(rendered.container)).toBe('Guides/Observing plan.md');
    expect(tabs(rendered.container).some((tab) => tab.includes('Observing plan'))).toBe(true);
    expect(rendered.container.querySelector('.ws-filetree [data-path="Guides/Observing plan.md"]')).toBeNull();
  });

  it('closes the tabs of other deleted files at once', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} />);
    await waitFor(() => expect(tabs(rendered!.container).some((tab) => tab.includes('Orion Nebula'))).toBe(true));
    await registry.stores.get('night-sky')!.remove('Photos/Orion Nebula.jpg');
    await waitFor(() => expect(tabs(rendered!.container).some((tab) => tab.includes('Orion Nebula'))).toBe(false));
  });

  it('lets the deleted file go once another tab is chosen', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await registry.stores.get('night-sky')!.remove('Guides/Observing plan.md');
    await settle(150);
    const other = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Winter hexagon'));
    other?.click();
    await waitFor(() => expect(probe(rendered!.container)).toBe('Sketches/Winter hexagon.excalidraw.md'));
    await waitFor(() => expect(tabs(rendered!.container).some((tab) => tab.includes('Observing plan'))).toBe(false));
  });
});

describe('renaming or moving what is open', () => {
  const live: { session: TextSession | null } = { session: null };

  /** A view with a real text session, like the note and text views. */
  function SessionView({ store, entry, projectId }: FileViewProps) {
    const { session, state } = useTextSession(store, entry.path, projectId);
    useEffect(() => {
      live.session = session;
    }, [session]);
    return <p data-testid="probe">{state.status === 'ready' ? entry.path : ''}</p>;
  }

  /** Records the order of the store's writes and renames (not .nebula's). */
  function recordOrder(store: FileStore): string[] {
    const order: string[] = [];
    const write = store.write.bind(store);
    const rename = store.rename.bind(store);
    store.write = async (path, data) => {
      if (!path.startsWith('.nebula')) order.push(`write ${path}`);
      return write(path, data);
    };
    store.rename = async (from, to) => {
      order.push(`rename ${from} to ${to}`);
      return rename(from, to);
    };
    return order;
  }

  async function renameInTree(container: HTMLElement, path: string, name: string) {
    const row = container.querySelector<HTMLElement>(`.ws-filetree [role="treeitem"][data-path="${path}"]`)!;
    await act(async () => row.focus());
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }));
    });
    const input = container.querySelector<HTMLInputElement>('.ws-rename-input')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
  }

  it('writes the open file’s unsaved edit before its folder is renamed, and only there', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    const order = recordOrder(store);
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    await act(async () => live.session!.edit('Edited just before the move.'));

    await renameInTree(rendered.container, 'Guides', 'Archive');
    await waitFor(() => expect(order).toContain('rename Guides to Archive'));
    await waitFor(() => expect(probe(rendered!.container)).toBe('Archive/Observing plan.md'));
    expect(order[0]).toBe('write Guides/Observing plan.md');
    expect(await store.readText('Archive/Observing plan.md')).toBe('Edited just before the move.');
    expect(await store.stat('Guides/Observing plan.md')).toBeNull();
  });
});

describe('deleting what is open', () => {
  const live: { session: TextSession | null } = { session: null };

  function SessionView({ store, entry, projectId }: FileViewProps) {
    const { session, state } = useTextSession(store, entry.path, projectId);
    useEffect(() => {
      live.session = session;
    }, [session]);
    return <p data-testid="probe">{state.status === 'ready' ? entry.path : ''}</p>;
  }

  it('waits for the open file’s save in flight, so the deleted folder doesn’t come back', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    const slow = slowWrites(store);
    await act(async () => {
      live.session!.edit('Saved as the folder goes.');
      void live.session!.flush();
    });
    await settle(10);
    expect(slow.waiting).toBe(1);

    const row = rendered.container.querySelector<HTMLElement>('.ws-filetree [role="treeitem"][data-path="Guides"]')!;
    await act(async () => row.focus());
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    // A browser project's files don't talk of the computer's bin.
    expect(document.querySelector('dialog[open]')?.textContent).toContain('from this browser. This can’t be undone.');
    expect(document.querySelector('dialog[open]')?.textContent).not.toContain('bin');
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent === 'Delete');
    await act(async () => confirm!.click());
    await settle(30);
    slow.release();
    for (let tries = 0; tries < 100 && (await store.stat('Guides')) !== null; tries += 1) await settle(10);
    await settle(100);
    expect(await store.stat('Guides/Observing plan.md')).toBeNull();
    expect(await store.stat('Guides')).toBeNull();
  });
});

describe('an open file that changes', () => {
  it('stays on screen while it saves: its view isn’t mounted again', async () => {
    // Reads take a while, as OPFS's do.
    const registry = createFakeRegistry({ latency: 15 });
    const store = registry.stores.get('night-sky')!;
    let mounts = 0;
    function Counting({ entry, kind }: FileViewProps) {
      useEffect(() => {
        mounts += 1;
      }, []);
      return <p data-testid="probe">{`${kind} ${entry.path}`}</p>;
    }
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => Counting} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('note Guides/Observing plan.md'), 1000);
    await settle(300);
    const before = mounts;
    for (let save = 1; save <= 3; save += 1) {
      await act(async () => store.write('Guides/Observing plan.md', `# Observing plan\n\nSaved ${save} times.`));
      await settle(200);
    }
    expect(probe(rendered.container)).toBe('note Guides/Observing plan.md');
    expect(mounts).toBe(before);
  });
});

describe('New project', () => {
  async function openNewProject(persistent: boolean, registry = createFakeRegistry({ empty: true })): Promise<string> {
    rendered = await render(<Workspace registry={registry} persistent={persistent} viewFor={probeView} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-empty .ws-cta')).not.toBeNull());
    await act(async () => rendered!.container.querySelector<HTMLButtonElement>('.ws-empty .ws-cta')!.click());
    await waitFor(() => expect(document.querySelector('dialog.ws-np .ws-np-note')).not.toBeNull());
    return document.querySelector('dialog.ws-np .ws-np-note')!.textContent ?? '';
  }

  it('says plainly when this browser keeps nothing', async () => {
    expect(await openNewProject(false)).toBe('This browser can’t keep files here, so its files last until you close this tab.');
  });

  it('says where the files are saved otherwise', async () => {
    expect(await openNewProject(true)).toBe('Its files are saved in this browser, on this device. To keep a project in a folder on your computer, use Chrome, Edge or Opera on a desktop.');
  });

  // A person's first project is "My First Project".
  function suggested(): { placeholder: string | null; preview: string | null } {
    const dialog = document.querySelector<HTMLElement>('dialog.ws-np')!;
    return { placeholder: dialog.querySelector('input')!.getAttribute('placeholder'), preview: dialog.querySelector('.ws-np-name')!.textContent };
  }

  it('suggests My First Project when there are no projects yet, and makes it when no name is typed', async () => {
    const registry = createFakeRegistry({ empty: true });
    await openNewProject(true, registry);
    expect(suggested()).toEqual({ placeholder: 'My First Project', preview: 'My First Project' });
    await act(async () => byLabel(document.querySelector('dialog.ws-np')!, 'Create project')!.click());
    await waitFor(async () => expect((await registry.list()).map((project) => project.name)).toEqual(['My First Project']));
  });

  it('suggests My First Project from the welcome’s Start empty, beside the sample', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry({ projects: 1 })} persistent viewFor={probeView} intro="welcome" />);
    await waitFor(() => expect(byLabel(document, 'Start empty')).not.toBeNull());
    await act(async () => byLabel(document, 'Start empty')!.click());
    await waitFor(() => expect(document.querySelector('dialog.ws-np')).not.toBeNull());
    expect(suggested()).toEqual({ placeholder: 'My First Project', preview: 'My First Project' });
  });

  it('suggests Untitled project once there are projects', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await act(async () => rendered!.container.querySelector<HTMLElement>('.ws-switcher')!.click());
    await act(async () => byLabel(document, 'New project')!.click());
    await waitFor(() => expect(document.querySelector('dialog.ws-np')).not.toBeNull());
    expect(suggested()).toEqual({ placeholder: 'Untitled project', preview: 'Untitled project' });
  });
});

describe('leaving the page', () => {
  const live: { session: TextSession | null } = { session: null };
  beforeEach(() => {
    live.session = null;
  });

  function SessionView({ store, entry, projectId, onDirty }: FileViewProps) {
    const { session, state } = useTextSession(store, entry.path, projectId);
    useEffect(() => {
      live.session = session;
    }, [session]);
    useEffect(() => {
      onDirty?.(state.dirty);
    }, [onDirty, state.dirty]);
    return <p data-testid="probe">{state.status === 'ready' ? entry.path : ''}</p>;
  }

  /** Whether the page asks before it closes. */
  function asksBeforeLeaving(): boolean {
    const event = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  }

  it('asks before closing while an edit isn’t saved, and not once it is', async () => {
    const registry = createFakeRegistry();
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    expect(asksBeforeLeaving()).toBe(false);
    await act(async () => live.session!.edit('Not saved yet.'));
    expect(asksBeforeLeaving()).toBe(true);
    await act(async () => live.session!.flush());
    expect(asksBeforeLeaving()).toBe(false);
  });

  it('keeps asking while a closed tab’s last save is still being written, and stops once it lands', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    const slow = slowWrites(store);
    await act(async () => live.session!.edit('Saved on the way out.'));
    const other = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Winter hexagon'));
    await act(async () => other!.click());
    await waitFor(() => expect(probe(rendered!.container)).toBe('Sketches/Winter hexagon.excalidraw.md'));
    expect(asksBeforeLeaving()).toBe(true);
    slow.release();
    await settle(50);
    expect(asksBeforeLeaving()).toBe(false);
  });
});

describe('uploading', () => {
  it('adds every file it can, and says which it couldn’t and why', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    const input = rendered.container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const files = [new File(['1'], 'one.txt'), new File(['2'], '..'), new File(['3'], 'back\\slash.txt'), new File(['4'], 'three.txt')];
    Object.defineProperty(input, 'files', { configurable: true, value: files });
    await act(async () => {
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await waitFor(() => expect(rendered!.container.querySelector('.ws-status')?.textContent).toContain('Couldn’t add'));
    const status = rendered.container.querySelector('.ws-status')?.textContent ?? '';
    expect(status).toContain('Added 3 files.');
    expect(status).toContain('Couldn’t add “..”: That name is reserved.');
    const paths = (await store.list()).map((entry) => entry.path);
    expect(paths).toEqual(expect.arrayContaining(['one.txt', 'back_slash.txt', 'three.txt']));
  });
});

describe('the page width switch on a note', () => {
  afterEach(() => {
    localStorage.removeItem('nebula:width');
    delete document.documentElement.dataset.width;
  });

  it('changes the same preference as Settings → Page width, kept on this device', async () => {
    function WidthProbe() {
      const page = useContext(PageWidthContext);
      return (
        <button type="button" data-probe-width="" onClick={() => page?.setWidth(page.width === 'stretch' ? 'fixed' : 'stretch')}>
          {page?.width ?? 'none'}
        </button>
      );
    }
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={() => WidthProbe} />);
    const button = () => rendered!.container.querySelector<HTMLButtonElement>('[data-probe-width]');
    await waitFor(() => expect(button()?.textContent).toBe('fixed'));
    await act(async () => button()!.click());
    expect(button()!.textContent).toBe('stretch');
    expect(localStorage.getItem('nebula:width')).toBe('stretch');
    expect(document.documentElement.dataset.width).toBe('stretch');
  });
});

describe('Settings opens on Appearance, then on the tab used last', () => {
  it('opens on Appearance, and comes back on Project after Project was used', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    const gear = () => rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]')!;
    const shownTab = () => document.querySelector('.ws-settings [role="tab"][aria-selected="true"]')?.textContent ?? null;
    await act(async () => gear().click());
    expect(shownTab()).toBe('Appearance');
    await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
    expect(shownTab()).toBe('Project');
    await act(async () => document.querySelector<HTMLButtonElement>('.ws-settings .drawer-close')!.click());
    await settle(20);
    expect(document.querySelector('.ws-settings')).toBeNull();
    await act(async () => gear().click());
    expect(shownTab()).toBe('Project');
  });
});

describe('Settings, Project: whether the browser keeps the files', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');

  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else delete (navigator as { storage?: unknown }).storage;
  });

  function browserSays(persisted: boolean | 'unknown') {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: persisted === 'unknown' ? {} : { persisted: async () => persisted, estimate: async () => ({ usage: 1, quota: 2 }) },
    });
  }

  async function projectSettings(): Promise<string> {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    await act(async () => rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
    await settle(20);
    return document.querySelector('#ws-settings-panel-project')?.textContent ?? '';
  }

  it('says so when the browser has agreed to keep them', async () => {
    browserSays(true);
    expect(await projectSettings()).toContain('This browser has agreed to keep Nebula’s files, even when space runs low.');
  });

  it('says what can happen to them when it hasn’t, private windows included', async () => {
    browserSays(false);
    const text = await projectSettings();
    expect(text).toContain('This browser may clear Nebula’s files when space runs low, and a private window forgets them when it closes.');
    expect(text).not.toContain('has agreed');
  });

  it('says so when the browser doesn’t say', async () => {
    browserSays('unknown');
    expect(await projectSettings()).toContain('This browser doesn’t say whether it keeps Nebula’s files, and a private window forgets them when it closes.');
  });
});

describe('following changes to the files', () => {
  function Sized({ entry }: FileViewProps) {
    return <p data-testid="probe">{`${entry.path} ${entry.size}`}</p>;
  }

  function countLists(store: FileStore): { readonly count: number } {
    const counter = { count: 0 };
    const list = store.list.bind(store);
    store.list = async () => {
      counter.count += 1;
      return list();
    };
    return counter;
  }

  it('updates a file that changed from one look at it, without listing the whole project again', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    const lists = countLists(store);
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => Sized} />);
    await waitFor(() => expect(probe(rendered!.container)).toMatch(/^Guides\/Observing plan\.md \d+$/));
    await settle(150);
    const before = lists.count;
    for (let save = 1; save <= 5; save += 1) {
      await act(async () => store.write('Guides/Observing plan.md', 'x'.repeat(save * 100)));
      await settle(100);
    }
    expect(probe(rendered.container)).toBe('Guides/Observing plan.md 500');
    expect(lists.count).toBe(before);
  });

  it('still shows files that arrive, and lets go of ones that leave', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => Sized} />);
    await waitFor(() => expect(probe(rendered!.container)).toMatch(/^Guides\/Observing plan\.md/));
    await act(async () => store.write('Comets/Halley.md', '# Halley'));
    await waitFor(() => expect(rendered!.container.querySelector('.ws-filetree [data-path="Comets"]')).not.toBeNull());
    await act(async () => store.remove('Comets'));
    await waitFor(() => expect(rendered!.container.querySelector('.ws-filetree [data-path="Comets"]')).toBeNull());
  });
});

describe('a canvas that won’t open', () => {
  it('opens as a note when asked, and nothing is written', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    const text = '# Not a drawing\n\nJust words, kept safe.';
    await store.write('Sketches/Broken.excalidraw.md', text);
    rendered = await render(<Workspace registry={registry} persistent initialFile={{ projectId: 'night-sky', path: 'Sketches/Broken.excalidraw.md' }} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-info-card')).not.toBeNull(), 300);
    await act(async () => byLabel(rendered!.container, 'Open as note')?.click());
    await waitFor(() => expect(rendered!.container.querySelector('.ws-prose')?.textContent).toContain('Just words, kept safe.'), 300);
    expect(await store.readText('Sketches/Broken.excalidraw.md')).toBe(text);
  });

  it('forgets that choice when the file is deleted: a new file there opens as what it is', async () => {
    function KindProbe({ entry, kind }: FileViewProps) {
      const actions = useContext(ViewActionsContext);
      return (
        <button type="button" data-testid="probe" onClick={() => actions.openAs?.('note')}>
          {`${entry.path} ${kind}`}
        </button>
      );
    }
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    const path = 'Sketches/Winter hexagon.excalidraw.md';
    const drawing = await store.readText(path);
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => KindProbe} initialFile={{ projectId: 'night-sky', path }} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe(`${path} canvas`), 1000);
    await act(async () => rendered!.container.querySelector<HTMLButtonElement>('[data-testid="probe"]')!.click());
    expect(probe(rendered.container)).toBe(`${path} note`);

    const row = rendered.container.querySelector<HTMLElement>(`.ws-filetree [role="treeitem"][data-path="${path}"]`)!;
    await act(async () => row.focus());
    await act(async () => {
      row.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    });
    const confirm = [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find((button) => button.textContent === 'Delete');
    await act(async () => confirm!.click());
    await waitFor(() => expect(rendered!.container.querySelector(`.ws-filetree [data-path="${path}"]`)).toBeNull(), 1000);

    await act(async () => store.write(path, drawing));
    const label = `.ws-filetree [role="treeitem"][data-path="${path}"] .page-sidebar-nav-label`;
    await waitFor(() => expect(rendered!.container.querySelector(label)).not.toBeNull(), 1000);
    await act(async () => rendered!.container.querySelector<HTMLElement>(label)!.click());
    await waitFor(() => expect(probe(rendered!.container)).toBe(`${path} canvas`), 1000);
  }, 10_000);
});

describe('a change held in a conflict when its tab is left (re-review R1)', () => {
  const live: { session: TextSession | null } = { session: null };
  beforeEach(() => {
    live.session = null;
  });

  function SessionView({ store, entry, projectId }: FileViewProps) {
    const { session, state } = useTextSession(store, entry.path, projectId);
    useEffect(() => {
      live.session = session;
    }, [session]);
    return <p data-testid="probe">{state.status === 'ready' ? entry.path : ''}</p>;
  }

  it('says where the change was kept, and opens the copy', async () => {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    await act(async () => live.session!.edit('Mine.'));
    await act(async () => store.write('Guides/Observing plan.md', 'Theirs.'));
    await waitFor(() => expect(live.session?.getState().conflict).toBe(true));
    const other = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Winter hexagon'));
    await act(async () => other!.click());

    const said = /^Your changes to Observing plan were kept as ‘Observing plan \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)’\.$/;
    await waitFor(() => expect(rendered!.container.querySelector('.ws-kept p')?.textContent).toMatch(said));
    expect(rendered.container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toMatch(said);
    const copy = (await store.list()).find((entry) => entry.path.startsWith('Guides/Observing plan (conflict'))!.path;
    expect(await store.readText(copy)).toBe('Mine.');
    expect(await store.readText('Guides/Observing plan.md')).toBe('Theirs.');

    await act(async () => byLabel(rendered!.container, 'Open the copy')!.click());
    await waitFor(() => expect(probe(rendered!.container)).toBe(copy));
    // Opened, the line has done its job.
    expect(rendered.container.querySelector('.ws-kept')).toBeNull();
  });

  /** The note open in its tab, in a conflict, and the tab left, with the
   * store refusing the copy as a full one would. */
  async function copyRefused() {
    const registry = createFakeRegistry();
    const store = registry.stores.get('night-sky')!;
    const write = store.write.bind(store);
    store.write = (path, data, options) =>
      path.includes('(conflict ') ? Promise.reject(Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })) : write(path, data, options);
    rendered = await render(<Workspace registry={registry} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    await act(async () => live.session!.edit('Mine.'));
    await act(async () => write('Guides/Observing plan.md', 'Theirs.'));
    await waitFor(() => expect(live.session?.getState().conflict).toBe(true));
    const other = [...rendered.container.querySelectorAll<HTMLElement>('[role="tab"]')].find((tab) => tab.textContent?.includes('Winter hexagon'));
    await act(async () => other!.click());
    const said = 'Couldn’t keep your changes to Observing plan as a copy: this browser’s storage is full. Download them so they aren’t lost.';
    await waitFor(() => expect(rendered!.container.querySelector('.ws-kept p')?.textContent).toBe(said));
    expect(hasUnsavedChanges()).toBe(true);
    return { store };
  }

  it('offers a copy it couldn’t write as a download, and lets the page close once it’s saved', async () => {
    const { store } = await copyRefused();
    const blobs: Blob[] = [];
    const names: string[] = [];
    const createObjectURL = vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      blobs.push(blob as Blob);
      return 'blob:kept';
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    try {
      await act(async () => byLabel(rendered!.container, 'Download your changes to Observing plan')!.click());
    } finally {
      createObjectURL.mockRestore();
      click.mockRestore();
    }
    expect(names).toHaveLength(1);
    expect(names[0]).toMatch(/^Observing plan \(conflict \d{4}-\d\d-\d\d \d\d\.\d\d\)\.md$/);
    expect(await blobToText(blobs[0])).toBe('Mine.');
    expect(hasUnsavedChanges()).toBe(false);
    expect(rendered!.container.querySelector('.ws-kept')).toBeNull();
    expect(await store.readText('Guides/Observing plan.md')).toBe('Theirs.');
  });

  it('says when the copy was kept because another tab deleted the file', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={() => SessionView} />);
    await waitFor(() => expect(live.session?.getState().status).toBe('ready'));
    const copy = 'Guides/Observing plan (conflict 2026-10-22 11.40).md';
    await act(async () => reportKeptCopy({ scope: 'night-sky', path: 'Guides/Observing plan.md', copy, deleted: true }));
    await waitFor(() =>
      expect(rendered!.container.querySelector('.ws-kept p')?.textContent).toBe('Observing plan was deleted in another tab. Your changes were kept as ‘Observing plan (conflict 2026-10-22 11.40)’.'),
    );
    expect(byLabel(rendered.container, 'Open the copy')).not.toBeNull();
  });

  it('lets the page close once a copy it couldn’t write is dismissed: the user has chosen', async () => {
    await copyRefused();
    await act(async () => byLabel(rendered!.container.querySelector('.ws-kept')!, 'Dismiss')!.click());
    expect(hasUnsavedChanges()).toBe(false);
    expect(rendered!.container.querySelector('.ws-kept')).toBeNull();
  });
});

describe('projects saved by a newer Nebula (re-review R5)', () => {
  const LINE = 'These projects were saved by a newer version of Nebula, so this one can open them but not change the project list.';

  async function readOnlyWorkspace() {
    const registry = createFakeRegistry({ readOnly: true });
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    return { registry, container: rendered.container };
  }

  function button(root: ParentNode, label: string): HTMLButtonElement {
    // A menu item's text ends with its shortcut (Rename…F2).
    const found = [...root.querySelectorAll<HTMLButtonElement>('button')].find((candidate) => {
      const name = (candidate.getAttribute('aria-label') ?? candidate.textContent ?? '').trim();
      return name === label || name === `${label}${candidate.querySelector('kbd')?.textContent ?? '-'}`;
    });
    if (!found) throw new Error(`No button ${label}`);
    return found;
  }

  it('says why, once, in one line', async () => {
    const { container } = await readOnlyWorkspace();
    expect([...container.querySelectorAll('.ws-readonly p')].map((line) => line.textContent)).toEqual([LINE]);
  });

  it('says nothing when the projects can be changed', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} />);
    await waitFor(() => expect(probe(rendered!.container)).toBe('Guides/Observing plan.md'));
    expect(rendered.container.querySelector('.ws-readonly')).toBeNull();
  });

  it('turns off New project in the project menu', async () => {
    const { container } = await readOnlyWorkspace();
    await act(async () => container.querySelector<HTMLElement>('.ws-switcher')!.click());
    expect(button(document, 'New project').disabled).toBe(true);
  });

  it('turns off a project’s rename, colour and remove in its menu', async () => {
    const { container } = await readOnlyWorkspace();
    await act(async () => container.querySelector<HTMLElement>('.ws-switcher')!.click());
    const row = document.querySelector<HTMLElement>('[data-project="night-sky"]')!;
    await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
    const menu = document.querySelector<HTMLElement>('.ws-context')!;
    expect(button(menu, 'Rename…').disabled).toBe(true);
    expect(button(menu, 'Remove project…').disabled).toBe(true);
    expect([...menu.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button.ws-swatch, input[type="color"]')].every((swatch) => swatch.disabled)).toBe(true);
    expect(button(menu, 'Project settings…').disabled).toBe(false);
  });

  it('turns off rename, colour and remove in Settings, and keeps Import', async () => {
    const { container } = await readOnlyWorkspace();
    await act(async () => button(container, 'Settings').click());
    await waitFor(() => expect(document.querySelector('#ws-settings-tab-project')).not.toBeNull());
    await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
    await waitFor(() => expect(document.querySelector('#ws-settings-panel-project')).not.toBeNull());
    const panel = document.querySelector<HTMLElement>('#ws-settings-panel-project')!;
    expect(panel.querySelector<HTMLInputElement>('input.ws-input')!.disabled).toBe(true);
    expect([...panel.querySelectorAll<HTMLButtonElement | HTMLInputElement>('button.ws-swatch, input[type="color"]')].every((swatch) => swatch.disabled)).toBe(true);
    expect(button(panel, 'Remove project…').disabled).toBe(true);
    expect(button(panel, 'Import files…').disabled).toBe(false);
  });

  it('still edits files inside a project', async () => {
    const { registry, container } = await readOnlyWorkspace();
    await act(async () => button(container.querySelector('.ws-tabs') ?? container, 'New note').click());
    await settle(50);
    expect((await registry.stores.get('night-sky')!.list()).map((entry) => entry.path)).toContain('Untitled.md');
  });
});

describe('the note after canvases moved, when some stayed behind (re-review R3)', () => {
  const LIBRARY = 'The Excalidraw library of board ss-nebula didn’t fit in this browser’s storage, so “ss-nebula” starts without it. It’s still saved under the old board.';

  function notices(): Record<string, string> {
    const items = [...document.querySelectorAll<HTMLElement>('dialog.ws-welcome .welcome-dialog-notices > li')];
    return Object.fromEntries(items.map((item) => [item.querySelector('.welcome-dialog-notice-label')?.textContent ?? '', item.textContent ?? '']));
  }

  it('names each canvas that stayed, offers it as a download, and says the warnings, in place of “Nothing lost”', async () => {
    const download = vi.fn();
    rendered = await render(
      <Workspace
        registry={createFakeRegistry()}
        persistent
        viewFor={probeView}
        intro="migrated"
        leftBehind={{ canvases: [{ key: 'nebula:excalidraw:ss-nebula:plan', name: 'Plan' }, { key: 'nebula:excalidraw:ss-nebula:map', name: 'Map' }], warnings: [LIBRARY] }}
        onDownloadLeftBehind={download}
      />,
    );
    await waitFor(() => expect(document.querySelector('dialog.ws-welcome')).not.toBeNull());
    const said = notices();
    expect(Object.keys(said)).not.toContain('Nothing lost');
    expect(said['Not moved']).toContain('2 canvases couldn’t be moved, so they stay in this browser where Nebula 1.x kept them.');
    expect(said['Also']).toContain(LIBRARY);
    const dialog = document.querySelector<HTMLElement>('dialog.ws-welcome')!;
    await act(async () => byLabel(dialog, 'Download “Map” as .excalidraw')!.click());
    expect(download).toHaveBeenCalledWith('nebula:excalidraw:ss-nebula:map');
  });

  it('says only the warnings when every canvas moved', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} intro="migrated" leftBehind={{ canvases: [], warnings: [LIBRARY] }} />);
    await waitFor(() => expect(document.querySelector('dialog.ws-welcome')).not.toBeNull());
    const said = notices();
    expect(Object.keys(said)).toEqual(['Your canvases', 'Also', 'Drawings']);
  });

  it('still says nothing was lost when all went well', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} intro="migrated" />);
    await waitFor(() => expect(document.querySelector('dialog.ws-welcome')).not.toBeNull());
    expect(Object.keys(notices())).toEqual(['Your canvases', 'Nothing lost', 'Drawings']);
  });
});

describe('canvases an older Nebula tab saved after the move (re-review R6)', () => {
  const HEAD = 'Canvases saved by an older Nebula tab after the move';

  function offer(canvases: Array<{ key: string; name: string; updatedAt: string; projectId: string | null }>, registry?: ReturnType<typeof createFakeRegistry>) {
    return {
      find: vi.fn(async () => canvases),
      importCopy: vi.fn(async (key: string, projectId: string) => {
        void key;
        await registry?.stores.get(projectId)?.write('Main (older tab).excalidraw.md', '');
        return 'Main (older tab).excalidraw.md';
      }),
      download: vi.fn(),
    };
  }

  it('offers each one, once, quietly', async () => {
    const older = offer([{ key: 'k-main', name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId: 'pulse' }]);
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-older')).not.toBeNull());
    const line = rendered.container.querySelector<HTMLElement>('.ws-older')!;
    expect(line.getAttribute('role')).toBe('note');
    expect(line.textContent).toContain(HEAD);
    expect(line.textContent).toContain('Main');
    expect(byLabel(line, 'Import “Main” as a copy')).not.toBeNull();
    expect(older.find).toHaveBeenCalledTimes(1);
  });

  it('offers nothing when there are none', async () => {
    const older = offer([]);
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(older.find).toHaveBeenCalled());
    await settle(20);
    expect(rendered.container.querySelector('.ws-older')).toBeNull();
  });

  it('imports into the project its earlier version went to, says where, and lets it go', async () => {
    const older = offer([{ key: 'k-main', name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId: 'pulse' }]);
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-older')).not.toBeNull());
    await act(async () => byLabel(rendered!.container, 'Import “Main” as a copy')!.click());
    expect(older.importCopy).toHaveBeenCalledWith('k-main', 'pulse');
    await waitFor(() => expect(rendered!.container.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe('Imported “Main” into Pulse as ‘Main (older tab)’.'));
    expect(rendered.container.querySelector('.ws-older')).toBeNull();
  });

  it('imports into the open project when its earlier version went nowhere, and opens it', async () => {
    const registry = createFakeRegistry();
    const older = offer([{ key: 'k-new', name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId: null }], registry);
    rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-older')).not.toBeNull());
    await act(async () => byLabel(rendered!.container, 'Import “Main” as a copy')!.click());
    expect(older.importCopy).toHaveBeenCalledWith('k-new', 'night-sky');
    await waitFor(() => expect(probe(rendered!.container)).toBe('Main (older tab).excalidraw.md'));
  });

  it('downloads one, and Dismiss puts the offer away', async () => {
    const older = offer([{ key: 'k-main', name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId: 'pulse' }]);
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-older')).not.toBeNull());
    await act(async () => byLabel(rendered!.container, 'Download “Main” as .excalidraw')!.click());
    expect(older.download).toHaveBeenCalledWith('k-main');
    await act(async () => byLabel(rendered!.container.querySelector('.ws-older')!, 'Dismiss')!.click());
    expect(rendered.container.querySelector('.ws-older')).toBeNull();
  });
  it('Dismiss tells the offer which canvases were put away, so they aren’t offered again', async () => {
    const canvases = [
      { key: 'k-main', name: 'Main', updatedAt: '2026-06-01T00:00:00.000Z', projectId: 'pulse' },
      { key: 'k-plan', name: 'Plan', updatedAt: '2026-06-02T00:00:00.000Z', projectId: null },
    ];
    const older = { ...offer(canvases), dismiss: vi.fn() };
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} olderTabCanvases={older} />);
    await waitFor(() => expect(rendered!.container.querySelector('.ws-older')).not.toBeNull());
    await act(async () => byLabel(rendered!.container.querySelector('.ws-older')!, 'Dismiss')!.click());
    expect(older.dismiss).toHaveBeenCalledWith(canvases);
  });

});
