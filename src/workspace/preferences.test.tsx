import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_PREFERENCES, type Preferences } from '../files/types';
import {
  applyPreferences,
  initPreferencesFromStorage,
  PREFERENCE_KEYS,
  readPreferences,
  usePreferences,
  writePreference,
} from './preferences';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const root = document.documentElement;

function clearRoot() {
  for (const name of ['data-style', 'data-width', 'data-body', 'data-dock']) root.removeAttribute(name);
}

beforeEach(() => {
  localStorage.clear();
  clearRoot();
});

describe('readPreferences', () => {
  it('returns the defaults when nothing is stored', () => {
    expect(readPreferences(localStorage)).toEqual(DEFAULT_PREFERENCES);
  });

  it('reads every stored preference from its own key', () => {
    localStorage.setItem('nebula:style', 'pane');
    localStorage.setItem('nebula:width', 'stretch');
    localStorage.setItem('nebula:body', 'serif');
    localStorage.setItem('nebula:dock', 'on');
    expect(readPreferences(localStorage)).toEqual({ style: 'pane', width: 'stretch', body: 'serif', dock: true });
  });

  it('falls back to the default for a key holding an unknown value, and keeps the others', () => {
    localStorage.setItem('nebula:style', 'glass');
    localStorage.setItem('nebula:width', 'stretch');
    localStorage.setItem('nebula:dock', 'yes');
    expect(readPreferences(localStorage)).toEqual({ ...DEFAULT_PREFERENCES, width: 'stretch' });
  });

  it('uses the documented keys', () => {
    expect(PREFERENCE_KEYS).toEqual({
      style: 'nebula:style',
      width: 'nebula:width',
      body: 'nebula:body',
      dock: 'nebula:dock',
    });
  });
});

describe('writePreference', () => {
  it('stores strings, with the dock as on or off', () => {
    writePreference('style', 'pane', localStorage);
    writePreference('dock', true, localStorage);
    expect(localStorage.getItem('nebula:style')).toBe('pane');
    expect(localStorage.getItem('nebula:dock')).toBe('on');
    writePreference('dock', false, localStorage);
    expect(localStorage.getItem('nebula:dock')).toBe('off');
  });
});

describe('applyPreferences', () => {
  it('sets data-style, data-width and data-body, and data-dock only while the dock is on', () => {
    const prefs: Preferences = { style: 'pane', width: 'stretch', body: 'serif', dock: true };
    applyPreferences(prefs, root);
    expect(root.dataset.style).toBe('pane');
    expect(root.dataset.width).toBe('stretch');
    expect(root.dataset.body).toBe('serif');
    expect(root.hasAttribute('data-dock')).toBe(true);
    applyPreferences({ ...prefs, dock: false }, root);
    expect(root.hasAttribute('data-dock')).toBe(false);
  });
});

describe('initPreferencesFromStorage', () => {
  it('applies the stored preferences to <html> before first paint', () => {
    localStorage.setItem('nebula:style', 'pane');
    localStorage.setItem('nebula:body', 'serif');
    const prefs = initPreferencesFromStorage();
    expect(prefs.style).toBe('pane');
    expect(root.dataset.style).toBe('pane');
    expect(root.dataset.width).toBe('fixed');
    expect(root.dataset.body).toBe('serif');
    expect(root.hasAttribute('data-dock')).toBe(false);
  });

  it('applies the defaults when storage refuses to be read', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('The operation is insecure.', 'SecurityError');
      },
    });
    try {
      expect(initPreferencesFromStorage()).toEqual(DEFAULT_PREFERENCES);
      expect(root.dataset.style).toBe('sheet');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('usePreferences', () => {
  let container: HTMLDivElement;
  let reactRoot: Root;
  let api: ReturnType<typeof usePreferences>;

  function Probe() {
    api = usePreferences();
    return null;
  }

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    reactRoot = createRoot(container);
  });

  afterEach(() => {
    act(() => reactRoot.unmount());
    container.remove();
  });

  it('changes a preference in state, in storage and on <html>', () => {
    act(() => reactRoot.render(<Probe />));
    expect(api.preferences).toEqual(DEFAULT_PREFERENCES);
    act(() => api.setPreference('width', 'stretch'));
    expect(api.preferences.width).toBe('stretch');
    expect(localStorage.getItem('nebula:width')).toBe('stretch');
    expect(root.dataset.width).toBe('stretch');
    act(() => api.setPreference('dock', true));
    expect(root.hasAttribute('data-dock')).toBe(true);
  });

  it('follows a change made in another tab', () => {
    act(() => reactRoot.render(<Probe />));
    localStorage.setItem('nebula:style', 'pane');
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: 'nebula:style', newValue: 'pane' }));
    });
    expect(api.preferences.style).toBe('pane');
    expect(root.dataset.style).toBe('pane');
  });
});
