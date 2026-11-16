import { act } from 'react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FileViewProps } from '../files/types';
import { createFakeRegistry, type FakeRegistry } from './dev/fakeRegistry';
import type { ImageTools } from './imageConvert';
import { render, settle, waitFor, type Rendered } from './views/testing/render';
import { Workspace } from './Workspace';

function Probe({ entry }: FileViewProps) {
  return <p data-testid="probe">{entry.path}</p>;
}
const probeView = () => Probe;

/** jsdom can't decode or encode images: every image is 4000 × 3000, and every result 100 KB. */
function tools(options: { webp?: boolean; slow?: Promise<void> } = {}): ImageTools {
  return {
    decode: async () => ({ width: 4000, height: 3000, close() {} }),
    encode: async (_bitmap, _width, _height, type) => {
      await options.slow;
      return new Blob([new Uint8Array(100_000)], { type });
    },
    canEncode: async (type) => options.webp !== false || type !== 'image/webp',
  };
}

beforeAll(() => {
  // jsdom has no matchMedia: a desktop, by day, with motion (as in Workspace.test.tsx).
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
  // Nor object URLs, for the dialog's preview.
  if (!URL.createObjectURL) Object.assign(URL, { createObjectURL: () => 'blob:preview', revokeObjectURL: () => {} });
});

let rendered: Rendered | null = null;
let registry: FakeRegistry;

beforeEach(() => {
  localStorage.removeItem('nebula:convert-images');
  registry = createFakeRegistry();
});

afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  localStorage.removeItem('nebula:convert-images');
});

async function open(options: { webp?: boolean; slow?: Promise<void> } = {}) {
  rendered = await render(<Workspace registry={registry} persistent viewFor={probeView} imageTools={tools(options)} />);
  await waitFor(() => expect(rendered!.container.querySelector('[data-path="Photos/Orion Nebula.jpg"]')).not.toBeNull());
  return rendered.container;
}

async function menuFor(path: string): Promise<HTMLElement> {
  const row = rendered!.container.querySelector<HTMLElement>(`[data-path="${path}"]`)!;
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 })));
  return document.querySelector<HTMLElement>('[role="menu"][aria-label="File"]')!;
}

function items(menu: HTMLElement): string[] {
  return [...menu.querySelectorAll('[role^="menuitem"]')].map((item) => item.textContent?.trim() ?? '');
}

function pick(root: ParentNode, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll<HTMLButtonElement>('button, [role^="menuitem"]')].find((item) => item.textContent?.trim().startsWith(label) || item.getAttribute('aria-label') === label);
  if (!found) throw new Error(`No ${label}`);
  return found;
}

function dialog(): HTMLDialogElement {
  return document.querySelector<HTMLDialogElement>('dialog.ws-convert')!;
}

const paths = async () => (await registry.stores.get('night-sky')!.list()).map((entry) => entry.path).filter((path) => path.startsWith('Photos/'));

describe('Convert image…, from the file tree', () => {
  it('is offered for images, not for notes or SVG, and for folders that hold images', async () => {
    await open();
    expect(items(await menuFor('Photos/Orion Nebula.jpg'))).toContain('Convert image…');
    expect(items(await menuFor('Guides/Observing plan.md'))).not.toContain('Convert image…');
    expect(items(await menuFor('Photos'))).toContain('Convert images…');
    expect(items(await menuFor('Guides'))).not.toContain('Convert images…');
  });

  it('shows the image, what it is, and what it will become, then saves the WebP next to it', async () => {
    const container = await open();
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()?.textContent).toContain('JPEG · 4,000 × 3,000 px · 612 KB'));
    expect([...dialog().querySelectorAll('[role="radiogroup"][aria-label="Format"] [role="radio"]')].map((radio) => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([
      ['WebP', 'true'],
      ['JPEG', 'false'],
      ['PNG', 'false'],
    ]);
    await waitFor(() => expect(dialog().querySelector('.ws-convert-estimate')?.textContent).toBe('4,000 × 3,000 px · 612 KB → 100 KB, 84% smaller'));
    await act(async () => pick(dialog(), 'Convert').click());
    await waitFor(() => expect(document.querySelector('dialog.ws-convert')).toBeNull());
    expect(await paths()).toEqual(['Photos/Moonrise timelapse.mp4', 'Photos/Orion Nebula.jpg', 'Photos/Orion Nebula.webp', 'Photos/Pleiades.png']);
    await waitFor(() => expect(container.querySelector('.ws-status')?.textContent).toContain('Saved “Orion Nebula.webp” next to “Orion Nebula.jpg”: 612 KB → 100 KB.'));
  });

  it('offers only sizes smaller than the image, and shows the new size', async () => {
    await open();
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()?.textContent).toContain('4,000 × 3,000 px'));
    const sides = dialog().querySelector<HTMLElement>('[role="radiogroup"][aria-label="Longest side"]')!;
    expect([...sides.querySelectorAll('[role="radio"]')].map((radio) => radio.textContent)).toEqual(['As it is', '2,560', '1,920', '1,280', '800']);
    await act(async () => pick(sides, '1,920').click());
    await waitFor(() => expect(dialog().querySelector('.ws-convert-estimate')?.textContent).toContain('1,920 × 1,440 px'));
  });

  it('replaces the original when asked, and its tab follows it to the new name', async () => {
    const container = await open();
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()?.querySelector('.ws-convert-estimate')?.textContent).toContain('100 KB'));
    await act(async () => pick(dialog().querySelector('[aria-label="Then"]')!, 'Replace it').click());
    expect(dialog().textContent).toContain('“Orion Nebula.jpg” goes, and “Orion Nebula.webp” takes its place.');
    await act(async () => pick(dialog(), 'Convert').click());
    await waitFor(() => expect(document.querySelector('dialog.ws-convert')).toBeNull());
    expect(await paths()).toEqual(['Photos/Moonrise timelapse.mp4', 'Photos/Orion Nebula.webp', 'Photos/Pleiades.png']);
    await settle(30);
    const tabs = [...container.querySelectorAll('.ws-tabs [role="tab"]')].map((tab) => tab.textContent);
    expect(tabs.some((tab) => tab?.includes('Orion Nebula.webp'))).toBe(true);
    expect(tabs.some((tab) => tab?.includes('Orion Nebula.jpg'))).toBe(false);
    expect(container.querySelector('.ws-status')?.textContent).toContain('Replaced “Orion Nebula.jpg” with “Orion Nebula.webp”');
  });

  it('remembers the choices on this device for next time', async () => {
    await open();
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => pick(dialog().querySelector('[aria-label="Format"]')!, 'JPEG').click());
    await act(async () => pick(dialog().querySelector('[aria-label="Then"]')!, 'Replace it').click());
    expect(JSON.parse(localStorage.getItem('nebula:convert-images')!)).toMatchObject({ format: 'jpeg', then: 'replace' });
    expect(dialog().textContent).toContain('JPEG has no transparency, so clear parts turn white.');
  });

  it('converts a folder’s images in one go, and says how much smaller they got', async () => {
    const container = await open();
    await act(async () => pick(await menuFor('Photos'), 'Convert images…').click());
    await waitFor(() => expect(dialog()?.textContent).toContain('2 images · 1 MB, in “Photos”'));
    // Photos has no folders inside, so the dialog doesn't say it has.
    expect(dialog().textContent).not.toContain('and the folders in it');
    await act(async () => pick(dialog().querySelector('[aria-label="Then"]')!, 'Replace them').click());
    await act(async () => pick(dialog(), 'Convert 2 images').click());
    await waitFor(() => expect(document.querySelector('dialog.ws-convert')).toBeNull());
    // The video beside them is left alone.
    expect(await paths()).toEqual(['Photos/Moonrise timelapse.mp4', 'Photos/Orion Nebula.webp', 'Photos/Pleiades.webp']);
    await waitFor(() => expect(container.querySelector('.ws-status')?.textContent).toContain('Converted 2 images: 1 MB → 200 KB.'));
  });

  it('in a browser that can’t write WebP, offers JPEG and PNG, and says so', async () => {
    await open({ webp: false });
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()?.textContent).toContain('This browser can’t write WebP. Chrome, Edge and Firefox can.'));
    expect([...dialog().querySelectorAll('[aria-label="Format"] [role="radio"]')].map((radio) => [radio.textContent, radio.getAttribute('aria-checked')])).toEqual([
      ['JPEG', 'true'],
      ['PNG', 'false'],
    ]);
  });

  it('stops after the image in hand when Escape is pressed while converting, rather than vanishing', async () => {
    let release: () => void = () => {};
    const slow = new Promise<void>((resolve) => (release = resolve));
    const container = await open({ slow });
    await act(async () => pick(await menuFor('Photos'), 'Convert images…').click());
    await waitFor(() => expect(dialog()).not.toBeNull());
    await act(async () => pick(dialog(), 'Convert 2 images').click());
    await waitFor(() => expect(dialog().querySelector('.ws-convert-progress')?.textContent).toContain('Converting 1 of 2'));
    await act(async () => dialog().dispatchEvent(new Event('cancel', { cancelable: true })));
    // Still there, saying what it's finishing.
    expect(dialog()).not.toBeNull();
    await act(async () => release());
    await waitFor(() => expect(document.querySelector('dialog.ws-convert')).toBeNull());
    expect(await paths()).toEqual(['Photos/Moonrise timelapse.mp4', 'Photos/Orion Nebula.jpg', 'Photos/Orion Nebula.webp', 'Photos/Pleiades.png']);
    await waitFor(() => expect(container.querySelector('.ws-status')?.textContent).toContain('Converted 1 image: 612 KB → 100 KB.'));
  });

  it('stops, and says why, when the project starts moving to a folder while it’s open (2.1.0)', async () => {
    await open();
    await act(async () => pick(await menuFor('Photos/Orion Nebula.jpg'), 'Convert image…').click());
    await waitFor(() => expect(dialog()?.querySelector('.ws-convert-estimate')?.textContent).toContain('100 KB'));
    const files = registry.stores.get('night-sky') as unknown as { emit(change: unknown): void };
    await act(async () => files.emit({ type: 'moving' }));
    await settle(20);
    expect(dialog().textContent).toContain('The project is moving to a folder. Convert images once it’s moved.');
    expect(pick(dialog(), 'Convert').disabled).toBe(true);
    expect(await paths()).toEqual(['Photos/Moonrise timelapse.mp4', 'Photos/Orion Nebula.jpg', 'Photos/Pleiades.png']);
  });
});

