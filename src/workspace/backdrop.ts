import type { ResolvedTheme } from '../nebula/ui/useTheme';

/**
 * The window's background, for each theme, on this device: the theme's own
 * sky (Starfield at night, Parchment by day), a colour, or an image the user
 * uploads. The choice lives in localStorage with the other preferences; an
 * image itself lives in the browser tier's `appearance/` folder (useBackdrop).
 *
 * Nebula 1.x's keys and values carry on: `nebula:bg-dark` and
 * `nebula:bg-light` hold 'rich' or 'plain' as before, and now 'image', which
 * 1.x reads as 'rich'. On <html>, `data-bg` is what the CSS keys off
 * ('starfield' | 'parchment' | 'black' | 'white' | 'image'; a colour keeps
 * 1.x's 'black' and 'white'), with the colour, the fade and the image as
 * custom properties, and `data-bg-ready` once the full image has loaded.
 */
export type BackdropMode = 'rich' | 'plain' | 'image';
export type Side = 'night' | 'day';
export type Backdrop = {
  mode: BackdropMode;
  /** '#rrggbb': the background under Colour, and what shows beneath an image. */
  colour: string;
  /** 0 to MAX_FADE: how much of the theme's own colour lies over an image. */
  fade: number;
  /** The image's file in the device store ('night-….jpg'), or null. */
  image: string | null;
  /** A tiny preview of the image (a data: URL), painted before it loads. */
  thumb: string | null;
};
export type NamedColour = { name: string; value: string };

export const DEFAULT_FADE = 0.3;
export const MAX_FADE = 0.8;
const MAX_THUMB_CHARS = 16_384;

/** Six colours dark enough for the night theme's light text. */
export const NIGHT_COLOURS: readonly NamedColour[] = [
  { name: 'Black', value: '#000000' },
  { name: 'Midnight', value: '#0b1024' },
  { name: 'Indigo', value: '#1b1747' },
  { name: 'Plum', value: '#2a1235' },
  { name: 'Pine', value: '#0e2a27' },
  { name: 'Graphite', value: '#1c1f26' },
];

/** Six colours light enough for the day theme's dark text. */
export const DAY_COLOURS: readonly NamedColour[] = [
  { name: 'White', value: '#ffffff' },
  { name: 'Paper', value: '#f6f1e7' },
  { name: 'Mist', value: '#eef2f7' },
  { name: 'Sage', value: '#e7efe6' },
  { name: 'Blush', value: '#f7eaea' },
  { name: 'Sand', value: '#f1e7d3' },
];

const BASE_KEY: Record<Side, string> = { night: 'nebula:bg-dark', day: 'nebula:bg-light' };
const DEFAULT_COLOUR: Record<Side, string> = { night: '#000000', day: '#ffffff' };

// Only what this module writes is read back: these values reach CSS.
const COLOUR = /^#[0-9a-f]{6}$/;
const IMAGE_NAME = /^(night|day)-[a-z0-9]{1,32}\.(jpg|png|webp|avif|gif|svg)$/;
const THUMB = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+={0,2}$/;
const BLOB_URL = /^blob:[^"\\\s]+$/;

function keysFor(side: Side) {
  const base = BASE_KEY[side];
  return { mode: base, colour: `${base}-color`, fade: `${base}-fade`, image: `${base}-image`, thumb: `${base}-thumb` };
}

function localStorageOrNone(storage?: Storage): Storage | undefined {
  if (storage) return storage;
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Storage can be switched off for this site; the defaults stand.
    return undefined;
  }
}

function get(storage: Storage | undefined, key: string): string | null {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function clampFade(fade: number): number {
  return Math.min(MAX_FADE, Math.max(0, Math.round(fade * 100) / 100));
}

export function sideOf(theme: ResolvedTheme): Side {
  return theme === 'dark' ? 'night' : 'day';
}

/** The stored background for one theme; anything missing or unknown is the default. */
export function readBackdrop(side: Side, storage?: Storage): Backdrop {
  const store = localStorageOrNone(storage);
  const keys = keysFor(side);
  const mode = get(store, keys.mode);
  const colour = get(store, keys.colour)?.toLowerCase() ?? '';
  const fade = Number.parseFloat(get(store, keys.fade) ?? '');
  const image = get(store, keys.image);
  const thumb = get(store, keys.thumb);
  return {
    mode: mode === 'plain' || mode === 'image' ? mode : 'rich',
    colour: COLOUR.test(colour) ? colour : DEFAULT_COLOUR[side],
    fade: Number.isFinite(fade) ? clampFade(fade) : DEFAULT_FADE,
    image: image !== null && IMAGE_NAME.test(image) && image.startsWith(`${side}-`) ? image : null,
    thumb: thumb !== null && thumb.length <= MAX_THUMB_CHARS && THUMB.test(thumb) ? thumb : null,
  };
}

/** Stores what `patch` changes (null removes the image or its preview) and
 * returns the background as now stored. A preview that doesn't fit in
 * localStorage is left out; the rest is kept. */
export function writeBackdrop(side: Side, patch: Partial<Backdrop>, storage?: Storage): Backdrop {
  const store = localStorageOrNone(storage);
  const keys = keysFor(side);
  const set = (key: string, value: string | null): boolean => {
    try {
      if (value === null) store?.removeItem(key);
      else store?.setItem(key, value);
      return true;
    } catch {
      return false;
    }
  };
  if (patch.mode !== undefined) set(keys.mode, patch.mode);
  if (patch.colour !== undefined && COLOUR.test(patch.colour.toLowerCase())) set(keys.colour, patch.colour.toLowerCase());
  if (patch.fade !== undefined && Number.isFinite(patch.fade)) set(keys.fade, String(clampFade(patch.fade)));
  if (patch.image !== undefined) set(keys.image, patch.image);
  if (patch.thumb !== undefined && !set(keys.thumb, patch.thumb)) set(keys.thumb, null);
  return readBackdrop(side, store);
}

function dataBg(side: Side, backdrop: Backdrop): string {
  if (backdrop.mode === 'image' && backdrop.image) return 'image';
  if (backdrop.mode === 'rich') return side === 'night' ? 'starfield' : 'parchment';
  // A colour, or Image with no image yet: 1.x's plain values, in the colour.
  return side === 'night' ? 'black' : 'white';
}

/** Shows `backdrop` on <html>: the image's preview until `imageUrl` (the
 * full image, loaded) is given. */
export function applyBackdrop(
  side: Side,
  backdrop: Backdrop,
  imageUrl: string | null,
  root: HTMLElement | undefined = typeof document === 'undefined' ? undefined : document.documentElement,
): void {
  if (!root) return;
  const bg = dataBg(side, backdrop);
  const style = root.style;
  root.setAttribute('data-bg', bg);
  style.setProperty('--nebula-bg-color', backdrop.colour);
  style.setProperty('--nebula-bg-fade', String(backdrop.fade));
  const image = bg === 'image';
  if (image && backdrop.thumb) style.setProperty('--nebula-bg-thumb', `url("${backdrop.thumb}")`);
  else style.removeProperty('--nebula-bg-thumb');
  if (image && imageUrl && BLOB_URL.test(imageUrl)) {
    style.setProperty('--nebula-bg-image', `url("${imageUrl}")`);
    root.setAttribute('data-bg-ready', '');
  } else {
    style.removeProperty('--nebula-bg-image');
    root.removeAttribute('data-bg-ready');
  }
}

/** Paints the stored background before React does, so nothing flashes: an
 * image shows its preview at once. Call once from the app's entry point. */
export function initBackdropFromStorage(theme: ResolvedTheme, storage?: Storage, root?: HTMLElement): void {
  const side = sideOf(theme);
  applyBackdrop(side, readBackdrop(side, storage), null, root);
}
