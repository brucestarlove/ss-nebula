import { useCallback, useEffect, useState } from 'react';
import type { ResolvedTheme } from './useTheme';

/**
 * Per-theme background "flavor". Each theme remembers its own choice:
 *
 *   light → 'parchment' (rich, the ui-v3 default) ↔ 'white' (plain)
 *   dark  → 'starfield' (rich, the ui-v3 default) ↔ 'black' (plain)
 *
 * Writes a fully-resolved `data-bg` value on <html> ('parchment' | 'white' |
 * 'starfield' | 'black') so the CSS keys off one attribute without re-deriving
 * the theme. Rich values are no-ops in CSS (the package backgrounds own them);
 * plain values swap <body> to a flat fill and hide the starfield. The canvas is
 * transparent, so it simply shows whichever <body> background is active.
 */
export type Flavor = 'rich' | 'plain';

const LIGHT_KEY = 'nebula:bg-light';
const DARK_KEY = 'nebula:bg-dark';

function readFlavor(key: string): Flavor {
  if (typeof window === 'undefined') return 'rich';
  return window.localStorage.getItem(key) === 'plain' ? 'plain' : 'rich';
}

function bgValue(theme: ResolvedTheme, lightFlavor: Flavor, darkFlavor: Flavor): string {
  if (theme === 'dark') return darkFlavor === 'plain' ? 'black' : 'starfield';
  return lightFlavor === 'plain' ? 'white' : 'parchment';
}

function applyBg(value: string): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-bg', value);
}

/**
 * Apply the stored flavor for the given resolved theme before React paints, so
 * a plain-background user doesn't flash the rich default on load. Call once
 * from the app entry point.
 */
export function initBackgroundFromStorage(resolved: ResolvedTheme): void {
  applyBg(bgValue(resolved, readFlavor(LIGHT_KEY), readFlavor(DARK_KEY)));
}

export function useBackground(resolved: ResolvedTheme) {
  const [lightFlavor, setLightFlavor] = useState<Flavor>(() => readFlavor(LIGHT_KEY));
  const [darkFlavor, setDarkFlavor] = useState<Flavor>(() => readFlavor(DARK_KEY));

  useEffect(() => {
    applyBg(bgValue(resolved, lightFlavor, darkFlavor));
  }, [resolved, lightFlavor, darkFlavor]);

  const flavor: Flavor = resolved === 'dark' ? darkFlavor : lightFlavor;

  const setFlavor = useCallback(
    (next: Flavor) => {
      if (resolved === 'dark') {
        setDarkFlavor(next);
        if (typeof window !== 'undefined') window.localStorage.setItem(DARK_KEY, next);
      } else {
        setLightFlavor(next);
        if (typeof window !== 'undefined') window.localStorage.setItem(LIGHT_KEY, next);
      }
    },
    [resolved],
  );

  const toggleFlavor = useCallback(() => {
    setFlavor(flavor === 'plain' ? 'rich' : 'plain');
  }, [flavor, setFlavor]);

  return { flavor, isPlain: flavor === 'plain', setFlavor, toggleFlavor };
}
