import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';

/* ------------------------------------------------------------------ *
 * Escape closes the topmost surface only (menus over sheets over the
 * page). It listens first (window, capture), because ss-ui's own Escape
 * handlers close their surface on the same key and React then unmounts it
 * before a later listener runs, which would close the next one down too.
 * Native modal dialogs handle their own Escape (`cancel`), and fields
 * marked data-escape-own (inline rename) keep theirs.
 * ------------------------------------------------------------------ */

type Layer = { close: () => void };
const layers: Layer[] = [];
let listening = false;

function onEscapeKey(event: KeyboardEvent) {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest('dialog[open], [data-escape-own]')) return;
  const top = layers[layers.length - 1];
  if (!top) return;
  event.preventDefault();
  top.close();
}

export function useEscapeLayer(open: boolean, close: () => void) {
  const closeRef = useRef(close);
  useLayoutEffect(() => {
    closeRef.current = close;
  });
  useEffect(() => {
    if (!open) return;
    const layer: Layer = { close: () => closeRef.current() };
    layers.push(layer);
    if (!listening) {
      window.addEventListener('keydown', onEscapeKey, true);
      listening = true;
    }
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
    };
  }, [open]);
}

/** Closes a surface when a press lands outside it (and outside `keep`,
 * usually the button that opened it, which toggles it itself). Presses in a
 * right-click menu opened from it don't count. */
export function useOutsidePress(
  ref: RefObject<HTMLElement | null>,
  open: boolean,
  close: () => void,
  keep: RefObject<HTMLElement | null>[] = [],
) {
  const closeRef = useRef(close);
  const keepRef = useRef(keep);
  useLayoutEffect(() => {
    closeRef.current = close;
    keepRef.current = keep;
  });
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (keepRef.current.some((other) => other.current?.contains(target))) return;
      if (target instanceof Element && target.closest('.context-menu')) return;
      closeRef.current();
    };
    // A tick later, so the press that opened the surface doesn't close it.
    const timer = window.setTimeout(() => document.addEventListener('pointerdown', onPointerDown, true), 0);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [open, ref]);
}

/** Remembers what had focus when a surface opened, and hands focus back
 * when it closes, unless the user has since put focus somewhere else. */
export function useReturnFocus(open: boolean, surface: RefObject<HTMLElement | null>) {
  const returnTo = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!open) return;
    const before = document.activeElement;
    returnTo.current = before instanceof HTMLElement ? before : null;
    const node = surface.current;
    return () => {
      const active = document.activeElement;
      const lost = !active || active === document.body || (node !== null && node.contains(active)) || !active.isConnected;
      const target = returnTo.current;
      if (lost && target?.isConnected) target.focus({ preventScroll: true });
    };
  }, [open, surface]);
}

/* ------------------------------------------------------------------ *
 * Keyboard
 * ------------------------------------------------------------------ */

const MENU_ITEMS = '[role="menuitem"], [role="menuitemradio"], [role="menuitemcheckbox"]';

/** Up and Down (and Home and End) move through a menu's items, wrapping. */
export function handleMenuKeys(event: ReactKeyboardEvent<HTMLElement>, menu: HTMLElement | null) {
  if (!menu) return;
  const keys = ['ArrowDown', 'ArrowUp', 'Home', 'End'];
  if (!keys.includes(event.key)) return;
  const items = [...menu.querySelectorAll<HTMLElement>(MENU_ITEMS)].filter(
    (item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true' && item.offsetParent !== null,
  );
  if (items.length === 0) return;
  event.preventDefault();
  const index = items.indexOf(document.activeElement as HTMLElement);
  let next = 0;
  if (event.key === 'ArrowDown') next = index === -1 ? 0 : (index + 1) % items.length;
  else if (event.key === 'ArrowUp') next = index === -1 ? items.length - 1 : (index - 1 + items.length) % items.length;
  else if (event.key === 'End') next = items.length - 1;
  items[next].focus();
}

export function focusFirstMenuItem(menu: HTMLElement | null, prefer?: string) {
  if (!menu) return;
  const preferred = prefer ? menu.querySelector<HTMLElement>(prefer) : null;
  (preferred ?? menu.querySelector<HTMLElement>(MENU_ITEMS))?.focus();
}

/** Arrow keys for a radio group: move the choice and the focus together. */
export function handleRadioKeys<T>(
  event: ReactKeyboardEvent<HTMLElement>,
  values: readonly T[],
  current: T,
  choose: (value: T) => void,
) {
  const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown';
  const back = event.key === 'ArrowLeft' || event.key === 'ArrowUp';
  if (!forward && !back) return;
  event.preventDefault();
  const index = Math.max(0, values.indexOf(current));
  const nextIndex = (index + (forward ? 1 : -1) + values.length) % values.length;
  // The radios are in the order of `values`; focus the next one at once.
  event.currentTarget.querySelectorAll<HTMLElement>('[role="radio"]')[nextIndex]?.focus();
  choose(values[nextIndex]);
}

export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia?.(query).matches === true);
  useEffect(() => {
    const list = window.matchMedia?.(query);
    if (!list) return;
    const update = () => setMatches(list.matches);
    update();
    list.addEventListener('change', update);
    return () => list.removeEventListener('change', update);
  }, [query]);
  return matches;
}
