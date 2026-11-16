import { act } from 'react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { requestPersistentStorage } from '../files/persist';
import { createFakeRegistry } from './dev/fakeRegistry';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

// Where a person's files live, said where they look: Help, the welcome, the
// rail's status and Settings (Bruce, 2026-10-24 23:58 UTC: "majorly important").

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
  // jsdom's <dialog> has no showModal or close: enough of them for a dialog to open and close.
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

const ready = () => waitFor(() => expect(rendered!.container.querySelector('[data-testid="probe"]')?.textContent).toBe('Guides/Observing plan.md'));

async function openHelp(): Promise<HTMLDialogElement> {
  await act(async () => rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Help"]')!.click());
  const help = document.querySelector<HTMLDialogElement>('dialog.ws-help');
  expect(help, 'the workspace’s own Help').not.toBeNull();
  expect(help!.open).toBe(true);
  return help!;
}

describe('Help', () => {
  it('says where the files live, what can clear them, and how to keep them', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const text = (await openHelp()).textContent ?? '';
    expect(text).toContain('Where your files live');
    expect(text).toContain('In this browser, on this device. Nothing is uploaded, and there’s no account.');
    expect(text).toContain('Another browser, another device or a private window doesn’t see them.');
    expect(text).toContain('Browsers can clear what websites keep');
    expect(text).toContain('Settings → Project → Download as .zip');
    expect(text).toContain('File → Add to Dock');
    expect(text).toContain('Share → Add to Home Screen');
  });

  it('describes this Nebula, not 1.x’s boards', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const text = (await openHelp()).textContent ?? '';
    expect(text).not.toMatch(/board dropdown|Repository|per board/);
    for (const step of ['Projects', 'Files', 'Tabs', 'Canvases', 'Images', 'Agent sessions', 'Links']) expect(text).toContain(step);
    // Converting images is found by right-clicking, so Help says it.
    expect(text).toContain('Right-click an image, or a folder of them, to turn it into WebP, JPEG or PNG, or make it smaller.');
    expect(text).toContain('Search, or jump to a file');
    expect(text).toContain('Edit or read a note');
  });

  it('opens at its top: focus on Close, not on Got it at the bottom', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const help = await openHelp();
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Close');
    expect(help.contains(document.activeElement)).toBe(true);
  });

  it('says who makes Nebula and links the licences of the open-source libraries it carries', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const help = await openHelp();
    expect(help.textContent).toContain('Nebula is open source under the GNU AGPL-3.0, © 2026 Starscape LLC. It’s built with open-source libraries, listed here with their licences.');
    const link = [...help.querySelectorAll('a')].find((a) => a.textContent === 'listed here with their licences');
    // Written into the site by Vite's build.license (vite.config.ts), checked by scripts/build-site.mjs.
    expect(link?.getAttribute('href')).toBe('/third-party-licenses.txt');
    expect(link?.getAttribute('target')).toBe('_blank');
  });

  it('links Starscape’s privacy page, which says what Nebula keeps and where (2026-10-25)', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const help = await openHelp();
    expect(help.textContent).toContain('Our privacy page says what Nebula keeps, and where.');
    const link = [...help.querySelectorAll('a')].find((a) => a.textContent === 'privacy page');
    expect(link?.getAttribute('href')).toBe('https://starscape.biz/privacy/#apps');
    expect(link?.getAttribute('target')).toBe('_blank');
    expect(link?.getAttribute('rel')).toBe('noopener');
  });

  it('says files last only as long as the tab where the browser can’t keep them', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent={false} viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    const text = (await openHelp()).textContent ?? '';
    expect(text).toContain('This browser can’t keep files for Nebula, so they last until you close this tab.');
    expect(text).not.toContain('Nothing is uploaded');
  });
});

describe('the welcome', () => {
  function notices(): Record<string, string> {
    const items = [...document.querySelectorAll<HTMLElement>('dialog.ws-welcome .welcome-dialog-notices > li')];
    return Object.fromEntries(items.map((item) => [item.querySelector('.welcome-dialog-notice-label')?.textContent ?? '', item.textContent ?? '']));
  }

  it('names this version of Nebula, not Excalidraw: canvases are one part of it now', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry({ projects: 1 })} persistent viewFor={probeView} intro="welcome" downloadProject={async () => {}} />);
    await waitFor(() => expect(document.querySelector('dialog.ws-welcome')).not.toBeNull());
    expect(document.querySelector('dialog.ws-welcome .welcome-dialog-edition-pill')?.textContent).toMatch(/^Version \d+\.\d+$/);
    expect(document.querySelector('dialog.ws-welcome')?.textContent).not.toContain('Powered by Excalidraw');
  });

  it('says the files are here and nowhere else, that browsers can clear them, and to keep a .zip', async () => {
    rendered = await render(<Workspace registry={createFakeRegistry({ projects: 1 })} persistent viewFor={probeView} intro="welcome" downloadProject={async () => {}} />);
    await waitFor(() => expect(document.querySelector('dialog.ws-welcome')).not.toBeNull());
    expect(notices()['Your files']).toContain(
      'Projects you start here are saved in this browser, on this device, and nowhere else. Browsers can clear what websites keep, so download a project as a .zip to keep a copy.',
    );
  });
});

describe('the rail’s status', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else delete (navigator as { storage?: unknown }).storage;
  });

  /** What the browser says about keeping this site's files; `asked` is what persist() then answers. */
  function browserSays(persisted: boolean | 'unknown', asked = persisted === true) {
    let kept = persisted === true;
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value:
        persisted === 'unknown'
          ? {}
          : {
              persisted: async () => kept,
              persist: async () => (kept = asked),
              estimate: async () => ({ usage: 1, quota: 2 }),
            },
    });
  }

  const footer = () => rendered!.container.querySelector<HTMLElement>('.ws-rail-footer')!;
  const marked = () => footer().querySelector('.ws-store-dot')!.hasAttribute('data-attention');

  async function open() {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={async () => {}} />);
    await ready();
    await settle(20);
  }

  it('says the files may be cleared, and marks it, while the browser hasn’t agreed to keep them', async () => {
    browserSays(false);
    await open();
    await waitFor(() => expect(footer().textContent).toContain('May be cleared'));
    expect(footer().textContent).toContain('In this browser');
    expect(marked()).toBe(true);
  });

  it('says so too when the browser can’t say', async () => {
    browserSays('unknown');
    await open();
    await waitFor(() => expect(footer().textContent).toContain('May be cleared'));
    expect(marked()).toBe(true);
  });

  it('shows how much is kept, unmarked, once the browser has agreed', async () => {
    browserSays(true);
    await open();
    expect(footer().textContent).toMatch(/\d+ files · /);
    expect(footer().textContent).not.toContain('May be cleared');
    expect(marked()).toBe(false);
  });

  it('calms down as soon as the browser agrees, after an edit asks it', async () => {
    browserSays(false, true);
    await open();
    await waitFor(() => expect(footer().textContent).toContain('May be cleared'));
    await act(async () => {
      await requestPersistentStorage();
    });
    await waitFor(() => expect(footer().textContent).not.toContain('May be cleared'));
    expect(marked()).toBe(false);
  });

  it('opens Settings at the project’s files', async () => {
    browserSays(false);
    await open();
    const where = footer().querySelector<HTMLButtonElement>('button.ws-rail-where');
    expect(where, 'the status is a button').not.toBeNull();
    await act(async () => where!.click());
    await settle(20);
    expect(document.querySelector('#ws-settings-tab-project')?.getAttribute('aria-selected')).toBe('true');
    expect(document.querySelector('#ws-settings-panel-project')?.textContent).toContain('Download as .zip');
  });
});

describe('Settings, Project: the files, and how to keep them', () => {
  const original = Object.getOwnPropertyDescriptor(navigator, 'storage');
  afterEach(() => {
    if (original) Object.defineProperty(navigator, 'storage', original);
    else delete (navigator as { storage?: unknown }).storage;
  });

  function browserSays(persisted: boolean) {
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: { persisted: async () => persisted, persist: async () => persisted, estimate: async () => ({ usage: 1, quota: 2 }) },
    });
  }

  const panel = () => document.querySelector<HTMLElement>('#ws-settings-panel-project')!;

  async function openSettings(downloadProject: (id: string) => Promise<void> = async () => {}) {
    rendered = await render(<Workspace registry={createFakeRegistry()} persistent viewFor={probeView} downloadProject={downloadProject} />);
    await ready();
    await act(async () => rendered!.container.querySelector<HTMLButtonElement>('.ws-rail [aria-label="Settings"]')!.click());
    await act(async () => document.querySelector<HTMLButtonElement>('#ws-settings-tab-project')!.click());
    await settle(20);
  }

  it('says what can clear them and what keeps them, set apart, while the browser hasn’t agreed', async () => {
    browserSays(false);
    await openSettings();
    const advice = panel().querySelector<HTMLElement>('.ws-set-warn');
    expect(advice, 'the advice stands out').not.toBeNull();
    expect(advice!.textContent).toContain('This browser may clear Nebula’s files when space runs low, and a private window forgets them when it closes.');
    expect(advice!.textContent).toContain('Safari can also clear them after a week of use without a visit.');
    expect(advice!.textContent).toContain('install Nebula as an app');
  });

  it('says the .zip is still the copy once the browser has agreed, without setting it apart', async () => {
    browserSays(true);
    await openSettings();
    expect(panel().textContent).toContain('This browser has agreed to keep Nebula’s files, even when space runs low. A .zip is still your copy if this device is lost or reset.');
    expect(panel().querySelector('.ws-set-warn')).toBeNull();
  });

  it('says when the project was last downloaded, from this browser', async () => {
    browserSays(false);
    const downloaded: string[] = [];
    await openSettings(async (id) => {
      downloaded.push(id);
    });
    expect(panel().textContent).toContain('Not downloaded yet.');
    const download = [...panel().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Download as .zip'))!;
    await act(async () => download.click());
    await settle(20);
    expect(downloaded).toEqual(['night-sky']);
    await waitFor(() => expect(panel().textContent).toContain('Last downloaded today.'));
    expect(panel().textContent).not.toContain('Not downloaded yet.');
  });

  it('remembers it after a reload', async () => {
    browserSays(false);
    await openSettings();
    const download = [...panel().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Download as .zip'))!;
    await act(async () => download.click());
    await waitFor(() => expect(panel().textContent).toContain('Last downloaded today.'));
    await rendered!.unmount();
    rendered = null;
    await openSettings();
    expect(panel().textContent).toContain('Last downloaded today.');
  });

  it('doesn’t count a download that failed', async () => {
    browserSays(false);
    await openSettings(async () => {
      throw new Error('no room');
    });
    const download = [...panel().querySelectorAll<HTMLButtonElement>('button')].find((button) => button.textContent?.includes('Download as .zip'))!;
    await act(async () => download.click());
    await settle(20);
    expect(panel().textContent).toContain('Not downloaded yet.');
  });
});
