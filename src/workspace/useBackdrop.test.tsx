import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryFileStore } from '../../e2e/harness/views-store';
import type { FileStore } from '../files/types';
import type { ResolvedTheme } from '../nebula/ui/useTheme';
import { readBackdrop, writeBackdrop } from './backdrop';
import { BackdropImageError, type PreparedBackdrop } from './backdropImage';
import { useBackdrop, type BackdropControls } from './useBackdrop';
import { render, waitFor, type Rendered } from './views/testing/render';

const root = document.documentElement;
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

let controls: BackdropControls | null = null;
let rendered: Rendered | null = null;
let urls = 0;

function Harness(props: { theme: ResolvedTheme; store?: FileStore; prepare?: (file: File) => Promise<PreparedBackdrop> }) {
  controls = useBackdrop(props.theme, props.store, { prepare: props.prepare });
  return null;
}

const prepare = vi.fn(async (file: File): Promise<PreparedBackdrop> => ({ blob: new Blob([file.name], { type: 'image/jpeg' }), ext: 'jpg', thumb: THUMB }));

function image(name: string): File {
  return new File([name], name, { type: 'image/png' });
}

beforeEach(() => {
  localStorage.clear();
  urls = 0;
  root.removeAttribute('data-bg');
  root.removeAttribute('data-bg-ready');
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => `blob:https://nebula.starscape.app/${++urls}`) });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
});

afterEach(async () => {
  await rendered?.unmount();
  rendered = null;
  controls = null;
});

describe('useBackdrop', () => {
  it('keeps an image chosen in the store and shows it, and a second one replaces the first', async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    const first = localStorage.getItem('nebula:bg-dark-image')!;
    expect(first).toMatch(/^night-[a-z0-9]+\.jpg$/);
    expect(await store.stat(first)).not.toBeNull();
    expect(localStorage.getItem('nebula:bg-dark')).toBe('image');
    expect(localStorage.getItem('nebula:bg-dark-thumb')).toBe(THUMB);
    await waitFor(() => expect(root.hasAttribute('data-bg-ready')).toBe(true));
    expect(root.dataset.bg).toBe('image');
    expect(controls!.imageUrl).toMatch(/^blob:/);

    await controls!.chooseImage(image('carina.png'));
    const second = localStorage.getItem('nebula:bg-dark-image')!;
    expect(second).not.toBe(first);
    expect(await store.stat(second)).not.toBeNull();
    await waitFor(async () => expect(await store.stat(first)).toBeNull());
  });

  it('shows the colour for an image that has gone, and forgets it', async () => {
    writeBackdrop('night', { mode: 'image', image: 'night-gone1.jpg', thumb: THUMB }, localStorage);
    rendered = await render(<Harness theme="dark" store={createMemoryFileStore()} prepare={prepare} />);
    await waitFor(() => expect(controls!.status).toBe('missing'));
    expect(root.dataset.bg).toBe('black');
    expect(readBackdrop('night', localStorage)).toMatchObject({ mode: 'image', image: null, thumb: null });
  });

  it('removes the image and stays on Image, over the colour', async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    const name = localStorage.getItem('nebula:bg-dark-image')!;
    await waitFor(() => expect(root.hasAttribute('data-bg-ready')).toBe(true));
    await controls!.removeImage();
    await waitFor(() => expect(root.dataset.bg).toBe('black'));
    expect(await store.stat(name)).toBeNull();
    expect(readBackdrop('night', localStorage)).toMatchObject({ mode: 'image', image: null, thumb: null });
    expect(root.hasAttribute('data-bg-ready')).toBe(false);
  });

  it('keeps an image for each theme', async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    await rendered.rerender(<Harness theme="light" store={store} prepare={prepare} />);
    await waitFor(() => expect(root.dataset.bg).toBe('parchment'));
    expect(controls!.side).toBe('day');
    await controls!.chooseImage(image('meadow.png'));
    expect(localStorage.getItem('nebula:bg-light-image')).toMatch(/^day-[a-z0-9]+\.jpg$/);
    await waitFor(() => expect(root.dataset.bg).toBe('image'));
    await rendered.rerender(<Harness theme="dark" store={store} prepare={prepare} />);
    await waitFor(() => expect(controls!.imageUrl).not.toBeNull());
    expect(controls!.side).toBe('night');
    expect(localStorage.getItem('nebula:bg-dark-image')).toMatch(/^night-/);
  });

  it('says what was wrong with an image, and changes nothing', async () => {
    const refuse = vi.fn(async () => {
      throw new BackdropImageError('That image is over 50 MB.');
    });
    writeBackdrop('night', { mode: 'plain', colour: '#1b1747' }, localStorage);
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={refuse} />);
    await controls!.chooseImage(image('huge.png'));
    await waitFor(() => expect(controls!.problem).toBe('That image is over 50 MB.'));
    expect(readBackdrop('night', localStorage)).toMatchObject({ mode: 'plain', colour: '#1b1747', image: null });
    expect(store.writes).toEqual([]);
  });

  it('offers images only where there is a store to keep them', async () => {
    rendered = await render(<Harness theme="dark" />);
    expect(controls!.canUseImages).toBe(false);
  });

  // The third review, F4: a new image whose choice can't be stored must not
  // cost the image in use.
  it('keeps the image in use when localStorage refuses the new choice, and says so', async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    const first = localStorage.getItem('nebula:bg-dark-image')!;
    await waitFor(() => expect(root.hasAttribute('data-bg-ready')).toBe(true));

    const full = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
    });
    try {
      await controls!.chooseImage(image('carina.png'));
    } finally {
      full.mockRestore();
    }
    const refused = store.writes.at(-1)!.path;
    expect(refused).not.toBe(first);
    expect(localStorage.getItem('nebula:bg-dark-image')).toBe(first);
    expect(await store.stat(first)).not.toBeNull();
    // The new file isn't left behind, 50 MB at a time.
    expect(await store.stat(refused)).toBeNull();
    await waitFor(() => expect(controls!.problem).toBe('Couldn’t keep the choice in this browser.'));
    expect(controls!.value.image).toBe(first);
    expect(root.dataset.bg).toBe('image');
  });

  it("replaces the image another tab chose meanwhile, so neither tab's file is left behind", async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    const first = localStorage.getItem('nebula:bg-dark-image')!;
    // Another tab chooses its own image, and removes ours, as this hook does.
    await store.write('night-othertab1.jpg', new Blob(['other'], { type: 'image/jpeg' }));
    localStorage.setItem('nebula:bg-dark-image', 'night-othertab1.jpg');
    await store.remove(first);

    await controls!.chooseImage(image('carina.png'));
    const mine = localStorage.getItem('nebula:bg-dark-image')!;
    expect(mine).not.toBe('night-othertab1.jpg');
    expect(await store.stat(mine)).not.toBeNull();
    await waitFor(async () => expect(await store.stat('night-othertab1.jpg')).toBeNull());
  });

  it("removes the image this theme now shows, even when another tab chose it", async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    await store.write('night-othertab2.jpg', new Blob(['other'], { type: 'image/jpeg' }));
    localStorage.setItem('nebula:bg-dark-image', 'night-othertab2.jpg');

    await controls!.removeImage();
    expect(localStorage.getItem('nebula:bg-dark-image')).toBeNull();
    expect(await store.stat('night-othertab2.jpg')).toBeNull();
  });

  it("keeps the image when localStorage can't forget the choice, and says so", async () => {
    const store = createMemoryFileStore();
    rendered = await render(<Harness theme="dark" store={store} prepare={prepare} />);
    await controls!.chooseImage(image('pillars.png'));
    const first = localStorage.getItem('nebula:bg-dark-image')!;
    const blocked = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
      throw new DOMException('Storage is blocked.', 'SecurityError');
    });
    try {
      await controls!.removeImage();
    } finally {
      blocked.mockRestore();
    }
    expect(localStorage.getItem('nebula:bg-dark-image')).toBe(first);
    expect(await store.stat(first)).not.toBeNull();
    await waitFor(() => expect(controls!.problem).toBe('Couldn’t change the choice in this browser.'));
  });
});
