import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_PREFERENCES, type Preferences } from '../files/types';

/**
 * Per-device preferences (PLAN §6): Style, Page width, Note text and the
 * dock. They live in localStorage, one key each, and show on <html> as
 * data-style, data-width, data-body and data-dock (present while the dock
 * preference is on), which the workspace CSS reads. Theme, background and
 * motion keep their own keys and hooks in src/nebula/ui.
 */
export const PREFERENCE_KEYS: Record<keyof Preferences, string> = {
  style: 'nebula:style',
  width: 'nebula:width',
  body: 'nebula:body',
  dock: 'nebula:dock',
};

type Stored<K extends keyof Preferences> = { parse(raw: string | null): Preferences[K] | undefined; format(value: Preferences[K]): string };

function oneOf<K extends 'style' | 'width' | 'body'>(values: readonly Preferences[K][]): Stored<K> {
  return {
    parse: (raw) => (values as readonly (string | null)[]).includes(raw) ? (raw as Preferences[K]) : undefined,
    format: (value) => value,
  };
}

const CODECS: { [K in keyof Preferences]: Stored<K> } = {
  style: oneOf<'style'>(['sheet', 'pane']),
  width: oneOf<'width'>(['fixed', 'stretch']),
  body: oneOf<'body'>(['sans', 'serif']),
  dock: {
    parse: (raw) => (raw === 'on' ? true : raw === 'off' ? false : undefined),
    format: (value) => (value ? 'on' : 'off'),
  },
};

const KEYS = Object.keys(PREFERENCE_KEYS) as (keyof Preferences)[];

function defaultStorage(): Storage | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    // Storage can be switched off (or blocked for this site); the defaults stand.
    return undefined;
  }
}

function readOne<K extends keyof Preferences>(key: K, storage: Storage | undefined): Preferences[K] {
  let raw: string | null = null;
  try {
    raw = storage?.getItem(PREFERENCE_KEYS[key]) ?? null;
  } catch {
    raw = null;
  }
  return CODECS[key].parse(raw) ?? DEFAULT_PREFERENCES[key];
}

/** The stored preferences; anything missing or unknown is the default. */
export function readPreferences(storage: Storage | undefined = defaultStorage()): Preferences {
  return {
    style: readOne('style', storage),
    width: readOne('width', storage),
    body: readOne('body', storage),
    dock: readOne('dock', storage),
  };
}

export function writePreference<K extends keyof Preferences>(
  key: K,
  value: Preferences[K],
  storage: Storage | undefined = defaultStorage(),
): void {
  try {
    storage?.setItem(PREFERENCE_KEYS[key], CODECS[key].format(value));
  } catch {
    // A full or blocked storage keeps the preference for this visit only.
  }
}

export function applyPreferences(prefs: Preferences, root: HTMLElement | undefined = globalThis.document?.documentElement): void {
  if (!root) return;
  root.dataset.style = prefs.style;
  root.dataset.width = prefs.width;
  root.dataset.body = prefs.body;
  root.toggleAttribute('data-dock', prefs.dock);
}

/** Applies the stored preferences to <html>. Call it before first paint
 * (main.tsx), next to initThemeFromStorage(), so nothing flashes. */
export function initPreferencesFromStorage(): Preferences {
  const prefs = readPreferences();
  applyPreferences(prefs);
  return prefs;
}

export function usePreferences() {
  const [preferences, setPreferences] = useState<Preferences>(() => readPreferences());

  useEffect(() => {
    applyPreferences(preferences);
  }, [preferences]);

  // Another tab changed one: follow it.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !KEYS.some((key) => PREFERENCE_KEYS[key] === event.key)) return;
      setPreferences(readPreferences());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const setPreference = useCallback(<K extends keyof Preferences>(key: K, value: Preferences[K]) => {
    writePreference(key, value);
    setPreferences((current) => ({ ...current, [key]: value }));
  }, []);

  return { preferences, setPreference };
}
