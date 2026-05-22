import { useCallback, useEffect, useState } from 'react';

/**
 * Motion preference for the Starscape background, mirroring `useTheme`. Writes
 * `data-motion` on <html> — the value the starscape-ui-system-v3 engine and CSS
 * both read:
 *
 *   data-motion="full"   → full animation (starfield, meteors, drifts)
 *   data-motion="reduce" → ambient animation off
 *
 * Unlike the package's three-state default (absent = follow OS), Nebula pins an
 * explicit value because the animated starfield is disorienting on a drawing
 * surface, so motion defaults to OFF here regardless of the OS preference. The
 * starscape engine auto-syncs to attribute changes via a MutationObserver, so
 * nothing else needs to be notified.
 */
export type MotionMode = 'full' | 'reduce';

const STORAGE_KEY = 'nebula:motion';
const DEFAULT_MODE: MotionMode = 'reduce';

function readStoredMode(): MotionMode {
  if (typeof window === 'undefined') return DEFAULT_MODE;
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored === 'full' || stored === 'reduce' ? stored : DEFAULT_MODE;
}

function applyMode(mode: MotionMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-motion', mode);
}

/**
 * Synchronously apply the stored motion preference before React paints, so the
 * background starts calm by default instead of flashing the full starfield.
 * Call once from the app entry point.
 */
export function initMotionFromStorage(): void {
  applyMode(readStoredMode());
}

export function useMotion() {
  const [mode, setModeState] = useState<MotionMode>(readStoredMode);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  const setEnabled = useCallback((enabled: boolean) => {
    const next: MotionMode = enabled ? 'full' : 'reduce';
    setModeState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  return { enabled: mode === 'full', setEnabled };
}
