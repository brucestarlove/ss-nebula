import { useCallback, useEffect, useState } from 'react';

/**
 * Local reimplementation of the starscape-ui-system-v3 `useTheme` contract.
 * We don't install the React package (its workspace/catalog protocol deps
 * don't resolve standalone), so Nebula owns this small hook. It writes `data-theme`
 * on <html> (omitting it for `system` so the package's prefers-color-scheme
 * tokens apply) and persists the chosen mode.
 */
export type ThemeMode = 'light' | 'dark' | 'system';
export type ResolvedTheme = 'light' | 'dark';

const STORAGE_KEY = 'nebula:theme';
const MODES: ThemeMode[] = ['light', 'dark', 'system'];
const DARK_QUERY = '(prefers-color-scheme: dark)';

function readStoredMode(): ThemeMode {
  if (typeof window === 'undefined') return 'system';
  const stored = window.localStorage.getItem(STORAGE_KEY);
  return stored && MODES.includes(stored as ThemeMode) ? (stored as ThemeMode) : 'system';
}

function systemPrefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia(DARK_QUERY).matches;
}

function applyMode(mode: ThemeMode): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  if (mode === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', mode);
}

/**
 * Synchronously apply the stored theme before React paints. Call once from the
 * app entry point to avoid a light-mode flash on load.
 */
export function initThemeFromStorage(): void {
  applyMode(readStoredMode());
}

/** Resolve the stored mode to a concrete light/dark theme (system → OS). */
export function resolveStoredTheme(): ResolvedTheme {
  const mode = readStoredMode();
  if (mode === 'system') return systemPrefersDark() ? 'dark' : 'light';
  return mode;
}

export function useTheme() {
  const [mode, setModeState] = useState<ThemeMode>(readStoredMode);
  const [systemDark, setSystemDark] = useState<boolean>(systemPrefersDark);

  useEffect(() => {
    applyMode(mode);
  }, [mode]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia(DARK_QUERY);
    const onChange = (event: MediaQueryListEvent) => setSystemDark(event.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    if (typeof window !== 'undefined') window.localStorage.setItem(STORAGE_KEY, next);
  }, []);

  const resolved: ResolvedTheme = mode === 'system' ? (systemDark ? 'dark' : 'light') : mode;

  return { mode, resolved, setMode };
}
