import { beforeEach, describe, expect, it } from 'vitest';
import { applyBackdrop, DAY_COLOURS, DEFAULT_FADE, initBackdropFromStorage, NIGHT_COLOURS, readBackdrop, writeBackdrop, type Backdrop } from './backdrop';

const root = document.documentElement;
const THUMB = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';

function clean() {
  root.removeAttribute('data-bg');
  root.removeAttribute('data-bg-ready');
  for (const name of ['--nebula-bg-color', '--nebula-bg-fade', '--nebula-bg-thumb', '--nebula-bg-image']) root.style.removeProperty(name);
}

beforeEach(() => {
  localStorage.clear();
  clean();
});

function backdrop(patch: Partial<Backdrop> = {}): Backdrop {
  return { mode: 'rich', colour: '#000000', fade: DEFAULT_FADE, image: null, thumb: null, ...patch };
}

/** WCAG relative luminance of a #rrggbb colour. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((at) => {
    const channel = parseInt(hex.slice(at, at + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('readBackdrop', () => {
  it('starts on the starfield at night and the parchment by day, over black and white', () => {
    expect(readBackdrop('night', localStorage)).toEqual({ mode: 'rich', colour: '#000000', fade: 0.3, image: null, thumb: null });
    expect(readBackdrop('day', localStorage)).toEqual({ mode: 'rich', colour: '#ffffff', fade: 0.3, image: null, thumb: null });
  });

  it("reads Nebula 1.x's plain background as Colour: black at night, white by day", () => {
    localStorage.setItem('nebula:bg-dark', 'plain');
    localStorage.setItem('nebula:bg-light', 'plain');
    expect(readBackdrop('night', localStorage)).toMatchObject({ mode: 'plain', colour: '#000000' });
    expect(readBackdrop('day', localStorage)).toMatchObject({ mode: 'plain', colour: '#ffffff' });
  });

  it('takes nothing it did not write: no colour, preview or file name of any other shape', () => {
    localStorage.setItem('nebula:bg-dark', 'image');
    localStorage.setItem('nebula:bg-dark-color', 'red; background: url(https://tracker.example/p.png)');
    localStorage.setItem('nebula:bg-dark-thumb', `${THUMB}"); background: url("https://tracker.example/p.png`);
    localStorage.setItem('nebula:bg-dark-image', '../registry.json');
    expect(readBackdrop('night', localStorage)).toEqual({ mode: 'image', colour: '#000000', fade: 0.3, image: null, thumb: null });
  });

  it('keeps the fade between none and 80 %', () => {
    localStorage.setItem('nebula:bg-dark-fade', '7');
    localStorage.setItem('nebula:bg-light-fade', 'lots');
    expect(readBackdrop('night', localStorage).fade).toBe(0.8);
    expect(readBackdrop('day', localStorage).fade).toBe(0.3);
  });
});

describe('writeBackdrop', () => {
  it("keeps each theme's choice under its own keys, and 1.x's value where 1.x reads it", () => {
    writeBackdrop('night', { mode: 'plain', colour: '#1b1747' }, localStorage);
    writeBackdrop('day', { mode: 'image', image: 'day-k3x9.jpg', thumb: THUMB, fade: 0.5 }, localStorage);
    expect(localStorage.getItem('nebula:bg-dark')).toBe('plain');
    expect(localStorage.getItem('nebula:bg-dark-color')).toBe('#1b1747');
    expect(readBackdrop('night', localStorage)).toMatchObject({ mode: 'plain', colour: '#1b1747' });
    expect(readBackdrop('day', localStorage)).toEqual({ mode: 'image', colour: '#ffffff', fade: 0.5, image: 'day-k3x9.jpg', thumb: THUMB });
  });

  it('forgets the image and its preview when they are taken away, and stays on Image', () => {
    writeBackdrop('night', { mode: 'image', image: 'night-a1.png', thumb: THUMB }, localStorage);
    writeBackdrop('night', { image: null, thumb: null }, localStorage);
    expect(localStorage.getItem('nebula:bg-dark-image')).toBeNull();
    expect(localStorage.getItem('nebula:bg-dark-thumb')).toBeNull();
    expect(readBackdrop('night', localStorage).mode).toBe('image');
  });

  it("keeps the choice when the preview doesn't fit in localStorage", () => {
    const data = new Map<string, string>();
    const full = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => {
        if (key.endsWith('-thumb')) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError');
        data.set(key, value);
      },
      removeItem: (key: string) => void data.delete(key),
    } as unknown as Storage;
    const written = writeBackdrop('night', { mode: 'image', image: 'night-a1.png', thumb: THUMB }, full);
    expect(full.getItem('nebula:bg-dark')).toBe('image');
    expect(full.getItem('nebula:bg-dark-image')).toBe('night-a1.png');
    // Not kept, so the next load paints the colour until the image arrives.
    expect(written.thumb).toBeNull();
  });
});

describe('applyBackdrop', () => {
  it('shows the starfield and the parchment as before', () => {
    applyBackdrop('night', backdrop(), null, root);
    expect(root.dataset.bg).toBe('starfield');
    applyBackdrop('day', backdrop({ colour: '#ffffff' }), null, root);
    expect(root.dataset.bg).toBe('parchment');
  });

  it("shows a colour through 1.x's plain values, in the colour chosen", () => {
    applyBackdrop('night', backdrop({ mode: 'plain', colour: '#1b1747' }), null, root);
    expect(root.dataset.bg).toBe('black');
    expect(root.style.getPropertyValue('--nebula-bg-color')).toBe('#1b1747');
    applyBackdrop('day', backdrop({ mode: 'plain', colour: '#f7eaea' }), null, root);
    expect(root.dataset.bg).toBe('white');
    expect(root.style.getPropertyValue('--nebula-bg-color')).toBe('#f7eaea');
  });

  it('shows an image: its preview first, then the image once it has loaded', () => {
    const chosen = backdrop({ mode: 'image', image: 'night-a1.jpg', thumb: THUMB, fade: 0.4 });
    applyBackdrop('night', chosen, null, root);
    expect(root.dataset.bg).toBe('image');
    expect(root.style.getPropertyValue('--nebula-bg-thumb')).toBe(`url("${THUMB}")`);
    expect(root.style.getPropertyValue('--nebula-bg-fade')).toBe('0.4');
    expect(root.hasAttribute('data-bg-ready')).toBe(false);
    applyBackdrop('night', chosen, 'blob:https://nebula.starscape.app/5c1e', root);
    expect(root.style.getPropertyValue('--nebula-bg-image')).toBe('url("blob:https://nebula.starscape.app/5c1e")');
    expect(root.hasAttribute('data-bg-ready')).toBe(true);
  });

  it('shows the colour while Image has no image yet', () => {
    applyBackdrop('night', backdrop({ mode: 'image', colour: '#0e2a27' }), null, root);
    expect(root.dataset.bg).toBe('black');
    expect(root.style.getPropertyValue('--nebula-bg-color')).toBe('#0e2a27');
  });

  it('leaves nothing of an image behind on the way back to the starfield', () => {
    applyBackdrop('night', backdrop({ mode: 'image', image: 'night-a1.jpg', thumb: THUMB }), 'blob:https://nebula.starscape.app/5c1e', root);
    applyBackdrop('night', backdrop(), null, root);
    expect(root.dataset.bg).toBe('starfield');
    expect(root.style.getPropertyValue('--nebula-bg-image')).toBe('');
    expect(root.style.getPropertyValue('--nebula-bg-thumb')).toBe('');
    expect(root.hasAttribute('data-bg-ready')).toBe(false);
  });
});

describe('initBackdropFromStorage', () => {
  it('paints the stored choice before first paint, with the preview of an image', () => {
    writeBackdrop('night', { mode: 'image', image: 'night-a1.jpg', thumb: THUMB }, localStorage);
    initBackdropFromStorage('dark', localStorage, root);
    expect(root.dataset.bg).toBe('image');
    expect(root.style.getPropertyValue('--nebula-bg-thumb')).toBe(`url("${THUMB}")`);
  });

  it("paints Nebula 1.x's plain black as it did", () => {
    localStorage.setItem('nebula:bg-dark', 'plain');
    initBackdropFromStorage('dark', localStorage, root);
    expect(root.dataset.bg).toBe('black');
  });
});

describe('the colours on offer', () => {
  it('six for each theme, black and white first, each one different', () => {
    expect(NIGHT_COLOURS).toHaveLength(6);
    expect(DAY_COLOURS).toHaveLength(6);
    expect(NIGHT_COLOURS[0]).toEqual({ name: 'Black', value: '#000000' });
    expect(DAY_COLOURS[0]).toEqual({ name: 'White', value: '#ffffff' });
    for (const list of [NIGHT_COLOURS, DAY_COLOURS]) {
      expect(new Set(list.map((colour) => colour.value)).size).toBe(6);
      for (const colour of list) expect(colour.value).toMatch(/^#[0-9a-f]{6}$/);
    }
  });

  it("are dark enough at night and light enough by day for the theme's own text", () => {
    expect([...NIGHT_COLOURS, ...DAY_COLOURS]).toHaveLength(12);
    for (const colour of NIGHT_COLOURS) expect(luminance(colour.value), colour.name).toBeLessThan(0.05);
    for (const colour of DAY_COLOURS) expect(luminance(colour.value), colour.name).toBeGreaterThan(0.75);
  });
});
